import type { WorkspaceDocumentV2 } from '../../assets/contracts'
import { normalizeWorkspaceDocument } from '../../assets/validation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { IDEWorkspacePersistence, IDEWorkspaceDocumentPersistence, WorkspaceFiles } from '../contracts/host'
import type { WebIDEInstanceController } from '../core/instance-handle'
import { WorkspacePersistenceCoordinator } from '../core/workspace-persistence'
import { bindWorkspaceBreakpoints } from '../core/workspace-breakpoints'
import {
  mergeWorkspaceFiles,
  projectPersistedWorkspaceFiles,
  workspaceFilesFingerprint,
} from '../core/workspace-resources'
import { useIDEWorkspaceResources } from './contribution-context'
import { useWebIDEHost } from './host-context'
import { useWorkbenchInstance } from './workbench-instance-context'

type WorkspacePayload = WorkspaceFiles | WorkspaceDocumentV2

interface PersistenceBinding {
  token: object
  workspaceId: string
  persistence: IDEWorkspacePersistence | IDEWorkspaceDocumentPersistence
  coordinator: WorkspacePersistenceCoordinator<WorkspacePayload>
  reportedPending: boolean
  pendingDisposal?: { cancelled: boolean }
}

/** Owns workspace bootstrap and host persistence independently of runtimes. */
export function WorkspaceHostBridge({
  instanceController,
}: {
  instanceController: WebIDEInstanceController
}) {
  const host = useWebIDEHost()
  const instance = useWorkbenchInstance()
  const resources = useIDEWorkspaceResources()
  const workspace = host?.workspace
  const workspaceId = workspace?.id
  const localCache = workspace?.localCache
  const persistence = workspace?.documentPersistence ?? workspace?.persistence
  const documentMode = workspace?.initialDocument !== undefined
  if (!documentMode && workspace?.documentPersistence) throw new TypeError('documentPersistence requires initialDocument')
  if (documentMode && (workspace?.initialFiles || workspace?.persistence || localCache !== 'memory')) throw new TypeError('V2 workspaces require memory cache and documentPersistence')
  const initialFiles = mergeWorkspaceFiles(resources, workspace?.initialFiles)
  const initialDocument = workspace?.initialDocument ? normalizeWorkspaceDocument({ ...workspace.initialDocument, files: Object.entries(mergeWorkspaceFiles(resources, Object.fromEntries(workspace.initialDocument.files.map((file) => [file.path, file.content]))) ?? {}).map(([path, content]) => ({ path, content })) }) : undefined
  const seedFingerprint = initialDocument ? JSON.stringify(initialDocument) : workspaceFilesFingerprint(initialFiles)
  const breakpointSeedFingerprint = workspace?.initialBreakpoints === undefined ? '' : JSON.stringify(
    Object.entries(workspace.initialBreakpoints)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, lines]) => [path, [...lines].sort((a, b) => a - b)]),
  )
  const initializationKey = JSON.stringify([
    workspaceId ?? 'default-project',
    localCache ?? null,
    seedFingerprint,
    breakpointSeedFingerprint,
  ])
  const initializationToken = useMemo(() => ({ key: initializationKey }), [initializationKey])
  const [readyInitializationToken, setReadyInitializationToken] = useState<object>()

  useLayoutEffect(() => {
    let cancelled = false
    let unbindBreakpoints: (() => void) | undefined
    void instance.workspace.initialize({
      projectId: workspaceId ?? 'default-project',
      ...(initialDocument ? { initialDocument, assets: workspace?.assets } : { initialFiles }),
      ephemeral: localCache === 'memory',
    }).then(
      (result) => {
        if (cancelled || !result) return
        if (workspace) unbindBreakpoints = bindWorkspaceBreakpoints(instance, workspace, result.seeded)
        setReadyInitializationToken(initializationToken)
      },
      (error: unknown) => {
        if (cancelled) return
        instance.workspace.setPersistenceError(error)
        console.warn('[web-ide] workspace initialization failed', error)
      },
    )
    // The fingerprint makes semantically identical inline file objects stable;
    // the controller itself guards overlapping async hydrations by generation
    // and shares an in-flight initialization across StrictMode replay.
    return () => {
      cancelled = true
      unbindBreakpoints?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializationKey, initializationToken, instance, localCache, seedFingerprint, workspaceId, workspace?.assets])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (instance.workspace.getPersistenceStatus().state === 'saved') return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [instance])

  const pendingInstanceDisposal = useRef<{ cancelled: boolean } | undefined>(undefined)
  useEffect(() => {
    if (pendingInstanceDisposal.current) {
      pendingInstanceDisposal.current.cancelled = true
      pendingInstanceDisposal.current = undefined
    }
    return () => {
      const ticket = { cancelled: false }
      pendingInstanceDisposal.current = ticket
      queueMicrotask(() => {
        if (ticket.cancelled) return
        void instance.workspace.flushLocalPersistence().finally(() => {
          instance.testingV2.dispose()
          instance.workspace.dispose()
        })
      })
    }
  }, [instance])

  if (
    readyInitializationToken !== initializationToken
    || !workspaceId
    || !persistence
  ) return null

  return (
    <WorkspacePersistenceBinding
      instanceController={instanceController}
      persistence={persistence}
      documentMode={documentMode}
      workspaceId={workspaceId}
    />
  )
}

/** Attaches a host adapter only after its exact workspace has initialized. */
function WorkspacePersistenceBinding({
  instanceController,
  persistence,
  documentMode,
  workspaceId,
}: {
  instanceController: WebIDEInstanceController
  persistence: IDEWorkspacePersistence | IDEWorkspaceDocumentPersistence
  workspaceId: string
  documentMode: boolean
}) {
  const instance = useWorkbenchInstance()
  const persistenceBinding = useRef<PersistenceBinding | undefined>(undefined)

  useLayoutEffect(() => {
    let binding = persistenceBinding.current
    let requiresSeed = false
    if (
      binding?.workspaceId === workspaceId &&
      binding.persistence === persistence
    ) {
      if (binding.pendingDisposal) {
        binding.pendingDisposal.cancelled = true
        binding.pendingDisposal = undefined
      }
    } else {
      if (binding?.reportedPending) {
        binding.reportedPending = false
        instance.workspace.markExternalSaving(false)
      }
      const token = {}
      const coordinator = new WorkspacePersistenceCoordinator<WorkspacePayload>({
        workspaceId,
        persistence: {
          save: (payload, context) => documentMode ? (persistence as IDEWorkspaceDocumentPersistence).save(payload as WorkspaceDocumentV2, context) : (persistence as IDEWorkspacePersistence).save(payload as WorkspaceFiles, context),
          flush: () => persistence.flush?.(),
          dispose: () => persistence.dispose?.(),
        },
        // Preserve Nova's existing host-save cadence while making the policy
        // explicit and independently testable.
        debounceMs: 2000,
        onPendingChange: (pending) => {
          const activeBinding = persistenceBinding.current
          if (activeBinding?.token === token && activeBinding.reportedPending !== pending) {
            activeBinding.reportedPending = pending
            instance.workspace.markExternalSaving(pending)
          }
        },
        onStatusChange: (status, error) => {
          if (persistenceBinding.current?.token !== token) return
          if (status === 'retrying') {
            const message = error instanceof Error ? error.message : undefined
            instance.workspace.setPersistenceRetry(message)
          } else {
            instance.workspace.clearPersistenceIssue()
          }
        },
      })
      const nextBinding: PersistenceBinding = {
        token,
        workspaceId,
        persistence,
        coordinator,
        reportedPending: false,
      }
      binding = nextBinding
      persistenceBinding.current = binding
      requiresSeed = true
    }

    const currentBinding = binding
    const snapshot = (): WorkspacePayload => documentMode ? instance.workspace.persistedDocument() : projectPersistedWorkspaceFiles(instance.workspace.snapshot())
    const detachLifecycle = instanceController.attachWorkspaceLifecycle({
      flush: () => currentBinding.coordinator.flush(snapshot()),
      close: () => currentBinding.coordinator.close(snapshot()),
    })
    const unsubscribe = instance.workspace.subscribe(() =>
      currentBinding.coordinator.scheduleSave(
        snapshot(),
      ),
    )
    // Attach both public lifecycle and the change feed before scheduleSave can
    // synchronously publish `saving`. A status observer may apply an external
    // transaction reentrantly; that newer snapshot must supersede this seed.
    if (requiresSeed) {
      currentBinding.coordinator.scheduleSave(
        snapshot(),
      )
    }

    return () => {
      unsubscribe()
      detachLifecycle()
      const ticket = { cancelled: false }
      currentBinding.pendingDisposal = ticket
      queueMicrotask(() => {
        if (ticket.cancelled) return
        void currentBinding.coordinator.dispose().catch((error: unknown) => {
          console.warn('[web-ide] workspace persistence cleanup failed', error)
        })
        if (persistenceBinding.current === currentBinding) {
          persistenceBinding.current = undefined
        }
      })
    }
  }, [instance, instanceController, persistence, workspaceId, documentMode])

  return null
}

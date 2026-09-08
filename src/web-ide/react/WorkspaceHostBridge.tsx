import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { IDEWorkspacePersistence } from '../contracts/host'
import type { WebIDEInstanceController } from '../core/instance-handle'
import { WorkspacePersistenceCoordinator } from '../core/workspace-persistence'
import {
  mergeWorkspaceFiles,
  projectPersistedWorkspaceFiles,
  workspaceFilesFingerprint,
} from '../core/workspace-resources'
import { useIDEWorkspaceResources } from './contribution-context'
import { useWebIDEHost } from './host-context'
import { useWorkbenchInstance } from './workbench-instance-context'

interface PersistenceBinding {
  token: object
  workspaceId: string
  persistence: IDEWorkspacePersistence
  coordinator: WorkspacePersistenceCoordinator
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
  const persistence = workspace?.persistence
  const initialFiles = mergeWorkspaceFiles(resources, workspace?.initialFiles)
  const seedFingerprint = workspaceFilesFingerprint(initialFiles)
  const initializationKey = JSON.stringify([
    workspaceId ?? 'default-project',
    localCache ?? null,
    seedFingerprint,
  ])
  const initializationToken = useMemo(() => ({ key: initializationKey }), [initializationKey])
  const [readyInitializationToken, setReadyInitializationToken] = useState<object>()

  useLayoutEffect(() => {
    let cancelled = false
    void instance.workspace.initialize({
      projectId: workspaceId ?? 'default-project',
      initialFiles,
      ephemeral: localCache === 'memory',
    }).then(
      () => {
        if (!cancelled) setReadyInitializationToken(initializationToken)
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
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializationKey, initializationToken, instance, localCache, seedFingerprint, workspaceId])

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
      workspaceId={workspaceId}
    />
  )
}

/** Attaches a host adapter only after its exact workspace has initialized. */
function WorkspacePersistenceBinding({
  instanceController,
  persistence,
  workspaceId,
}: {
  instanceController: WebIDEInstanceController
  persistence: IDEWorkspacePersistence
  workspaceId: string
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
      const coordinator = new WorkspacePersistenceCoordinator({
        workspaceId,
        persistence,
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
    const detachLifecycle = instanceController.attachWorkspaceLifecycle({
      flush: (files) => currentBinding.coordinator.flush(files),
      close: (files) => currentBinding.coordinator.close(files),
    })
    const unsubscribe = instance.workspace.subscribe(() =>
      currentBinding.coordinator.scheduleSave(
        projectPersistedWorkspaceFiles(instance.workspace.snapshot()),
      ),
    )
    // Attach both public lifecycle and the change feed before scheduleSave can
    // synchronously publish `saving`. A status observer may apply an external
    // transaction reentrantly; that newer snapshot must supersede this seed.
    if (requiresSeed) {
      currentBinding.coordinator.scheduleSave(
        projectPersistedWorkspaceFiles(instance.workspace.snapshot()),
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
  }, [instance, instanceController, persistence, workspaceId])

  return null
}

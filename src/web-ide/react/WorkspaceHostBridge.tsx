import { useEffect, useLayoutEffect, useRef } from 'react'
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
  workspaceId: string
  persistence: IDEWorkspacePersistence
  coordinator: WorkspacePersistenceCoordinator
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
  const persistenceBinding = useRef<PersistenceBinding | undefined>(undefined)

  useEffect(() => {
    void instance.workspace.initialize({
      projectId: workspaceId ?? 'default-project',
      initialFiles,
      ephemeral: localCache === 'memory',
    })
    // The fingerprint makes semantically identical inline file objects stable;
    // initVFS itself guards overlapping async hydrations by generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, localCache, seedFingerprint, workspaceId])

  useLayoutEffect(() => {
    if (!workspaceId || !persistence) return

    let binding = persistenceBinding.current
    if (
      binding?.workspaceId === workspaceId &&
      binding.persistence === persistence
    ) {
      if (binding.pendingDisposal) {
        binding.pendingDisposal.cancelled = true
        binding.pendingDisposal = undefined
      }
    } else {
      binding = {
        workspaceId,
        persistence,
        coordinator: new WorkspacePersistenceCoordinator({
          workspaceId,
          persistence,
          // Preserve Nova's existing host-save cadence while making the policy
          // explicit and independently testable.
          debounceMs: 2000,
          onPendingChange: (pending) => instance.workspace.markExternalSaving(pending),
          onStatusChange: (status, error) => {
            if (status === 'retrying') {
              const message = error instanceof Error ? error.message : undefined
              instance.workspace.setPersistenceRetry(message)
            } else {
              instance.workspace.clearPersistenceIssue()
            }
          },
        }),
      }
      persistenceBinding.current = binding
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
        void instance.workspace.flushLocalPersistence().finally(() => instance.workspace.dispose())
      })
    }
  }, [instance])

  return null
}

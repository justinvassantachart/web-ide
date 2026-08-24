import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  getAllFiles,
  hasPendingWrites,
  initVFS,
  markExternalSaving,
  subscribeWorkspaceChange,
} from '@/vfs/volume'
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
  const resources = useIDEWorkspaceResources()
  const workspace = host?.workspace
  const workspaceId = workspace?.id
  const localCache = workspace?.localCache
  const persistence = workspace?.persistence
  const initialFiles = mergeWorkspaceFiles(resources, workspace?.initialFiles)
  const seedFingerprint = workspaceFilesFingerprint(initialFiles)
  const persistenceBinding = useRef<PersistenceBinding | undefined>(undefined)

  useEffect(() => {
    void initVFS({
      projectId: workspaceId ?? 'default-project',
      initialFiles,
      ephemeral: localCache === 'memory',
    })
    // The fingerprint makes semantically identical inline file objects stable;
    // initVFS itself guards overlapping async hydrations by generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localCache, seedFingerprint, workspaceId])

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
          onPendingChange: markExternalSaving,
        }),
      }
      persistenceBinding.current = binding
    }

    const currentBinding = binding
    const detachLifecycle = instanceController.attachWorkspaceLifecycle({
      flush: (files) => currentBinding.coordinator.flush(files),
      close: (files) => currentBinding.coordinator.close(files),
    })
    const unsubscribe = subscribeWorkspaceChange(() =>
      currentBinding.coordinator.scheduleSave(
        projectPersistedWorkspaceFiles(getAllFiles()),
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
  }, [instanceController, persistence, workspaceId])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasPendingWrites()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return null
}

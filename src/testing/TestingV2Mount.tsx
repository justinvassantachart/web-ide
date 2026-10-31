import { useEffect } from 'react'
import { useRunPipeline } from '@/components/layout/use-run-pipeline'
import { useRunPipelineCoordinator } from '@/components/layout/run-pipeline-context'
import { useIDEWorkspaceResources } from '@/web-ide/react/contribution-context'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { resolveExecutionResourceFiles, partitionWorkspaceResources } from '@/web-ide/core/workspace-resources'
import type { TestProviderV2 } from '@/web-ide/contracts/testing'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

/**
 * Mounts the optional controller without pulling its implementation into the
 * default package graph. Each workbench owns exactly one controller slot.
 */
export function TestingV2Mount({ provider }: { provider: TestProviderV2 }) {
  const resources = useIDEWorkspaceResources()
  const configuration = useWebIDEConfiguration()
  const instance = useWorkbenchInstance()
  const { execution, executePreparedWithinActivity } = useRunPipeline()
  const coordinator = useRunPipelineCoordinator()

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let detach: (() => void) | undefined
    let dispose: (() => void | Promise<void>) | undefined

    void import('./testing-controller-v2').then(({ createTestingControllerV2 }) => {
      if (cancelled) return
      let activity: { generation: number; drained: Promise<void> } | undefined
      const controller = createTestingControllerV2({
        provider,
        execution: {
          ...execution,
          executePrepared: request => {
            if (!activity || !coordinator.isCurrent(activity.generation)) return Promise.resolve({ type: 'stopped' })
            return executePreparedWithinActivity(request)
          },
        },
        timeoutMs: configuration.testing?.timeoutMs,
        resolveResources: () => resolveExecutionResourceFiles(resources),
        resolveDiscoveryResources: () => partitionWorkspaceResources(resources).executionFiles,
        workspace: {
          snapshot: () => instance.workspace.snapshot(),
          revision: () => instance.workspace.revision,
          subscribe: (listener) => instance.workspace.subscribe(listener),
        },
      })
      if (cancelled) {
        void controller.dispose()
        return
      }
      const withActivity = async (operation: () => Promise<void>): Promise<void> => {
        if (activity) throw new Error('A test run is already active')
        const release = coordinator.acquireActivity()
        if (!release) return
        let resolve!: () => void
        const token = { generation: coordinator.getGeneration(), drained: new Promise<void>(done => { resolve = done }) }
        activity = token
        try { await operation() }
        finally {
          if (activity === token) activity = undefined
          release()
          resolve()
        }
      }
      const guarded = {
        ...controller,
        run: (intent: Parameters<typeof controller.run>[0]) => withActivity(() => controller.run(intent)),
        restart: async () => {
          const prior = activity
          await controller.stop()
          await prior?.drained
          await withActivity(() => controller.restart())
        },
      }
      unsubscribe = controller.subscribe(() => instance.testStore.getState().update(controller.snapshot()))
      detach = instance.testingV2.attach(guarded)
      dispose = () => controller.dispose()
    }).catch((error) => {
      if (!cancelled) console.error('[web-ide] Testing V2 controller failed to load', error)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
      detach?.()
      void dispose?.()
    }
  }, [coordinator, execution, executePreparedWithinActivity, instance, provider, resources, configuration.testing?.timeoutMs])

  return null
}

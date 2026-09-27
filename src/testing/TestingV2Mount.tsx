import { useEffect } from 'react'
import { useRunPipeline } from '@/components/layout/use-run-pipeline'
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
  const { execution } = useRunPipeline()

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let detach: (() => void) | undefined
    let dispose: (() => void | Promise<void>) | undefined

    void import('./testing-controller-v2').then(({ createTestingControllerV2 }) => {
      if (cancelled) return
      const controller = createTestingControllerV2({
        provider,
        execution,
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
      unsubscribe = controller.subscribe(() => instance.testStore.getState().update(controller.snapshot()))
      detach = instance.testingV2.attach(controller)
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
  }, [execution, instance, provider, resources, configuration.testing?.timeoutMs])

  return null
}

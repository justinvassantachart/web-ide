import { useEffect } from 'react'
import { useRunPipeline } from '@/components/layout/use-run-pipeline'
import type { TestProviderV2 } from '@/web-ide/contracts/testing'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

/**
 * Mounts the optional controller without pulling its implementation into the
 * default package graph. Each workbench owns exactly one controller slot.
 */
export function TestingV2Mount({ provider }: { provider: TestProviderV2 }) {
  const instance = useWorkbenchInstance()
  const { execution } = useRunPipeline()

  useEffect(() => {
    let cancelled = false
    let detach: (() => void) | undefined
    let dispose: (() => void | Promise<void>) | undefined

    void import('./testing-controller-v2').then(({ createTestingControllerV2 }) => {
      if (cancelled) return
      const controller = createTestingControllerV2({
        provider,
        execution,
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
      detach = instance.testingV2.attach(controller)
      dispose = () => controller.dispose()
    }).catch((error) => {
      if (!cancelled) console.error('[web-ide] Testing V2 controller failed to load', error)
    })

    return () => {
      cancelled = true
      detach?.()
      void dispose?.()
    }
  }, [execution, instance, provider])

  return null
}

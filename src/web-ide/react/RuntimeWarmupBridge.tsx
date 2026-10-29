import { useEffect } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useRunPipelineCoordinator } from '@/components/layout/run-pipeline-context'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { prepareWorkbenchExecution } from '@/testing/test-execution'
import { buildRuntimeExecutionPlan } from '@/runtimes/execution-plan'
import { notifyRuntimeForegroundIntent } from '@/runtimes/foreground-intent'
import { mergeExecutionResourceFiles } from '../core/workspace-resources'
import type { WebIDEInstanceController } from '../core/instance-handle'
import type { RuntimeWarmupResult } from '../contracts/runtime'
import { useIDEWorkspaceResources } from './contribution-context'
import { useWorkbenchInstance } from './workbench-instance-context'

/** Exposes intent to the host; scheduling remains the host's assignment lifecycle. */
export function RuntimeWarmupBridge({ controller }: { controller: WebIDEInstanceController }) {
  const runtime = useEngine()
  const instance = useWorkbenchInstance()
  const coordinator = useRunPipelineCoordinator()
  const testProvider = useSelectedTestProvider()
  const resources = useIDEWorkspaceResources()

  useEffect(() => {
    let generation = 0
    let pending: Promise<RuntimeWarmupResult> | undefined
    let foregroundIntent: AbortController | undefined
    const cancel = (): Promise<void> => {
      // Pure provider transforms may finish later; this fence prevents engine submission.
      generation++
      return runtime.cancelWarmupAndWait?.() ?? Promise.resolve()
    }
    const detachActivity = coordinator.attachActivity(foreground => {
      const release = controller.acquireRuntimeActivity(foreground)
      if (release && foreground) {
        notifyRuntimeForegroundIntent(runtime)
        foregroundIntent?.abort()
      }
      return release
    })
    const detach = controller.attachRuntimeWarmup({
      identity: runtime,
      ready: () => coordinator.resume(),
      shutdown() {
        generation++
        coordinator.suspend()
        if (runtime.disposeAndWait) return runtime.disposeAndWait().then(() => {})
        runtime.dispose?.()
        if (!runtime.dispose) runtime.stop({ reason: 'teardown' })
        return Promise.resolve()
      },
      suspend() {
        generation++
        coordinator.suspend()
        if (runtime.suspendRuntime) return runtime.suspendRuntime()
        if (runtime.stopAndWait) return runtime.stopAndWait({ reason: 'teardown' }).then(() => {})
        runtime.stop({ reason: 'teardown' })
        return Promise.resolve()
      },
      async resume() {
        await runtime.resumeRuntime?.()
        coordinator.resume()
      },
      release: options => runtime.releaseCompilerResources?.(options) ?? Promise.resolve('cancelled'),
      cancel,
      compilationStatistics: () => runtime.compilationStatistics?.(),
      warmup() {
        if (pending) return pending
        const foreground = coordinator.getGeneration()
        if (!runtime.warmup || !runtime.cancelWarmupAndWait || coordinator.getPendingRun() || coordinator.hasForegroundIntent()) return Promise.resolve({ status: 'skipped', diagnostics: [], reason: 'foreground-transitioned-or-unsupported' })
        const releaseActivity = controller.acquireRuntimeActivity(false)
        if (!releaseActivity) return Promise.resolve({ status: 'cancelled', diagnostics: [] })
        const intent = new AbortController()
        foregroundIntent = intent
        const ticket = generation
        // Capture every resource and workspace byte before an asynchronous transform.
        let files: ReturnType<typeof mergeExecutionResourceFiles>
        try { files = mergeExecutionResourceFiles(resources, instance.workspace.snapshot()) }
        catch (error) { releaseActivity(); return Promise.resolve({ status: 'failed', diagnostics: [error instanceof Error ? error.message : String(error)] }) }
        const task = (async (): Promise<RuntimeWarmupResult> => {
          try {
            const plan = await prepareWorkbenchExecution({ files, mode: 'run', executeTests: false, testProvider })
            if (ticket !== generation || !coordinator.isCurrent(foreground) || coordinator.getPendingRun()) return { status: 'cancelled', diagnostics: [] }
            return await runtime.warmup!(buildRuntimeExecutionPlan(plan), { foregroundIntent: intent.signal })
          } catch (error) {
            if (ticket !== generation || !coordinator.isCurrent(foreground) || coordinator.getPendingRun()) return { status: 'cancelled', diagnostics: [] }
            return { status: 'failed', diagnostics: [error instanceof Error ? error.message : String(error)] }
          } finally {
            if (foregroundIntent === intent) foregroundIntent = undefined
            releaseActivity()
          }
        })()
        pending = task
        void task.finally(() => { if (pending === task) pending = undefined })
        return task
      },
    })
    const unsubscribe = instance.workspace.subscribe(() => { void cancel() })
    return () => {
      unsubscribe()
      detachActivity()
      detach()
      void cancel()
    }
  }, [controller, coordinator, instance, resources, runtime, testProvider])
  return null
}

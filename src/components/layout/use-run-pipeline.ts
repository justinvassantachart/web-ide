import { useCallback, useMemo } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import type {
    RuntimeExecutionMode,
    RuntimeExecutionPlan,
    RuntimePreparationResult,
    RuntimeOutcome,
} from '@/web-ide/contracts/runtime'
import { isTestProviderV2, prepareWorkbenchExecution } from '@/testing/test-execution'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { useIDEWorkspaceResources } from '@/web-ide/react/contribution-context'
import { mergeExecutionResourceFiles } from '@/web-ide/core/workspace-resources'
import { canonicalRuntimeFilePath, normalizeRuntimeFiles } from '@/web-ide/core/workspace-path'
import type { IDEExecutionController } from '@/web-ide/contracts/contributions'
import { useRunPipelineCoordinator } from './run-pipeline-context'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

// One coordinated compile-and-run path lets toolbar buttons, panels, and
// hotkeys share cancellation and ordered transition state for this mount.
export function useRunPipeline() {
    const engine = useEngine()
    const host = useIDEHost()
    const testProvider = useSelectedTestProvider()
    const resources = useIDEWorkspaceResources()
    const coordinator = useRunPipelineCoordinator()
    const { controller: panelLayout } = usePanelLayout()
    const instance = useWorkbenchInstance()

    const settleStop = useCallback(async () => {
        if (engine.stopAndWait) await engine.stopAndWait()
        else engine.stop()
    }, [engine])

    const run = useCallback(async (
        debug: boolean,
        isTest = false,
        preparedPlan?: RuntimeExecutionPlan,
        resourcesResolved = false,
    ) => {
        const exec = instance.executionStore.getState()
        if (exec.isCompiling || exec.isRunning || coordinator.getPendingRun()) return { type: 'busy' as const }
        let outcome: RuntimeOutcome | { type: 'build_failed'; message: string } = { type: 'stopped' }
        const generation = coordinator.beginTransition()
        let releaseTask!: () => void
        const startGate = new Promise<void>((resolve) => {
            releaseTask = resolve
        })
        const task = (async () => {
            // Register this task with the mount coordinator before any store or
            // host callback can synchronously re-enter through another surface.
            await startGate
            if (!coordinator.isCurrent(generation)) return
            if (isTest) {
                instance.testStore.getState().reset()
                panelLayout.selectPanel('tests')
            }
            const mode: RuntimeExecutionMode = debug ? 'debug' : 'run'
            let prepared: RuntimePreparationResult
            let executionMode = mode
            try {
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                exec.setIsCompiling(true)
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                host?.events?.emit(
                    isTest ? 'compile_test' : debug ? 'compile_debug' : 'compile',
                    {},
                )
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                let plan = preparedPlan ?? await prepareWorkbenchExecution({
                        files: mergeExecutionResourceFiles(resources, instance.workspace.snapshot()),
                        mode,
                        executeTests: isTest,
                        testProvider,
                    })
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                // Validate the provider-owned plan fields before invoking any
                // dynamic resource callback or mutating the selected runtime.
                const entrypoint = plan.entrypoint === undefined
                    ? undefined
                    : canonicalRuntimeFilePath(plan.entrypoint)
                const files = !preparedPlan || resourcesResolved ? normalizeRuntimeFiles(plan.files) : mergeExecutionResourceFiles(resources, plan.files)
                plan = entrypoint === undefined
                    ? { ...plan, files }
                    : { ...plan, files, entrypoint }
                executionMode = plan.mode
                prepared = await engine.prepare(plan)
                if (!coordinator.isCurrent(generation)) {
                    try {
                        await settleStop()
                    } catch (error) {
                        console.error('[web-ide] cancelled runtime cleanup failed', error)
                    }
                    instance.testStore.getState().finalize()
                    return
                }
            } catch (error) {
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                outcome = { type: 'build_failed', message: error instanceof Error ? error.message : String(error) }
                console.error('[web-ide] runtime preparation failed', error)
                host?.events?.emit('compile_error', { debug })
                instance.testStore.getState().finalize()
                return
            } finally {
                instance.executionStore.getState().setIsCompiling(false)
            }
            if (!coordinator.isCurrent(generation)) {
                instance.testStore.getState().finalize()
                return
            }
            if (!prepared.success) {
                outcome = { type: 'build_failed', message: prepared.errors.join('\n') }
                host?.events?.emit('compile_error', { debug })
                instance.testStore.getState().finalize()
                return
            }

            instance.executionStore.getState().setIsRunning(true)
            instance.debugStore.getState().setDebugMode(debug ? 'running' : 'idle')
            host?.events?.emit(isTest ? 'run_tests' : 'run', { debug })
            if (!coordinator.isCurrent(generation)) {
                instance.executionStore.getState().setIsRunning(false)
                instance.debugStore.getState().setDebugMode('idle')
                instance.testStore.getState().finalize()
                return
            }
            coordinator.markRuntimeStart(generation)
            try {
                await engine.start({ mode: executionMode })
                outcome = engine.waitForSettlement ? await engine.waitForSettlement() : { type: 'completed', exitCode: 0 }
            } catch (error) {
                // A conforming adapter should normally surface runtime failures
                // through typed events, but a rejected start must never leave the
                // host workbench stuck in a running state.
                outcome = { type: 'error', error: { type: 'runtime', message: error instanceof Error ? error.message : String(error) } }
                console.error('[web-ide] runtime start failed', error)
                instance.executionStore.getState().setIsRunning(false)
                instance.debugStore.getState().setDebugMode('idle')
                instance.testStore.getState().finalize()
            }
        })()
        coordinator.setPendingRun(task)
        releaseTask()
        try {
            await task
        } finally {
            coordinator.clearPendingRun(task)
        }
        return outcome
    }, [coordinator, engine, host, instance, panelLayout, resources, settleStop, testProvider])

    const stop = useCallback(async () => {
        const generation = coordinator.beginTransition()
        const pending = coordinator.getPendingRun()
        const pendingWasPreparing = pending
            ? coordinator.isPreparing(pending)
            : false
        let stopFailed = false
        try {
            await settleStop()
        } catch (error) {
            console.error('[web-ide] runtime stop failed', error)
            stopFailed = true
        }
        try {
            if (pending && (!stopFailed || pendingWasPreparing)) await pending
        } catch (error) {
            console.error('[web-ide] pending runtime cancellation failed', error)
        } finally {
            if (coordinator.isCurrent(generation)) {
                instance.debugStore.getState().reset()
            }
        }
    }, [coordinator, instance, settleStop])

    const restart = useCallback(async (debug: boolean) => {
        const testing = instance.testingV2?.snapshot()
        if (testing?.snapshot().state === 'running') {
            host?.events?.emit('debug_restart', {})
            await testing.restart()
            return
        }
        const generation = coordinator.beginTransition()
        const pending = coordinator.getPendingRun()
        const pendingWasPreparing = pending
            ? coordinator.isPreparing(pending)
            : false
        host?.events?.emit('debug_restart', {})
        if (!coordinator.isCurrent(generation)) return
        let stopFailed = false
        try {
            await settleStop()
        } catch (error) {
            console.error('[web-ide] runtime restart stop failed', error)
            stopFailed = true
        }
        try {
            if (pending && (!stopFailed || pendingWasPreparing)) await pending
        } catch (error) {
            console.error('[web-ide] pending runtime cancellation failed', error)
            stopFailed = true
        } finally {
            if (coordinator.isCurrent(generation)) {
                instance.debugStore.getState().reset()
            }
        }
        if (stopFailed || !coordinator.isCurrent(generation)) return
        await run(debug)
    }, [coordinator, host, instance, run, settleStop])

    const execution = useMemo<IDEExecutionController>(() => ({
        start: async (mode) => {
            if (mode === 'test' && testProvider && isTestProviderV2(testProvider)) {
                panelLayout.selectPanel('tests')
                let controller
                try {
                    controller = await instance.testingV2.whenAvailable()
                } catch {
                    return
                }
                await controller.run({ mode: 'run', selection: { kind: 'all' } })
                return
            }
            await run(mode === 'debug', mode === 'test')
        },
        stop,
        restart: async (mode) => restart(mode === 'debug'),
        executePrepared: async ({ plan, workflow, resourcesResolved }) => run(
            plan.mode === 'debug',
            workflow === 'test',
            plan,
            resourcesResolved,
        ),
    }), [instance, panelLayout, restart, run, stop, testProvider])

    return { run, stop, restart, execution }
}

import { useCallback, useMemo } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import type {
    RuntimeExecutionMode,
    RuntimeExecutionPlan,
    RuntimePreparationResult,
} from '@/web-ide/contracts/runtime'
import { prepareWorkbenchExecution } from '@/testing/test-execution'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { useIDEWorkspaceResources } from '@/web-ide/react/contribution-context'
import { mergeExecutionResourceFiles } from '@/web-ide/core/workspace-resources'
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
    ) => {
        const exec = instance.executionStore.getState()
        if (exec.isCompiling || exec.isRunning || coordinator.getPendingRun()) return
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
                        files: instance.workspace.snapshot(),
                        mode,
                        executeTests: isTest,
                        testProvider,
                        onTestEvent: (event) => instance.testStore.getState().processEvent(event),
                    })
                if (!coordinator.isCurrent(generation)) {
                    instance.testStore.getState().finalize()
                    return
                }
                const files = mergeExecutionResourceFiles(resources, plan.files)
                if (files !== plan.files) {
                    plan = { ...plan, files }
                }
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
            } catch (error) {
                // A conforming adapter should normally surface runtime failures
                // through typed events, but a rejected start must never leave the
                // host workbench stuck in a running state.
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
        start: async (mode) => run(mode === 'debug', mode === 'test'),
        stop,
        restart: async (mode) => restart(mode === 'debug'),
        executePrepared: async ({ plan, workflow }) => run(
            plan.mode === 'debug',
            workflow === 'test',
            plan,
        ),
    }), [restart, run, stop])

    return { run, stop, restart, execution }
}

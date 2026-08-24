import { useCallback, useMemo } from 'react'
import { useExecutionStore } from '@/store/execution-store'
import { useDebugStore } from '@/store/debug-store'
import { useTestStore } from '@/testing/test-store'
import { getAllFiles } from '@/vfs/volume'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import type {
    RuntimeExecutionMode,
    RuntimePreparationResult,
} from '@/web-ide/contracts/runtime'
import { prepareWorkbenchExecution } from '@/testing/test-execution'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { useIDEWorkspaceResources } from '@/web-ide/react/contribution-context'
import { mergeExecutionResourceFiles } from '@/web-ide/core/workspace-resources'
import type { IDEExecutionController } from '@/web-ide/contracts/contributions'
import { useRunPipelineCoordinator } from './run-pipeline-context'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'

// One coordinated compile-and-run path lets toolbar buttons, panels, and
// hotkeys share cancellation and ordered transition state for this mount.
export function useRunPipeline() {
    const engine = useEngine()
    const host = useIDEHost()
    const testProvider = useSelectedTestProvider()
    const resources = useIDEWorkspaceResources()
    const coordinator = useRunPipelineCoordinator()
    const { controller: panelLayout } = usePanelLayout()

    const settleStop = useCallback(async () => {
        if (engine.stopAndWait) await engine.stopAndWait()
        else engine.stop()
    }, [engine])

    const run = useCallback(async (debug: boolean, isTest = false) => {
        const exec = useExecutionStore.getState()
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
                useTestStore.getState().reset()
                panelLayout.selectPanel('tests')
            }
            const mode: RuntimeExecutionMode = debug ? 'debug' : 'run'
            let prepared: RuntimePreparationResult
            let executionMode = mode
            try {
                if (!coordinator.isCurrent(generation)) {
                    useTestStore.getState().finalize()
                    return
                }
                exec.setIsCompiling(true)
                if (!coordinator.isCurrent(generation)) {
                    useTestStore.getState().finalize()
                    return
                }
                host?.events?.emit(
                    isTest ? 'compile_test' : debug ? 'compile_debug' : 'compile',
                    {},
                )
                if (!coordinator.isCurrent(generation)) {
                    useTestStore.getState().finalize()
                    return
                }
                let plan = await prepareWorkbenchExecution({
                    files: getAllFiles(),
                    mode,
                    executeTests: isTest,
                    testProvider,
                    onTestEvent: (event) => useTestStore.getState().processEvent(event),
                })
                if (!coordinator.isCurrent(generation)) {
                    useTestStore.getState().finalize()
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
                    useTestStore.getState().finalize()
                    return
                }
            } catch (error) {
                if (!coordinator.isCurrent(generation)) {
                    useTestStore.getState().finalize()
                    return
                }
                console.error('[web-ide] runtime preparation failed', error)
                host?.events?.emit('compile_error', { debug })
                useTestStore.getState().finalize()
                return
            } finally {
                useExecutionStore.getState().setIsCompiling(false)
            }
            if (!coordinator.isCurrent(generation)) {
                useTestStore.getState().finalize()
                return
            }
            if (!prepared.success) {
                host?.events?.emit('compile_error', { debug })
                useTestStore.getState().finalize()
                return
            }

            useExecutionStore.getState().setIsRunning(true)
            useDebugStore.getState().setDebugMode(debug ? 'running' : 'idle')
            host?.events?.emit(isTest ? 'run_tests' : 'run', { debug })
            if (!coordinator.isCurrent(generation)) {
                useExecutionStore.getState().setIsRunning(false)
                useDebugStore.getState().setDebugMode('idle')
                useTestStore.getState().finalize()
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
                useExecutionStore.getState().setIsRunning(false)
                useDebugStore.getState().setDebugMode('idle')
                useTestStore.getState().finalize()
            }
        })()
        coordinator.setPendingRun(task)
        releaseTask()
        try {
            await task
        } finally {
            coordinator.clearPendingRun(task)
        }
    }, [coordinator, engine, host, panelLayout, resources, settleStop, testProvider])

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
                useDebugStore.getState().reset()
            }
        }
    }, [coordinator, settleStop])

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
                useDebugStore.getState().reset()
            }
        }
        if (stopFailed || !coordinator.isCurrent(generation)) return
        await run(debug)
    }, [coordinator, host, run, settleStop])

    const execution = useMemo<IDEExecutionController>(() => ({
        start: async (mode) => run(mode === 'debug', mode === 'test'),
        stop,
        restart: async (mode) => restart(mode === 'debug'),
    }), [restart, run, stop])

    return { run, stop, restart, execution }
}

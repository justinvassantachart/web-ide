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

// One shared compile-and-run pipeline so the toolbar buttons, the floating
// debug toolbar's Restart, and the F5 hotkey all launch sessions through the
// same code path.
export function useRunPipeline() {
    const engine = useEngine()
    const host = useIDEHost()
    const testProvider = useSelectedTestProvider()
    const resources = useIDEWorkspaceResources()

    const run = useCallback(async (debug: boolean, isTest = false) => {
        const exec = useExecutionStore.getState()
        if (exec.isCompiling || exec.isRunning) return
        if (isTest) {
            useTestStore.getState().reset()
            exec.setRightTab('tests')
        }
        exec.setIsCompiling(true)
        const mode: RuntimeExecutionMode = debug ? 'debug' : 'run'
        host?.events?.emit(isTest ? 'compile_test' : debug ? 'compile_debug' : 'compile', {})
        let prepared: RuntimePreparationResult
        let executionMode = mode
        try {
            let plan = await prepareWorkbenchExecution({
                files: getAllFiles(),
                mode,
                executeTests: isTest,
                testProvider,
                onTestEvent: (event) => useTestStore.getState().processEvent(event),
            })
            const files = mergeExecutionResourceFiles(resources, plan.files)
            if (files !== plan.files) {
                plan = { ...plan, files }
            }
            executionMode = plan.mode
            prepared = await engine.prepare(plan)
        } catch (error) {
            console.error('[web-ide] runtime preparation failed', error)
            host?.events?.emit('compile_error', { debug })
            useTestStore.getState().finalize()
            return
        } finally {
            useExecutionStore.getState().setIsCompiling(false)
        }
        if (!prepared.success) {
            host?.events?.emit('compile_error', { debug })
            useTestStore.getState().finalize()
            return
        }

        useExecutionStore.getState().setIsRunning(true)
        useDebugStore.getState().setDebugMode(debug ? 'running' : 'idle')
        host?.events?.emit(isTest ? 'run_tests' : 'run', { debug })
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
    }, [engine, host, resources, testProvider])

    const settleStop = useCallback(async () => {
        if (engine.stopAndWait) await engine.stopAndWait()
        else engine.stop()
    }, [engine])

    const stop = useCallback(async () => {
        try {
            await settleStop()
        } catch (error) {
            console.error('[web-ide] runtime stop failed', error)
        } finally {
            useDebugStore.getState().reset()
        }
    }, [settleStop])

    const restart = useCallback(async (debug: boolean) => {
        host?.events?.emit('debug_restart', {})
        try {
            await settleStop()
        } catch (error) {
            console.error('[web-ide] runtime restart stop failed', error)
            return
        } finally {
            useDebugStore.getState().reset()
        }
        await run(debug)
    }, [host, run, settleStop])

    const execution = useMemo<IDEExecutionController>(() => ({
        start: async (mode) => run(mode === 'debug', mode === 'test'),
        stop,
        restart: async (mode) => restart(mode === 'debug'),
    }), [restart, run, stop])

    return { run, stop, restart, execution }
}

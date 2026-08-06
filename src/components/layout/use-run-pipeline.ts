import { useCallback } from 'react'
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

// One shared compile-and-run pipeline so the toolbar buttons, the floating
// debug toolbar's Restart, and the F5 hotkey all launch sessions through the
// same code path.
export function useRunPipeline() {
    const engine = useEngine()
    const host = useIDEHost()
    const testProvider = useSelectedTestProvider()

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
            const plan = await prepareWorkbenchExecution({
                files: getAllFiles(),
                mode,
                executeTests: isTest,
                testProvider,
                onTestEvent: (event) => useTestStore.getState().processEvent(event),
            })
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
    }, [engine, host, testProvider])

    const stop = useCallback(() => {
        engine.stop()
        useDebugStore.getState().reset()
    }, [engine])

    const restart = useCallback(async (debug: boolean) => {
        host?.events?.emit('debug_restart', {})
        engine.stop()
        useDebugStore.getState().reset()
        await run(debug)
    }, [engine, host, run])

    return { run, stop, restart }
}

import { useEffect } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useExecutionStore } from '@/store/execution-store'
import { useCompilerStore } from '@/store/compiler-store'
import { useDebugStore } from '@/store/debug-store'
import { useEngine } from '@/engine/engine-context'
import { useTestStore } from '@/testing/test-store'
import { SaveStatus } from './SaveStatus'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { useRunPipeline } from './use-run-pipeline'
import { getAllFiles } from '@/vfs/volume'
import { useIDECommands } from '@/web-ide/react/contribution-context'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import type {
    IDECommandContext,
    IDEWorkbenchSnapshot,
} from '@/web-ide/contracts/contributions'

export function Toolbar() {
    const configuration = useWebIDEConfiguration()
    const engine = useEngine()
    const host = useIDEHost()
    const { isCompiling, isRunning, setIsRunning, setRightTab } = useExecutionStore()
    const { cacheState, downloadProgress } = useCompilerStore()
    const { debugMode, pushHistoryState, setDebugMode } = useDebugStore()
    const { run, stop, restart } = useRunPipeline()
    const commands = useIDECommands()
    const testProvider = useSelectedTestProvider()
    const compilerReady = cacheState === 'ready'

    useEffect(() => {
        const u1 = engine.events.debugPaused.subscribe((state) => pushHistoryState(state))
        const u2 = engine.events.debugResumed.subscribe(() => setDebugMode('running'))
        const u3 = engine.events.exit.subscribe(() => {
            setIsRunning(false)
            if (useDebugStore.getState().debugMode !== 'idle') setDebugMode('idle')
            // If a test crashed mid-flight the engine never emits SUITE_END, so
            // promote the unfinished case to a failure rather than leaving the
            // panel spinning forever.
            useTestStore.getState().finalize()
        })
        const u4 = engine.events.diagnostic.subscribe((diagnostic) => {
            if (diagnostic.severity === 'error') {
                host?.events?.emit('compile_error', { debug: diagnostic.mode === 'debug' })
            }
        })
        // Mirror VS Code: when the debugger snaps a breakpoint to the next
        // executable line, move the gutter dot to where it actually bound —
        // and tell the host, so recorded traces carry the authoritative set.
        const u5 = engine.events.breakpointsValidated.subscribe(({ file, lines }) => {
            useDebugStore.getState().setFileBreakpoints(file, lines)
            host?.events?.emit('breakpoints_validated', { file, lines })
        })
        return () => { u1(); u2(); u3(); u4(); u5() }
    }, [engine, host, pushHistoryState, setDebugMode, setIsRunning])

    const workbenchSnapshot: IDEWorkbenchSnapshot = {
        runState: debugMode === 'paused' ? 'paused' : isRunning ? 'running' : 'idle',
        isCompiling,
        runtimeReady: compilerReady,
        runtimeCapabilities: engine.capabilities,
        testingAvailable: testProvider !== undefined,
    }
    const commandContext: IDECommandContext = {
        execution: {
            start: async (kind) => run(kind === 'debug', kind === 'test'),
            stop,
            restart: async (kind) => restart(kind === 'debug'),
        },
        workspace: { snapshot: getAllFiles },
        panels: { reveal: setRightTab },
    }
    const toolbarCommands = commands.filter((command) =>
        command.surface === 'toolbar' && (command.when?.(workbenchSnapshot) ?? true),
    )

    return (
        <div className="flex items-center h-10 px-3 gap-2 border-b border-border bg-[var(--color-chrome)]">
            {host?.chrome?.brand !== false && configuration.brand !== false && (
                <span className="font-bold text-sm tracking-[0.18em] text-foreground select-none">
                    {configuration.brand ?? 'WEB·IDE'}
                </span>
            )}

            <SaveStatus />

            <div className="mr-auto" />

            {/* Compiler download progress */}
            {cacheState === 'downloading' && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Codicon name="loading" size={12} spin />
                    <span>Loading compiler…</span>
                    <Progress value={downloadProgress} className="w-24 h-1.5" />
                </div>
            )}

            {/* Commands are contributed declaratively; execution state stays in
                the status bar and debug stepping stays in the floating toolbar. */}
            {toolbarCommands.length > 0 && (
                <div className="flex gap-1.5">
                    {toolbarCommands.map((command) => {
                        const enabled = command.enabled?.(workbenchSnapshot) ?? true
                        const reason = enabled ? undefined : command.disabledReason?.(workbenchSnapshot)
                        const variant = command.tone === 'danger' ? 'destructive' : 'outline'
                        const className = command.tone === 'success'
                            ? 'bg-[oklch(0.65_0.18_145)] hover:bg-[oklch(0.7_0.18_145)] text-black gap-1 font-semibold'
                            : 'gap-1'
                        const iconClass = command.id === 'workbench.debug'
                            ? 'text-primary'
                            : command.id === 'workbench.test'
                                ? 'text-emerald-500'
                                : undefined
                        const button = (
                            <Button
                                data-command-id={command.id}
                                size="sm"
                                variant={variant}
                                onClick={() => void command.execute(commandContext)}
                                disabled={!enabled}
                                className={className}
                            >
                                {command.icon && <Codicon name={command.icon} size={14} className={iconClass} />}
                                {command.title}
                            </Button>
                        )
                        if (!reason) return <span key={command.id}>{button}</span>
                        return (
                            <Tooltip key={command.id}>
                                <TooltipTrigger asChild><span>{button}</span></TooltipTrigger>
                                <TooltipContent><p>{reason}</p></TooltipContent>
                            </Tooltip>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

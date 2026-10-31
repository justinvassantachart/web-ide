import { useEffect } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine/engine-context'
import { SaveStatus } from './SaveStatus'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { useRunPipeline } from './use-run-pipeline'
import { useIDECommands } from '@/web-ide/react/contribution-context'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import type {
    IDECommandContext,
    IDEWorkbenchSnapshot,
} from '@/web-ide/contracts/contributions'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'
import {
    useWorkbenchCompilerStore,
    useWorkbenchDebugStore,
    useWorkbenchExecutionStore,
    useWorkbenchInstance,
} from '@/web-ide/react/workbench-instance-context'

export function Toolbar() {
    const configuration = useWebIDEConfiguration()
    const engine = useEngine()
    const host = useIDEHost()
    const { isCompiling, isRunning, setIsRunning } = useWorkbenchExecutionStore()
    const { controller: panelLayout } = usePanelLayout()
    const { cacheState, downloadProgress } = useWorkbenchCompilerStore()
    const { debugMode, pushHistoryState, setDebugMode } = useWorkbenchDebugStore()
    const instance = useWorkbenchInstance()
    const { execution } = useRunPipeline()
    const commands = useIDECommands()
    const testProvider = useSelectedTestProvider()
    const compilerReady = cacheState === 'ready'

    useEffect(() => {
        const u1 = engine.events.debugPaused.subscribe((state) => pushHistoryState(state))
        const u6 = engine.events.debugSnapshotUpdated?.subscribe((state) => instance.debugStore.getState().refreshHistoryState(state))
        const u2 = engine.events.debugResumed.subscribe(() => setDebugMode('running'))
        const u3 = engine.events.exit.subscribe(() => {
            setIsRunning(false)
            if (instance.debugStore.getState().debugMode !== 'idle') setDebugMode('idle')
            // If a test crashed mid-flight the engine never emits SUITE_END, so
            // promote the unfinished case to a failure rather than leaving the
            // panel spinning forever.
            instance.testStore.getState().finalize()
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
            instance.debugStore.getState().setFileBreakpoints(file, lines)
            host?.events?.emit('breakpoints_validated', { file, lines })
        })
        return () => { u1(); u2(); u3(); u4(); u5(); u6?.() }
    }, [engine, host, instance, pushHistoryState, setDebugMode, setIsRunning])

    const workbenchSnapshot: IDEWorkbenchSnapshot = {
        runState: debugMode === 'paused' ? 'paused' : isRunning ? 'running' : 'idle',
        isCompiling,
        runtimeReady: compilerReady,
        runtimeCapabilities: engine.capabilities,
        testingAvailable: testProvider !== undefined,
    }
    const commandContext: IDECommandContext = {
        execution,
        workspace: {
            snapshot: () => instance.workspace.snapshot(),
            revision: () => instance.workspace.revision,
            subscribe: (listener) => instance.workspace.subscribe(listener),
        },
        panels: { reveal: panelLayout.selectPanel },
    }
    const toolbarCommands = commands.filter((command) =>
        command.surface === 'toolbar' && (command.when?.(workbenchSnapshot) ?? true),
    )

    return (
        <div className="web-ide-toolbar" role="toolbar" aria-label="Workbench toolbar">
            {host?.chrome?.brand !== false && configuration.brand !== false && (
                <span className="web-ide-toolbar-brand">
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

            {/* Commands are contributed declaratively and styled only by their
                public `tone`, so a host command such as a graphics "Run in
                Window" gets the same chrome as the built-ins. Commands that are
                not applicable right now stay in place, disabled, instead of
                disappearing; the contributed Stop takes the danger tone. */}
            {toolbarCommands.length > 0 && (
                <div className="web-ide-toolbar-commands">
                    {toolbarCommands.map((command) => {
                        const enabled = command.enabled?.(workbenchSnapshot) ?? true
                        const reason = enabled ? undefined : command.disabledReason?.(workbenchSnapshot)
                        const button = (
                            <button
                                type="button"
                                data-command-id={command.id}
                                data-tone={command.tone ?? 'default'}
                                className="web-ide-toolbar-button"
                                onClick={() => void command.execute(commandContext)}
                                disabled={!enabled}
                            >
                                {command.icon && <Codicon name={command.icon} />}
                                {command.title}
                            </button>
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

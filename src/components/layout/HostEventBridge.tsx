import { useEffect } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'

// Forwards engine runtime events to the host's onEvent channel:
// 'terminal_stdout' with { text } per output chunk and 'program_exit'
// with { code } when the program ends. Gated on host.wantsRuntimeEvents
// because stdout is high-volume — persistence-oriented hosts shouldn't
// receive a remote write for every output line.
//
// Renders nothing; it exists so the subscription lives inside
// EngineProvider without coupling instrumentation to any visible panel.
export function HostEventBridge() {
    const engine = useEngine()
    const host = useIDEHost()

    useEffect(() => {
        if (!host?.events?.includeRuntime) return
        const onEvent = host.events.emit
        const u1 = engine.events.stdout.subscribe((text) => onEvent('terminal_stdout', { text }))
        // stderr (compiler diagnostics, runtime traps) shares the terminal
        // event type so a host recording reconstructs the terminal exactly;
        // the `stream` tag lets consumers that care about stdout alone filter
        // it back out.
        const u2 = engine.events.stderr.subscribe((text) => onEvent('terminal_stdout', { text, stream: 'stderr' }))
        const u3 = engine.events.exit.subscribe((code) => onEvent('program_exit', { code }))
        const u4 = engine.events.debugPaused.subscribe((s) =>
            onEvent('debug_paused', { file: s.file, line: s.line, func: s.func }))
        return () => { u1(); u2(); u3(); u4() }
    }, [engine, host])

    return null
}

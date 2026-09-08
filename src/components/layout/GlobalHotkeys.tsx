// VS Code debug keybindings, global to the IDE component:
//   F5         continue (paused) / start debugging (idle)
//   ⇧F5        stop the session
//   ⇧⌘F5/⇧^F5  restart debugging
//   F10        step over
//   F11        step into          (browser fullscreen is only intercepted
//   ⇧F11       step out            while a session is paused)
//
// F9 (toggle breakpoint at the cursor) lives in Editor.tsx because it needs
// the Monaco cursor position.
//
// Listeners attach in the capture phase so the shortcuts win over Monaco's
// own keydown handling when the editor has focus.

import { useEffect } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { useRunPipeline } from './use-run-pipeline'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

export function GlobalHotkeys() {
    const engine = useEngine()
    const host = useIDEHost()
    const { run, stop, restart } = useRunPipeline()
    const instance = useWorkbenchInstance()

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'F5' && e.key !== 'F10' && e.key !== 'F11') return
            const root = instance.getRootElement()
            const target = e.target
            const active = document.activeElement
            if (
                !root
                || ((!(target instanceof Node) || !root.contains(target))
                    && (!(active instanceof Node) || !root.contains(active)))
            ) return
            if (!engine.capabilities.debug) return

            const mode = instance.debugStore.getState().debugMode
            const atLiveEdge = instance.debugStore.getState().stepIndex < 0
            const paused = mode === 'paused'
            const canStep = paused && atLiveEdge
            const { isRunning, isCompiling } = instance.executionStore.getState()
            const sessionLive = mode !== 'idle' || isRunning

            if (e.key === 'F5') {
                if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
                    if (!sessionLive) return
                    e.preventDefault()
                    void restart(true)
                } else if (e.shiftKey) {
                    if (!sessionLive) return
                    e.preventDefault()
                    stop()
                } else if (canStep) {
                    e.preventDefault()
                    host?.events?.emit('debug_continue', {})
                    void engine.continueExecution()
                } else if (!sessionLive && !isCompiling) {
                    if (instance.compilerStore.getState().cacheState !== 'ready') return
                    e.preventDefault()
                    void run(true)
                }
                return
            }

            if (!canStep) return
            if (e.key === 'F10') {
                e.preventDefault()
                host?.events?.emit('debug_step_over', {})
                void engine.stepOver()
            } else if (e.key === 'F11') {
                e.preventDefault()
                if (e.shiftKey) {
                    host?.events?.emit('debug_step_out', {})
                    void engine.stepOut()
                } else {
                    host?.events?.emit('debug_step_into', {})
                    void engine.stepInto()
                }
            }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [engine, host, instance, run, stop, restart])

    return null
}

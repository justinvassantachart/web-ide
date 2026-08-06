// Floating debug toolbar, VS Code style: a small icon pill floating over
// the editor while a debug session is active. It stays mounted across the
// paused→running→paused cycle of each step so the controls don't flicker
// in and out of the top toolbar (where they used to live).
//
// Like VS Code's, the pill is draggable: grab the grip on the left edge,
// drop it anywhere inside the editor, and the position persists across
// sessions (double-click the grip to snap back to the default top-center).
//
// Button groups, mirroring VS Code's order:
//   Continue · Step Over · Step Into · Step Out │ History back/forward │ Restart · Stop
// The middle group is Nova's time-travel through the recorded step
// history; while you're viewing history, a position chip ("3/12") shows
// where you are and the live-execution controls wait until you return.

import { useEffect, useRef, useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebugStore } from '@/store/debug-store'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { useRunPipeline } from './use-run-pipeline'
import {
    clampPosition,
    loadStoredPosition,
    positionFromDrag,
    storePosition,
    type Pos,
} from './toolbar-drag'

interface ToolbarAction {
    label: string
    shortcut?: string
    icon: string
    onClick: () => void
    disabled?: boolean
    /** VS Code debug icon colors: blue actions, green restart, red stop. */
    tone: 'blue' | 'green' | 'red' | 'plain'
    /** Extra classes on the icon glyph (e.g. mirroring). */
    iconClassName?: string
}

const TONE_CLASS: Record<ToolbarAction['tone'], string> = {
    blue: 'text-[#75beff]',
    green: 'text-[#89d185]',
    red: 'text-[#f48771]',
    plain: 'text-foreground',
}

// Drag behavior for the pill. Positions are px offsets inside the
// toolbar's offsetParent (the editor wrapper, which is position:relative).
// `pos === null` means "default CSS position" (top-center); the first drag
// switches to explicit coordinates.
function useDraggablePill() {
    const ref = useRef<HTMLDivElement | null>(null)
    const [pos, setPos] = useState<Pos | null>(loadStoredPosition)
    const [dragging, setDragging] = useState(false)
    const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Pos } | null>(null)

    const measure = () => {
        const el = ref.current
        const parent = el?.offsetParent as HTMLElement | null
        if (!el || !parent) return null
        return {
            toolbar: { width: el.offsetWidth, height: el.offsetHeight },
            container: { width: parent.clientWidth, height: parent.clientHeight },
        }
    }

    // A position saved against a larger window may be out of bounds here;
    // clamp once sizes are measurable (rAF: post-layout, async).
    useEffect(() => {
        const raf = requestAnimationFrame(() => {
            setPos((p) => {
                const s = measure()
                return p && s ? clampPosition(p, s.toolbar, s.container) : p
            })
        })
        return () => cancelAnimationFrame(raf)
    }, [])

    // Keep the pill inside the editor when the window shrinks.
    useEffect(() => {
        const onResize = () => {
            setPos((p) => {
                const s = measure()
                return p && s ? clampPosition(p, s.toolbar, s.container) : p
            })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        const el = ref.current
        const parent = el?.offsetParent as HTMLElement | null
        if (!el || !parent) return
        const rect = el.getBoundingClientRect()
        const parentRect = parent.getBoundingClientRect()
        drag.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            origin: { x: rect.left - parentRect.left, y: rect.top - parentRect.top },
        }
        // Capture keeps move/up events flowing to the grip even when the
        // pointer outruns it mid-drag. It can throw for exotic/synthetic
        // pointers — dragging still works without it as long as the pointer
        // stays over the grip, so degrade silently.
        try {
            e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
            // best-effort
        }
        setDragging(true)
    }

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current
        if (!d || e.pointerId !== d.pointerId) return
        const s = measure()
        if (!s) return
        setPos(positionFromDrag(
            d.origin,
            { x: e.clientX - d.startX, y: e.clientY - d.startY },
            s.toolbar,
            s.container,
        ))
    }

    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current
        if (!d || e.pointerId !== d.pointerId) return
        drag.current = null
        setDragging(false)
        setPos((p) => {
            storePosition(p)
            return p
        })
    }

    const resetPosition = () => {
        drag.current = null
        setDragging(false)
        storePosition(null)
        setPos(null)
    }

    return {
        pillRef: ref,
        dragging,
        // Explicit coordinates override the stylesheet's centered default.
        posStyle: pos ? { left: pos.x, top: pos.y, transform: 'none' as const } : undefined,
        gripHandlers: {
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onDoubleClick: resetPosition,
        },
    } as const
}

export function DebugToolbar() {
    const { debugMode, stepHistory, stepIndex, stepBack, stepForward } = useDebugStore()
    const engine = useEngine()
    const host = useIDEHost()
    const { stop, restart } = useRunPipeline()
    const { pillRef, dragging, posStyle, gripHandlers } = useDraggablePill()

    // Visible for the whole debug session (running or paused) — but not for
    // plain Run sessions, which keep debugMode at 'idle'.
    if (debugMode !== 'paused' && debugMode !== 'running') return null

    const paused = debugMode === 'paused'
    const isAtLiveEdge = stepIndex < 0
    const canAct = paused && isAtLiveEdge
    const canStepBack = paused && (isAtLiveEdge ? stepHistory.length >= 2 : stepIndex > 0)
    const canStepForward = paused && !isAtLiveEdge && stepIndex < stepHistory.length - 1

    const liveGroup: ToolbarAction[] = [
        { label: 'Continue', shortcut: 'F5', icon: 'debug-continue', tone: 'blue', disabled: !canAct, onClick: () => { host?.events?.emit('debug_continue', {}); engine.continueExecution() } },
        { label: 'Step Over', shortcut: 'F10', icon: 'debug-step-over', tone: 'blue', disabled: !canAct, onClick: () => { host?.events?.emit('debug_step_over', {}); engine.stepOver() } },
        { label: 'Step Into', shortcut: 'F11', icon: 'debug-step-into', tone: 'blue', disabled: !canAct, onClick: () => { host?.events?.emit('debug_step_into', {}); engine.stepInto() } },
        { label: 'Step Out', shortcut: '⇧F11', icon: 'debug-step-out', tone: 'blue', disabled: !canAct, onClick: () => { host?.events?.emit('debug_step_out', {}); engine.stepOut() } },
    ]
    // History navigation: the forward glyph is the back glyph mirrored, so
    // the pair reads as one timeline control rather than borrowing the
    // Continue icon (which used to make "forward" look like "resume").
    const historyGroup: ToolbarAction[] = [
        { label: 'Step back in history', icon: 'debug-step-back', tone: 'plain', disabled: !canStepBack, onClick: () => { host?.events?.emit('debug_step_back', {}); stepBack() } },
        { label: 'Step forward in history', icon: 'debug-step-back', iconClassName: '-scale-x-100', tone: 'plain', disabled: !canStepForward, onClick: () => { host?.events?.emit('debug_step_forward', {}); stepForward() } },
    ]
    const sessionGroup: ToolbarAction[] = [
        { label: 'Restart', shortcut: '⇧⌘F5', icon: 'debug-restart', tone: 'green', onClick: () => { void restart(true) } },
        { label: 'Stop', shortcut: '⇧F5', icon: 'debug-stop', tone: 'red', onClick: stop },
    ]

    const renderAction = (a: ToolbarAction) => (
        <Tooltip key={a.label}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label={a.label}
                    className={`nova-debug-toolbar-btn ${TONE_CLASS[a.tone]}`}
                    disabled={a.disabled}
                    onClick={a.onClick}
                >
                    <Codicon name={a.icon} size={16} className={a.iconClassName} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <p>
                    {a.label}
                    {a.shortcut && <kbd className="ml-1.5 text-[10px] opacity-60">{a.shortcut}</kbd>}
                </p>
            </TooltipContent>
        </Tooltip>
    )

    return (
        <div
            ref={pillRef}
            className="nova-debug-toolbar"
            style={posStyle}
            role="toolbar"
            aria-label="Debug controls"
            data-dragging={dragging || undefined}
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <div
                        {...gripHandlers}
                        role="button"
                        aria-label="Move debug toolbar (drag; double-click to reset)"
                        className={
                            'h-[26px] w-[14px] grid place-items-center select-none touch-none ' +
                            'text-muted-foreground hover:text-foreground ' +
                            (dragging ? 'cursor-grabbing' : 'cursor-grab')
                        }
                    >
                        <Codicon name="gripper" size={14} />
                    </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                    <p>Drag to move · double-click to reset</p>
                </TooltipContent>
            </Tooltip>

            <div className="nova-debug-toolbar-group">{liveGroup.map(renderAction)}</div>

            <div className="nova-debug-toolbar-group">
                {renderAction(historyGroup[0])}
                {!isAtLiveEdge && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span
                                className="px-1 text-[10px] tabular-nums font-medium text-amber-400 select-none"
                                aria-label={`Viewing history step ${stepIndex + 1} of ${stepHistory.length}`}
                            >
                                {stepIndex + 1}/{stepHistory.length}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            <p>
                                Viewing history step {stepIndex + 1} of {stepHistory.length} — step
                                forward to return to live execution
                            </p>
                        </TooltipContent>
                    </Tooltip>
                )}
                {renderAction(historyGroup[1])}
            </div>

            <div className="nova-debug-toolbar-group">{sessionGroup.map(renderAction)}</div>
        </div>
    )
}

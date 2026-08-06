import { create } from 'zustand'
import type {
    DebugPauseState,
    MemorySnapshot,
    StackFrame,
} from '@/web-ide/contracts/runtime'

export type DebugMode = 'idle' | 'compiling' | 'running' | 'paused'

const MAX_STEP_HISTORY = 250

export interface DebugState {
    debugMode: DebugMode
    currentLine: number | null
    currentFunc: string | null
    currentFile: string | null
    breakpoints: Record<string, number[]> // Map of file -> lines

    callStack: StackFrame[]
    memorySnapshot: MemorySnapshot | null

    stepHistory: DebugPauseState[]
    stepIndex: number

    setDebugMode: (mode: DebugMode) => void
    toggleBreakpoint: (file: string, line: number) => void
    // Replace one file's breakpoints with the engine-verified set (no-op if equal).
    setFileBreakpoints: (file: string, lines: number[]) => void
    pushHistoryState: (state: DebugPauseState) => void
    stepBack: () => void
    stepForward: () => void
    reset: () => void
}

export const useDebugStore = create<DebugState>((set, get) => ({
    debugMode: 'idle',
    currentLine: null,
    currentFunc: null,
    currentFile: null,
    breakpoints: {},
    callStack: [],
    memorySnapshot: null,
    stepHistory: [],
    stepIndex: -1,

    setDebugMode: (mode) => set({ debugMode: mode }),

    toggleBreakpoint: (file, line) => set((s) => {
        const fileBps = s.breakpoints[file] || []
        const nextBps = fileBps.includes(line) ? fileBps.filter(l => l !== line) : [...fileBps, line]
        return { breakpoints: { ...s.breakpoints, [file]: nextBps } }
    }),

    setFileBreakpoints: (file, lines) => {
        const current = [...(get().breakpoints[file] ?? [])].sort((a, b) => a - b)
        const next = [...new Set(lines)].sort((a, b) => a - b)
        // No-op on equal sets — the engine echoes validated lines back on
        // every sync, and an unconditional write here would re-trigger the
        // editor's breakpoint effect in a loop.
        if (current.length === next.length && current.every((v, i) => v === next[i])) return
        set((s) => ({ breakpoints: { ...s.breakpoints, [file]: next } }))
    },

    pushHistoryState: (state) => {
        const s = get()
        const history = s.stepIndex >= 0 ? s.stepHistory.slice(0, s.stepIndex + 1) : [...s.stepHistory]
        history.push(state)
        // Each entry carries the full callStack + heap snapshot, so an
        // infinite-loop bug can otherwise grow this array without bound.
        if (history.length > MAX_STEP_HISTORY) {
            history.splice(0, history.length - MAX_STEP_HISTORY)
        }
        set({
            stepHistory: history, stepIndex: -1,
            currentLine: state.line, currentFunc: state.func, currentFile: state.file,
            callStack: state.callStack, memorySnapshot: state.memorySnapshot, debugMode: 'paused'
        })
    },

    stepBack: () => {
        const s = get()
        if (s.stepHistory.length < 2 && s.stepIndex < 0) return
        if (s.stepHistory.length === 0) return
        const newIndex = s.stepIndex < 0 ? s.stepHistory.length - 2 : Math.max(0, s.stepIndex - 1)
        const entry = s.stepHistory[newIndex]
        if (entry) set({ stepIndex: newIndex, currentLine: entry.line, currentFunc: entry.func, currentFile: entry.file, callStack: entry.callStack, memorySnapshot: entry.memorySnapshot })
    },

    stepForward: () => {
        const s = get()
        if (s.stepIndex < 0) return
        const newIndex = s.stepIndex + 1
        const isLiveEdge = newIndex >= s.stepHistory.length - 1
        const entry = s.stepHistory[isLiveEdge ? s.stepHistory.length - 1 : newIndex]
        if (entry) set({ stepIndex: isLiveEdge ? -1 : newIndex, currentLine: entry.line, currentFunc: entry.func, currentFile: entry.file, callStack: entry.callStack, memorySnapshot: entry.memorySnapshot })
    },

    reset: () => set({ debugMode: 'idle', currentLine: null, currentFunc: null, currentFile: null, callStack: [], memorySnapshot: null, stepHistory: [], stepIndex: -1 }),
}))

if (import.meta.env.DEV && typeof window !== 'undefined') {
    // Console access for manual debugging / browser-driven tests in dev.
    // Importing '/src/store/debug-store.ts' from the console resolves to a
    // SECOND module instance (different from the app's aliased import), so
    // tests must use this handle instead of importing the module themselves.
    // ??= so a console-triggered duplicate evaluation can't clobber the
    // app's instance.
    const w = window as unknown as { __debugStore?: unknown }
    w.__debugStore ??= useDebugStore
}

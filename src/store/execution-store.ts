import { create } from 'zustand'

export type DrawCommand =
    | { type: 'CLEAR' }
    | { type: 'CIRCLE'; x: number; y: number; r: number; color: string }
    | { type: 'RECT'; x: number; y: number; w: number; h: number; color: string }

// Panel IDs are contributed by plugins; this is intentionally open-ended.
export type RightTab = string

interface ExecutionState {
    isCompiling: boolean
    isRunning: boolean
    rightTab: RightTab
    drawQueue: DrawCommand[]

    setIsCompiling: (v: boolean) => void
    setIsRunning: (v: boolean) => void
    setRightTab: (tab: RightTab) => void
    setDrawQueue: (q: DrawCommand[]) => void
}

export const useExecutionStore = create<ExecutionState>((set) => ({
    isCompiling: false,
    isRunning: false,
    rightTab: 'variables',
    drawQueue: [],

    setIsCompiling: (v) => set({ isCompiling: v }),
    setIsRunning: (v) => set({ isRunning: v }),
    setRightTab: (tab) => set({ rightTab: tab }),
    setDrawQueue: (q) => set({ drawQueue: q }),
}))

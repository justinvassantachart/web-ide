import { create } from 'zustand'

export type DrawCommand =
    | { type: 'CLEAR' }
    | { type: 'CIRCLE'; x: number; y: number; r: number; color: string }
    | { type: 'RECT'; x: number; y: number; w: number; h: number; color: string }

interface ExecutionState {
    isCompiling: boolean
    isRunning: boolean
    drawQueue: DrawCommand[]

    setIsCompiling: (v: boolean) => void
    setIsRunning: (v: boolean) => void
    setDrawQueue: (q: DrawCommand[]) => void
}

export const useExecutionStore = create<ExecutionState>((set) => ({
    isCompiling: false,
    isRunning: false,
    drawQueue: [],

    setIsCompiling: (v) => set({ isCompiling: v }),
    setIsRunning: (v) => set({ isRunning: v }),
    setDrawQueue: (q) => set({ drawQueue: q }),
}))

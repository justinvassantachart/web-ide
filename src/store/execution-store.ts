import { create } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

export type DrawCommand =
    | { type: 'CLEAR' }
    | { type: 'CIRCLE'; x: number; y: number; r: number; color: string }
    | { type: 'RECT'; x: number; y: number; w: number; h: number; color: string }

export interface ExecutionState {
    isCompiling: boolean
    isRunning: boolean
    drawQueue: DrawCommand[]

    setIsCompiling: (v: boolean) => void
    setIsRunning: (v: boolean) => void
    setDrawQueue: (q: DrawCommand[]) => void
}

const createExecutionState = (set: StoreApi<ExecutionState>['setState']): ExecutionState => ({
    isCompiling: false,
    isRunning: false,
    drawQueue: [],

    setIsCompiling: (v) => set({ isCompiling: v }),
    setIsRunning: (v) => set({ isRunning: v }),
    setDrawQueue: (q) => set({ drawQueue: q }),
})

/** Creates run state owned by one Web IDE mount. */
export function createExecutionStore(): StoreApi<ExecutionState> {
    return createStore<ExecutionState>(createExecutionState)
}

/** Legacy singleton retained for source compatibility outside mounted WebIDE components. */
export const useExecutionStore = create<ExecutionState>((set) => createExecutionState(set))

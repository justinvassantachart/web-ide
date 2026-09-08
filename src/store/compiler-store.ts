import { create } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

type CacheState = 'idle' | 'downloading' | 'ready' | 'error'

export interface CompilerState {
    cacheState: CacheState
    downloadProgress: number // 0–100
    errorMessage: string | null

    setCacheState: (s: CacheState) => void
    setDownloadProgress: (p: number) => void
    setErrorMessage: (m: string | null) => void
}

const createCompilerState = (set: StoreApi<CompilerState>['setState']): CompilerState => ({
    // The debugger-sh package handles its own WASM loading internally on
    // the first Engine.create() call, so no explicit preload pass is needed.
    cacheState: 'ready',
    downloadProgress: 100,
    errorMessage: null,

    setCacheState: (s) => set({ cacheState: s }),
    setDownloadProgress: (p) => set({ downloadProgress: p }),
    setErrorMessage: (m) => set({ errorMessage: m }),
})

/** Creates compiler-status state owned by one Web IDE mount. */
export function createCompilerStore(): StoreApi<CompilerState> {
    return createStore<CompilerState>(createCompilerState)
}

/** Legacy singleton retained for source compatibility outside mounted WebIDE components. */
export const useCompilerStore = create<CompilerState>((set) => createCompilerState(set))

import { create } from 'zustand'

type CacheState = 'idle' | 'downloading' | 'ready' | 'error'

interface CompilerState {
    cacheState: CacheState
    downloadProgress: number // 0–100
    errorMessage: string | null

    setCacheState: (s: CacheState) => void
    setDownloadProgress: (p: number) => void
    setErrorMessage: (m: string | null) => void
}

export const useCompilerStore = create<CompilerState>((set) => ({
    // The debugger-sh package handles its own WASM loading internally on
    // the first Engine.create() call, so no explicit preload pass is needed.
    cacheState: 'ready',
    downloadProgress: 100,
    errorMessage: null,

    setCacheState: (s) => set({ cacheState: s }),
    setDownloadProgress: (p) => set({ downloadProgress: p }),
    setErrorMessage: (m) => set({ errorMessage: m }),
}))

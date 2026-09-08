import { create } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

export interface VFSNode {
    name: string
    path: string
    isDirectory: boolean
    children?: VFSNode[]
}

export interface FilesState {
    files: VFSNode[]
    setFiles: (files: VFSNode[]) => void
    // Track which directories are expanded
    expandedDirs: Set<string>
    toggleDir: (path: string) => void
    expandDir: (path: string) => void
    renameExpandedPath: (from: string, to: string) => void
    pruneExpandedDirs: (exists: (path: string) => boolean) => void
}

const createFilesState = (set: StoreApi<FilesState>['setState']): FilesState => ({
    files: [],
    setFiles: (files) => set({ files }),
    expandedDirs: new Set<string>(),
    toggleDir: (path) =>
        set((s) => {
            const next = new Set(s.expandedDirs)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return { expandedDirs: next }
        }),
    expandDir: (path) =>
        set((s) => {
            const next = new Set(s.expandedDirs)
            next.add(path)
            return { expandedDirs: next }
        }),
    renameExpandedPath: (from, to) =>
        set((state) => {
            const next = new Set<string>()
            let changed = false
            for (const path of state.expandedDirs) {
                if (path === from || path.startsWith(`${from}/`)) {
                    next.add(`${to}${path.slice(from.length)}`)
                    changed = true
                } else {
                    next.add(path)
                }
            }
            return changed ? { expandedDirs: next } : state
        }),
    pruneExpandedDirs: (exists) =>
        set((state) => {
            const next = new Set([...state.expandedDirs].filter(exists))
            return next.size === state.expandedDirs.size ? state : { expandedDirs: next }
        }),
})

/** Creates Explorer state owned by one Web IDE mount. */
export function createFilesStore(): StoreApi<FilesState> {
    return createStore<FilesState>(createFilesState)
}

/** Legacy singleton retained for source compatibility outside mounted WebIDE components. */
export const useFilesStore = create<FilesState>((set) => createFilesState(set))

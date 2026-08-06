import { create } from 'zustand'

export interface VFSNode {
    name: string
    path: string
    isDirectory: boolean
    children?: VFSNode[]
}

interface FilesState {
    files: VFSNode[]
    setFiles: (files: VFSNode[]) => void
    // Track which directories are expanded
    expandedDirs: Set<string>
    toggleDir: (path: string) => void
    expandDir: (path: string) => void
}

export const useFilesStore = create<FilesState>((set) => ({
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
}))

import { create } from 'zustand'

interface EditorState {
    activeFile: string | null
    activeFileContent: string
    // Open editor tabs, in visual order. Every activeFile is also in here.
    openFiles: string[]
    // 1-based caret position mirrored from Monaco for the status bar.
    cursorLine: number
    cursorColumn: number
    setActiveFile: (path: string, content: string) => void
    // Add a tab WITHOUT changing focus (no-op if already open). For
    // programmatic tab management by hosts — e.g. a guided activity keeping its
    // files reachable while the explorer is hidden.
    openFile: (path: string) => void
    setActiveFileContent: (content: string) => void
    // Close one tab. If it was active, focus its right neighbor (else left),
    // matching VS Code's tab-close behavior.
    closeFile: (path: string, readContent: (path: string) => string | null) => void
    // Drop tabs whose files no longer exist (rename/delete sweeps).
    pruneTabs: (exists: (path: string) => boolean, readContent: (path: string) => string | null) => void
    // Keep a tab's position when its file is renamed.
    renameOpenFile: (oldPath: string, newPath: string) => void
    setCursor: (line: number, column: number) => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
    activeFile: null,
    activeFileContent: '',
    openFiles: [],
    cursorLine: 1,
    cursorColumn: 1,

    setActiveFile: (path, content) => set((s) => ({
        activeFile: path,
        activeFileContent: content,
        openFiles: s.openFiles.includes(path) ? s.openFiles : [...s.openFiles, path],
    })),

    openFile: (path) => set((s) => (
        s.openFiles.includes(path) ? s : { openFiles: [...s.openFiles, path] }
    )),

    setActiveFileContent: (content) => set({ activeFileContent: content }),

    closeFile: (path, readContent) => {
        const s = get()
        const idx = s.openFiles.indexOf(path)
        if (idx === -1) return
        const openFiles = s.openFiles.filter((p) => p !== path)
        if (s.activeFile !== path) {
            set({ openFiles })
            return
        }
        const next = openFiles[idx] ?? openFiles[idx - 1] ?? null
        set({
            openFiles,
            activeFile: next,
            activeFileContent: next ? (readContent(next) ?? '') : '',
        })
    },

    pruneTabs: (exists, readContent) => {
        const s = get()
        const openFiles = s.openFiles.filter(exists)
        if (openFiles.length === s.openFiles.length) return
        if (s.activeFile && exists(s.activeFile)) {
            set({ openFiles })
            return
        }
        const next = openFiles[openFiles.length - 1] ?? null
        set({
            openFiles,
            activeFile: next,
            activeFileContent: next ? (readContent(next) ?? '') : '',
        })
    },

    renameOpenFile: (oldPath, newPath) => set((s) => ({
        openFiles: s.openFiles.map((p) => (p === oldPath ? newPath : p)),
        activeFile: s.activeFile === oldPath ? newPath : s.activeFile,
    })),

    setCursor: (line, column) => set({ cursorLine: line, cursorColumn: column }),
}))

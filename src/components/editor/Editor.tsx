import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useRef, useEffect, useLayoutEffect, useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { EditorTabs } from './EditorTabs'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { useLanguageTooling } from '@/web-ide/react/language-tooling-context'
import { EDIT_CONTENT_CAP } from '@/web-ide/core/constants'
import { useThemeStore } from '@/theme/theme-store'
import { DebugToolbar } from '@/components/layout/DebugToolbar'
import { useSafeMonaco } from '@/lib/use-monaco'
import { monacoLanguageForPath } from '@/web-ide/core/monaco-language'
import { useSourcePresentationState } from '@/web-ide/react/source-presentation-state'
import {
    useWorkbenchDebugStore,
    useWorkbenchEditorStore,
    useWorkbenchInstance,
} from '@/web-ide/react/workbench-instance-context'

// Decorations are tracked per file URI so they survive model switching — when
// the user flips between files we leave each model's gutter/line state intact
// rather than re-running every effect against a stale, file-A-shaped set.
type DecoIds = { bp: string[]; step: string[]; source: string[] }

export function Editor() {
    const { activeFile, activeFileContent, setActiveFile } = useWorkbenchEditorStore()
    const { currentLine, currentFile, debugMode, breakpoints, toggleBreakpoint } = useWorkbenchDebugStore()
    const instance = useWorkbenchInstance()
    const { workspace } = instance
    const monaco = useSafeMonaco()
    const theme = useThemeStore((s) => s.theme)
    const engine = useEngine()
    const host = useIDEHost()
    const readOnly = host?.workspace?.readOnly === true
    const languageTooling = useLanguageTooling()
    const { snapshot: sourcePresentation, revealRequest } = useSourcePresentationState()
    const languageToolingRef = useRef(languageTooling)
    const lastEditEmit = useRef<Record<string, number>>({})
    const editTrailing = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
    const suppressedModelPaths = useRef(new Set<string>())
    const acceptedBreakpoints = useRef<Record<string, number[]>>({})
    const breakpointSyncTokens = useRef<Record<string, number>>({})

    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
    const decoIdsByPath = useRef<Map<string, DecoIds>>(new Map())
    const ghostIdsRef = useRef<string[]>([])
    const [editorReady, setEditorReady] = useState(false)
    const pendingModelDisposal = useRef<{ cancelled: boolean } | undefined>(undefined)

    useLayoutEffect(() => {
        languageToolingRef.current = languageTooling
    }, [languageTooling])

    const lastDebugState = useRef({ file: null as string | null, line: null as number | null })
    const lastSourceReveal = useRef(0)

    // Keep Monaco's per-URI model cache in sync with the editor store.
    // Monaco models are global state — when the workspace gets re-seeded
    // (e.g. switching student submissions, where both happen to use the
    // same file paths), the cached model would otherwise still hold the
    // previous workspace's content even after `setActiveFile` updates the
    // store. We only call setValue when the model already exists and is
    // out of sync, which leaves the normal user-typing path untouched
    // (model is already equal to activeFileContent at that point).
    useEffect(() => {
        if (!monaco || !activeFile) return
        const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(activeFile)))
        if (!model) return
        if (model.getValue() === activeFileContent) return
        model.setValue(activeFileContent)
    }, [activeFile, activeFileContent, monaco, workspace])

    // Dispose Monaco models for files that no longer exist in the VFS.
    // Monaco caches one ITextModel per URI for the lifetime of the editor
    // instance — without an explicit sweep, every file ever opened (or
    // every starter-file path across every assignment the user visits)
    // accumulates in memory, since the model holds the full text buffer
    // plus tokenization state. The workspace-change event fires on every
    // VFS mutation, including the initVFS re-bootstrap when assignments
    // switch, so this runs at the right moments without extra plumbing.
    useEffect(() => {
        if (!monaco) return
        if (pendingModelDisposal.current) {
            pendingModelDisposal.current.cancelled = true
            pendingModelDisposal.current = undefined
        }
        const synchronizeOwnedModels = (change: Parameters<typeof workspace.subscribe>[0] extends (change: infer T) => void ? T : never) => {
            const affected = new Set<string>()
            let replaceAll = false
            for (const operation of change.operations) {
                if (operation.op === 'replace') replaceAll = true
                else if (operation.op === 'rename') {
                    affected.add(operation.from)
                    affected.add(operation.to)
                } else affected.add(operation.path)
            }
            const cancelEveryAffectedPath = change.origin.kind !== 'local-user'
            const timerPaths = replaceAll
                ? Object.keys(editTrailing.current)
                : cancelEveryAffectedPath
                    ? [...affected]
                    : change.operations.flatMap((operation) =>
                        operation.op === 'delete'
                            ? [operation.path]
                            : operation.op === 'rename'
                                ? [operation.from, operation.to]
                                : [],
                    )
            for (const path of timerPaths) {
                clearTimeout(editTrailing.current[path])
                delete editTrailing.current[path]
                delete lastEditEmit.current[path]
            }
            const files = workspace.snapshot()
            for (const model of monaco.editor.getModels()) {
                const path = model.uri.path
                if (!workspace.ownsMonacoUri(model.uri)) continue
                if (!replaceAll && !affected.has(path)) continue
                const next = files[path]
                if (next === undefined) {
                    model.dispose()
                    decoIdsByPath.current.delete(path)
                    continue
                }
                if (model.getValue() === next) continue
                suppressedModelPaths.current.add(path)
                try {
                    model.setValue(next)
                } finally {
                    suppressedModelPaths.current.delete(path)
                }
            }
            // Tabs for deleted/renamed files close with their models.
            instance.editorStore.getState().pruneTabs(
                (path) => workspace.fileExists(path),
                (path) => workspace.fileExists(path) ? workspace.readFile(path) : null,
            )
        }
        const unsubscribe = workspace.subscribe(synchronizeOwnedModels)
        return () => {
            unsubscribe()
            const ticket = { cancelled: false }
            pendingModelDisposal.current = ticket
            queueMicrotask(() => {
                if (ticket.cancelled) return
                for (const model of monaco.editor.getModels()) {
                    if (workspace.ownsMonacoUri(model.uri)) model.dispose()
                }
            })
        }
    }, [instance, monaco, workspace])

    useEffect(() => {
        if (debugMode === 'paused' && currentFile && currentLine !== null) {
            const stepped = lastDebugState.current.file !== currentFile || lastDebugState.current.line !== currentLine
            if (stepped) {
                lastDebugState.current = { file: currentFile, line: currentLine }
                if (currentFile !== instance.editorStore.getState().activeFile) {
                    if (workspace.fileExists(currentFile)) setActiveFile(currentFile, workspace.readFile(currentFile))
                }
            }
        } else if (debugMode !== 'paused') {
            lastDebugState.current = { file: null, line: null }
        }
    }, [debugMode, currentFile, currentLine, instance, setActiveFile, workspace])

    const getDecoIds = (path: string): DecoIds => {
        let entry = decoIdsByPath.current.get(path)
        if (!entry) {
            entry = { bp: [], step: [], source: [] }
            decoIdsByPath.current.set(path, entry)
        }
        return entry
    }

    const handleMount: OnMount = (editorInstance, monacoInstance) => {
        editorRef.current = editorInstance

        // Let the optional selected tooling provider lazily start when the
        // user engages with a supported file. Monaco owns these listeners.
        const armLanguageTooling = () => {
            const path = instance.editorStore.getState().activeFile
            if (path) languageToolingRef.current.arm(path)
        }
        editorInstance.onDidFocusEditorWidget(armLanguageTooling)
        editorInstance.onKeyDown(armLanguageTooling)

        // Breakpoints toggle on the glyph margin ONLY — in VS Code, clicking
        // a line number selects the line, and mixing the two makes mis-clicks
        // set surprise breakpoints.
        editorInstance.onMouseDown((e: editor.IEditorMouseEvent) => {
            if (!e.target || !e.target.position) return
            const MouseTargetType = monacoInstance.editor.MouseTargetType

            if (e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN) {
                if (!engine.capabilities.breakpoints) return
                const line = e.target.position.lineNumber
                const file = instance.editorStore.getState().activeFile
                if (line && file) {
                    toggleBreakpoint(file, line)
                    const on = (instance.debugStore.getState().breakpoints[file] ?? []).includes(line)
                    host?.events?.emit('breakpoint_toggle', { file, line, on })
                }
            }
        })

        editorInstance.onMouseMove((e: editor.IEditorMouseEvent) => {
            if (!e.target || !e.target.position) return
            const model = editorInstance.getModel()
            if (!model) return
            const MouseTargetType = monacoInstance.editor.MouseTargetType
            const isGutter = e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN

            if (isGutter) {
                if (!engine.capabilities.breakpoints) return
                const line = e.target.position.lineNumber
                const file = instance.editorStore.getState().activeFile
                const bps = instance.debugStore.getState().breakpoints
                const fileBps = file ? bps[file] || [] : []

                if (!fileBps.includes(line)) {
                    ghostIdsRef.current = model.deltaDecorations(ghostIdsRef.current, [{
                        range: new monacoInstance.Range(line, 1, line, 1),
                        options: { isWholeLine: false, glyphMarginClassName: 'breakpoint-ghost' },
                    }])
                    return
                }
            }
            ghostIdsRef.current = model.deltaDecorations(ghostIdsRef.current, [])
        })

        editorInstance.onMouseLeave(() => {
            const model = editorInstance.getModel()
            if (model) ghostIdsRef.current = model.deltaDecorations(ghostIdsRef.current, [])
        })

        // F9 toggles a breakpoint on the cursor's line, like VS Code.
        editorInstance.addCommand(monacoInstance.KeyCode.F9, () => {
            if (!engine.capabilities.breakpoints) return
            const line = editorInstance.getPosition()?.lineNumber
            const file = instance.editorStore.getState().activeFile
            if (line && file) {
                instance.debugStore.getState().toggleBreakpoint(file, line)
                const on = (instance.debugStore.getState().breakpoints[file] ?? []).includes(line)
                host?.events?.emit('breakpoint_toggle', { file, line, on })
            }
        })

        // Mirror the caret into the store for the status bar's Ln/Col.
        editorInstance.onDidChangeCursorPosition((e) => {
            instance.editorStore.getState().setCursor(e.position.lineNumber, e.position.column)
        })

        setEditorReady(true)
    }

    // Sync breakpoint decorations onto every known model (so toggling lines in
    // file A while viewing file B still updates A's gutter), then push the
    // currently active file's set to the engine.
    useEffect(() => {
        if (!monaco || !editorReady || !engine.capabilities.breakpoints) return

        for (const [path, lines] of Object.entries(breakpoints)) {
            const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(path)))
            if (!model) continue
            const decos = (lines ?? []).map((line) => ({
                range: new monaco.Range(line, 1, line, 1),
                options: { isWholeLine: false, glyphMarginClassName: 'breakpoint-dot' },
            }))
            const ids = getDecoIds(path)
            ids.bp = model.deltaDecorations(ids.bp, decos)
        }

        if (activeFile) {
            const file = activeFile
            const requested = [...(breakpoints[file] ?? [])]
            const token = (breakpointSyncTokens.current[file] ?? 0) + 1
            breakpointSyncTokens.current[file] = token
            engine.setBreakpoints(file, requested).then(() => {
                if (breakpointSyncTokens.current[file] === token) {
                    acceptedBreakpoints.current[file] = requested
                }
            }).catch((error: unknown) => {
                console.warn(error)
                if (breakpointSyncTokens.current[file] !== token) return
                instance.debugStore.getState().setFileBreakpoints(
                    file,
                    acceptedBreakpoints.current[file] ?? [],
                )
            })
        }
    }, [activeFile, breakpoints, editorReady, engine, instance, monaco, workspace])

    // Step indicator: paint the paused line on its own model, clear everywhere
    // else. Reveal the line only when the user is actively viewing that file.
    useEffect(() => {
        if (!monaco || !editorReady) return

        // Clear stale paused-line decorations everywhere — including
        // currentFile itself when the session is no longer paused, so the
        // yellow arrow doesn't linger after the program exits mid-pause.
        for (const [path, ids] of decoIdsByPath.current.entries()) {
            if (path === currentFile && debugMode === 'paused') continue
            if (ids.step.length === 0) continue
            const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(path)))
            if (model) ids.step = model.deltaDecorations(ids.step, [])
            else ids.step = []
        }

        if (debugMode === 'paused' && currentFile && currentLine !== null) {
            const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(currentFile)))
            if (model) {
                const ids = getDecoIds(currentFile)
                ids.step = model.deltaDecorations(ids.step, [{
                    range: new monaco.Range(currentLine, 1, currentLine, 1),
                    options: {
                        isWholeLine: true,
                        className: 'debug-line-highlight',
                        glyphMarginClassName: 'debug-paused-glyph',
                    },
                }])
                if (currentFile === activeFile) {
                    editorRef.current?.revealLineInCenter(currentLine)
                }
            }
        }
    }, [activeFile, currentFile, currentLine, debugMode, editorReady, monaco, workspace])

    // Render owner-scoped plugin decorations without exposing Monaco or this
    // per-file identifier map through the public contribution API.
    useEffect(() => {
        if (!monaco || !editorReady) return

        const byPath = new Map<
            string,
            Array<(typeof sourcePresentation.decorations)[number]>
        >()
        for (const decoration of sourcePresentation.decorations) {
            let existing = byPath.get(decoration.path)
            if (!existing) {
                existing = []
                byPath.set(decoration.path, existing)
            }
            existing.push(decoration)
        }
        const paths = new Set([...decoIdsByPath.current.keys(), ...byPath.keys()])

        for (const path of paths) {
            const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(path)))
            if (!model) continue
            const ids = getDecoIds(path)
            const decorations = (byPath.get(path) ?? []).flatMap((decoration) => {
                if (decoration.line > model.getLineCount()) return []
                const maxColumn = model.getLineMaxColumn(decoration.line)
                if (decoration.column !== undefined && decoration.column > maxColumn) return []
                const column = decoration.column ?? 1
                const classSuffix = `source-presentation-${decoration.kind}`
                return [{
                    range: new monaco.Range(
                        decoration.line,
                        column,
                        decoration.line,
                        column,
                    ),
                    options: {
                        isWholeLine: true,
                        className: `${classSuffix}-line`,
                        glyphMarginClassName: `${classSuffix}-glyph`,
                    },
                }]
            })
            ids.source = model.deltaDecorations(ids.source, decorations)
        }
    }, [activeFile, editorReady, monaco, sourcePresentation, workspace])

    useEffect(() => {
        const decorations = decoIdsByPath.current
        return () => {
            if (!monaco) return
            for (const [path, ids] of decorations.entries()) {
                if (ids.source.length === 0) continue
                const model = monaco.editor.getModel(monaco.Uri.parse(workspace.toMonacoUri(path)))
                if (model) ids.source = model.deltaDecorations(ids.source, [])
                else ids.source = []
            }
        }
    }, [monaco, workspace])

    // A reveal request is distinct from a decoration update. Repeated reveals
    // of the same location still move the caret and center that exact source.
    useEffect(() => {
        if (
            !editorReady
            || !revealRequest
            || revealRequest.sequence === lastSourceReveal.current
            || activeFile !== revealRequest.location.path
        ) return

        const editorInstance = editorRef.current
        const model = editorInstance?.getModel()
        if (!editorInstance || !model || model.uri.path !== revealRequest.location.path) return

        const lineNumber = Math.min(revealRequest.location.line, model.getLineCount())
        const column = Math.min(
            revealRequest.location.column ?? 1,
            model.getLineMaxColumn(lineNumber),
        )
        lastSourceReveal.current = revealRequest.sequence
        editorInstance.setPosition({ lineNumber, column })
        editorInstance.revealPositionInCenter({ lineNumber, column })
        editorInstance.focus()
    }, [activeFile, editorReady, revealRequest])

    const handleChange = useCallback((value: string | undefined) => {
        if (value === undefined || !activeFile) return
        if (suppressedModelPaths.current.has(activeFile)) return
        // A controller-driven model update (restore/external authority) fires
        // Monaco's onChange callback too. Equal VFS content is that update's
        // acknowledgement, not a new local-user transaction.
        if (workspace.fileExists(activeFile) && workspace.readFile(activeFile) === value) return
        try {
            // The workspace controller owns both the VFS commit and editor-store
            // reconciliation. A denied/invalid edit must not update either one.
            workspace.writeLocal(activeFile, value)
        } catch (error) {
            const committed = workspace.fileExists(activeFile)
                ? workspace.readFile(activeFile)
                : ''
            const model = editorRef.current?.getModel()
            if (model && model.getValue() !== committed) model.setValue(committed)
            console.warn('[web-ide] local workspace edit rejected', error)
            return
        }

        // Leading + trailing throttle (1s window). The leading emit gives
        // hosts periodic snapshots during a long typing burst; the trailing
        // emit guarantees the burst's FINAL content is captured — without
        // it, a recorded session would end on a stale mid-burst snapshot.
        const emitEdit = (file: string, content: string) => {
            lastEditEmit.current[file] = Date.now()
            host?.events?.emit('edit', {
                file,
                length: content.length,
                content: content.length > EDIT_CONTENT_CAP
                    ? content.slice(0, EDIT_CONTENT_CAP)
                    : content,
                truncated: content.length > EDIT_CONTENT_CAP || undefined,
            })
        }
        const now = Date.now()
        const last = lastEditEmit.current[activeFile] ?? 0
        clearTimeout(editTrailing.current[activeFile])
        if (now - last >= 1000) {
            emitEdit(activeFile, value)
        } else {
            // Rescheduled on every keystroke, so the timer that finally
            // fires always carries the burst's newest content.
            editTrailing.current[activeFile] = setTimeout(
                () => emitEdit(activeFile, value),
                1000 - (now - last),
            )
        }
    }, [activeFile, host, workspace])

    // Pending trailing edit-emits must not outlive the editor (the host
    // callback would fire against an unmounted surface).
    useEffect(() => {
        const timers = editTrailing.current
        return () => { for (const t of Object.values(timers)) clearTimeout(t) }
    }, [])

    if (!activeFile) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                <Codicon name="file" size={40} />
                <p className="text-sm">Select a file to start editing</p>
            </div>
        )
    }

    const lang = monacoLanguageForPath(activeFile)

    return (
        <div className="h-full overflow-hidden bg-background flex flex-col">
            <EditorTabs />
            {/* `path` makes Monaco keep one ITextModel per file (including its
                content and undo history). We disable the wrapper's module-global
                path-keyed view-state cache: it crosses IDE instances and can
                restore a canceled contribution while source playback switches
                models. Explicit debug/source reveals own navigation instead. We pass
                `defaultValue` for first-time model creation but deliberately
                omit `value` — passing it would re-fire executeEdits on every
                store update and wipe undo. The model is the source of truth. */}
            <div className="flex-1 min-h-0 relative">
                <DebugToolbar />
                <MonacoEditor
                    height="100%"
                    path={workspace.toMonacoUri(activeFile)}
                    saveViewState={false}
                    defaultValue={activeFileContent}
                    language={lang}
                    theme={theme === 'light' ? 'vs' : 'vs-dark'}
                    onChange={handleChange}
                    onMount={handleMount}
                    options={{
                        glyphMargin:
                            engine.capabilities.breakpoints
                            || sourcePresentation.decorations.length > 0,
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: 14, lineHeight: 22,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        padding: { top: 8 },
                        renderLineHighlight: 'line',
                        smoothScrolling: true,
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on',
                        tabSize: 4, automaticLayout: true,
                        readOnly,
                    }}
                />
            </div>
        </div>
    )
}

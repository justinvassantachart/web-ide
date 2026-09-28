import type * as monaco from 'monaco-editor'
import type { IDEEditorModelNamespace } from '@/web-ide/contracts/language-tooling'
import type { ClangdClient } from './ClangdClient'
import { isCppPath, toClangdUri } from './config'
import type { PrepareRenameResult, Range, TextEdit, WorkspaceEdit } from './lsp-types'

export interface RenameWorkspace {
    snapshot(): Record<string, string>
    canWrite(path: string): boolean
    write(path: string, content: string): void
}

type Monaco = typeof monaco
type Snapshot = Map<string, { content: string; persistedContent: string; model?: monaco.editor.ITextModel; version?: number }>

function editablePath(path: string): boolean {
    return path.startsWith('/workspace/') && isCppPath(path)
        && !path.split('/').slice(1).some((part) => !part || part === '.' || part === '..')
}

function rangeToMonaco(ns: Monaco, range: Range): monaco.Range {
    return new ns.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)
}

function validateEdits(content: string, edits: TextEdit[]): void {
    const lines = content.split(/\r?\n/)
    const offset = (position: Range['start']) => {
        if (!Number.isInteger(position.line) || !Number.isInteger(position.character)
            || position.line < 0 || position.line >= lines.length
            || position.character < 0 || position.character > lines[position.line].length) {
            throw new Error('The language server returned an invalid rename range.')
        }
        return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character
    }
    const spans = edits.map((edit) => {
        if (typeof edit.newText !== 'string') throw new Error('The language server returned an invalid rename edit.')
        const start = offset(edit.range.start)
        const end = offset(edit.range.end)
        if (end < start) throw new Error('The language server returned a reversed rename range.')
        return { start, end }
    }).sort((a, b) => a.start - b.start || a.end - b.end)
    if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].end)) {
        throw new Error('The language server returned overlapping rename edits.')
    }
}

/** Native Monaco rename, constrained to existing editable workspace files. */
export function createRenameProvider(
    ns: Monaco,
    client: ClangdClient,
    workspace: RenameWorkspace,
    modelNamespace?: IDEEditorModelNamespace,
) {
    const subscriptions = new Map<monaco.editor.ITextModel, monaco.IDisposable>()
    const createdModels = new Set<monaco.editor.ITextModel>()
    let disposed = false
    const ownsModel = (model: monaco.editor.ITextModel) => model.uri.scheme === 'file'
        && !model.uri.query && !model.uri.fragment
        && (modelNamespace?.owns(model.uri) ?? !model.uri.authority)

    function assertWritable(path: string): void {
        if (!workspace.canWrite(path)) throw new Error('Rename would change a read-only workspace file.')
    }

    function snapshot(): Snapshot {
        const files = workspace.snapshot()
        const models = ns.editor.getModels()
        return new Map(Object.entries(files).filter(([path]) => editablePath(path)).map(([path, content]) => {
            const model = models.find((candidate) => ownsModel(candidate) && candidate.uri.path === path)
            // Inactive Monaco models can outlive workspace reloads. Refusing a
            // stale model is safer than overwriting newer saved header text or
            // silently replacing unsaved model content before a refactoring.
            if (model && model.getValue() !== content) {
                throw new Error('The workspace changed outside the editor. Reopen the changed files before renaming.')
            }
            return [path, { content, persistedContent: content, model, version: model?.getVersionId() }]
        }))
    }

    function assertCurrent(before: Snapshot): void {
        const current = snapshot()
        if (disposed || before.size !== current.size || [...before].some(([path, prior]) => {
            const now = current.get(path)
            return !now || now.content !== prior.content || now.persistedContent !== prior.persistedContent
                || now.model !== prior.model || now.version !== prior.version
        })) throw new Error('The workspace changed while renaming. Try again.')
    }

    function watch(model: monaco.editor.ITextModel): void {
        if (subscriptions.has(model)) return
        // Monaco applies edits to inactive models too. Persist every affected
        // model, including subsequent undo/redo, through the ordinary VFS path.
        let restoring = false
        const changed = model.onDidChangeContent(() => {
            if (restoring) return
            const files = workspace.snapshot()
            if (Object.hasOwn(files, model.uri.path) && files[model.uri.path] !== model.getValue()) {
                try {
                    assertWritable(model.uri.path)
                    workspace.write(model.uri.path, model.getValue())
                } catch {
                    // A host may revoke local edit permission after Monaco
                    // receives the edit. Keep the canonical workspace intact.
                    const committed = workspace.snapshot()[model.uri.path]
                    if (committed !== undefined && committed !== model.getValue()) {
                        restoring = true
                        try { model.setValue(committed) } finally { restoring = false }
                    }
                }
            }
        })
        const closed = model.onWillDispose(() => {
            changed.dispose()
            closed.dispose()
            subscriptions.delete(model)
            createdModels.delete(model)
        })
        subscriptions.set(model, { dispose() { changed.dispose(); closed.dispose() } })
    }

    async function request<T>(method: string, params: unknown, token: monaco.CancellationToken): Promise<T> {
        const controller = new AbortController()
        const listener = token.onCancellationRequested(() => controller.abort())
        try {
            if (token.isCancellationRequested || disposed) throw new Error('Rename cancelled.')
            const result = await client.request<T>(method, params, controller.signal)
            if (token.isCancellationRequested || disposed) throw new Error('Rename cancelled.')
            return result
        } finally {
            listener.dispose()
        }
    }

    const provider: monaco.languages.RenameProvider = {
        async resolveRenameLocation(model, position, token) {
            if (modelNamespace && !ownsModel(model)) return undefined
            const fallback = new ns.Range(position.lineNumber, position.column, position.lineNumber, position.column)
            try {
                const before = snapshot()
                if (before.get(model.uri.path)?.model !== model) throw new Error('Only workspace source files can be renamed.')
                assertWritable(model.uri.path)
                const result = await request<PrepareRenameResult | null>('textDocument/prepareRename', {
                    textDocument: { uri: toClangdUri(model.uri.path) },
                    position: { line: position.lineNumber - 1, character: position.column - 1 },
                }, token)
                assertCurrent(before)
                if (!result) throw new Error('This symbol cannot be renamed.')
                if ('defaultBehavior' in result) {
                    const word = model.getWordAtPosition(position)
                    if (!word) throw new Error('Select a symbol to rename.')
                    return { range: new ns.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word }
                }
                const range = 'range' in result ? result.range : result
                validateEdits(model.getValue(), [{ range, newText: '' }])
                const converted = rangeToMonaco(ns, range)
                return { range: converted, text: 'placeholder' in result ? result.placeholder : model.getValueInRange(converted) }
            } catch (error) {
                return { range: fallback, text: '', rejectReason: error instanceof Error ? error.message : 'Rename unavailable.' }
            }
        },
        async provideRenameEdits(model, position, newName, token) {
            if (modelNamespace && !ownsModel(model)) return undefined
            try {
                const before = snapshot()
                if (before.get(model.uri.path)?.model !== model) throw new Error('Only workspace source files can be renamed.')
                assertWritable(model.uri.path)
                // Flush unopened headers before the request; open documents are
                // already kept current by didChange notifications.
                client.writeFiles(Object.fromEntries([...before].map(([path, entry]) => [path, entry.content])))
                const result = await request<WorkspaceEdit | null>('textDocument/rename', {
                    textDocument: { uri: toClangdUri(model.uri.path) },
                    position: { line: position.lineNumber - 1, character: position.column - 1 },
                    newName,
                }, token)
                assertCurrent(before)
                if (!result) throw new Error('This symbol cannot be renamed.')
                const changes = result.documentChanges ?? Object.entries(result.changes ?? {}).map(([uri, edits]) => ({
                    textDocument: { uri, version: null }, edits,
                }))
                const seen = new Set<string>()
                // Validate the whole response before creating any models or
                // applying edits. Resource operations and support files are out
                // of scope for symbol rename and must never partially apply.
                const validated = changes.map((change) => {
                    if ('kind' in change) throw new Error('Rename cannot create, move, or delete files.')
                    const uri = ns.Uri.parse(change.textDocument.uri)
                    const entry = before.get(uri.path)
                    if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !editablePath(uri.path) || !entry) {
                        throw new Error('Rename would change a file outside this workspace.')
                    }
                    assertWritable(uri.path)
                    if (seen.has(uri.path)) throw new Error('The language server returned duplicate document edits.')
                    seen.add(uri.path)
                    const version = change.textDocument.version
                    if (version !== null && version !== entry.version) throw new Error('The rename result is out of date. Try again.')
                    validateEdits(entry.content, change.edits)
                    return { path: uri.path, entry, edits: change.edits }
                })
                const edits: monaco.languages.IWorkspaceTextEdit[] = []
                for (const change of validated) {
                    if (change.edits.length === 0) continue
                    let target = change.entry.model
                    if (!target) {
                        target = ns.editor.createModel(change.entry.content, 'cpp', ns.Uri.parse(modelNamespace?.toUri(change.path) ?? toClangdUri(change.path)))
                        createdModels.add(target)
                    }
                    watch(target)
                    for (const edit of change.edits) edits.push({
                        resource: target.uri,
                        versionId: target.getVersionId(),
                        textEdit: { range: rangeToMonaco(ns, edit.range), text: edit.newText },
                    })
                }
                return { edits }
            } catch (error) {
                return { edits: [], rejectReason: error instanceof Error ? error.message : 'Rename unavailable.' }
            }
        },
    }

    return {
        provider,
        dispose() {
            disposed = true
            for (const subscription of subscriptions.values()) subscription.dispose()
            subscriptions.clear()
            for (const model of createdModels) if (!model.isDisposed() && !model.isAttachedToEditor()) model.dispose()
            createdModels.clear()
        },
    }
}

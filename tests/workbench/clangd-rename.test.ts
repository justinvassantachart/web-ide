import { describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import type { ClangdClient } from '../../src/clangd/ClangdClient'
import { createRenameProvider } from '../../src/clangd/rename'
import { registerClangdProviders } from '../../src/clangd/providers'
import type { WorkspaceEdit } from '../../src/clangd/lsp-types'

class TestRange {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
    constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
        this.startLineNumber = startLineNumber
        this.startColumn = startColumn
        this.endLineNumber = endLineNumber
        this.endColumn = endColumn
    }
}

function uri(value: string) {
    const url = value.startsWith('/') ? new URL(`file://${value.split('/').map(encodeURIComponent).join('/')}`) : new URL(value)
    return {
        scheme: url.protocol.slice(0, -1),
        path: decodeURIComponent(url.pathname), authority: url.host,
        query: url.search.slice(1), fragment: url.hash.slice(1), toString: () => value,
    }
}

class TestModel {
    readonly uri: ReturnType<typeof uri>
    version = 7
    disposed = false
    content: string
    changed = new Set<(event: { changes: Array<{ range: TestRange; rangeLength: number; text: string }> }) => void>()
    closing = new Set<() => void>()
    constructor(path: string, content: string) { this.uri = uri(path); this.content = content }
    getValue() { return this.content }
    setValue(content: string) { this.replace(content) }
    getVersionId() { return this.version }
    getValueInRange(range: TestRange) { return this.content.slice(range.startColumn - 1, range.endColumn - 1) }
    getWordAtPosition() { return { word: 'count', startColumn: 5, endColumn: 10 } }
    onDidChangeContent(callback: (event: { changes: Array<{ range: TestRange; rangeLength: number; text: string }> }) => void) { this.changed.add(callback); return { dispose: () => this.changed.delete(callback) } }
    onWillDispose(callback: () => void) { this.closing.add(callback); return { dispose: () => this.closing.delete(callback) } }
    isDisposed() { return this.disposed }
    isAttachedToEditor() { return false }
    dispose() { this.disposed = true; for (const callback of this.closing) callback() }
    replace(content: string) {
        const previousLength = this.content.length
        this.content = content
        this.version++
        for (const callback of this.changed) callback({ changes: [{
            range: new TestRange(1, 1, 1, previousLength + 1), rangeLength: previousLength, text: content,
        }] })
    }
}

const position = { lineNumber: 1, column: 5 } as monaco.Position
const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }
const edit = { range, newText: 'total' }
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as monaco.CancellationToken

function setup(
    files: Record<string, string> = { '/workspace/main.cpp': 'int count = 1;', '/workspace/count.h': 'int count;' },
    options: { namespace?: string; canWrite?: (path: string) => boolean } = {},
) {
    const modelNamespace = options.namespace ? {
        toUri: (path: string) => `file://${options.namespace}${path}`,
        owns: (uri: { authority: string }) => uri.authority === options.namespace,
    } : undefined
    const models = [new TestModel(modelNamespace?.toUri('/workspace/main.cpp') ?? '/workspace/main.cpp', files['/workspace/main.cpp'])]
    const request = vi.fn().mockResolvedValue(null)
    const writeFiles = vi.fn()
    const writes = vi.fn((path: string, content: string) => { files[path] = content })
    const ns = {
        Range: TestRange,
        Uri: { parse: uri },
        editor: {
            getModels: () => models.filter((model) => !model.disposed),
            createModel: vi.fn((content: string, _language: string, resource: ReturnType<typeof uri>) => {
                const model = new TestModel(resource.toString(), content)
                models.push(model)
                return model
            }),
        },
    }
    const rename = createRenameProvider(ns as unknown as typeof monaco, { request, writeFiles } as unknown as ClangdClient, {
        snapshot: () => ({ ...files }), canWrite: options.canWrite ?? (() => true), write: writes,
    }, modelNamespace)
    const run = () => rename.provider.provideRenameEdits(models[0] as unknown as monaco.editor.ITextModel, position, 'total', token)
    return { files, models, request, writeFiles, writes, ns, rename, run }
}

describe('clangd Rename Symbol', () => {
    it('registers native Rename Symbol and sends the same model versions used by versioned edits', () => {
        const h = setup()
        const registered: string[] = []
        const disposable = () => ({ dispose() {} })
        const ns = {
            ...h.ns,
            editor: { ...h.ns.editor, onDidCreateModel: disposable, onWillDisposeModel: disposable },
            languages: new Proxy({}, { get: (_, key) => (...args: unknown[]) => {
                if (key === 'registerRenameProvider') registered.push(args[0] as string)
                return disposable()
            } }),
        }
        const notify = vi.fn()
        const client = { request: h.request, writeFiles: h.writeFiles, notify, on: () => () => {} }
        const registration = registerClangdProviders(ns as unknown as typeof monaco, client as unknown as ClangdClient, {
            languages: ['cpp', 'c'], workspace: { snapshot: () => ({ ...h.files }), canWrite: () => true, write: h.writes },
        })
        expect(registered).toEqual(['cpp', 'c'])
        expect(notify).toHaveBeenCalledWith('textDocument/didOpen', {
            textDocument: { uri: 'file:///workspace/main.cpp', languageId: 'cpp', version: 7, text: 'int count = 1;' },
        })
        h.models[0].replace('int count = 2;')
        expect(notify).toHaveBeenCalledWith('textDocument/didChange', expect.objectContaining({
            textDocument: { uri: 'file:///workspace/main.cpp', version: 8 },
        }))
        registration.dispose()
    })

    it('prepares the exact symbol range and placeholder before showing the rename input', async () => {
        const h = setup()
        h.request.mockResolvedValue({ range, placeholder: 'count' })
        const result = await h.rename.provider.resolveRenameLocation!(h.models[0] as unknown as monaco.editor.ITextModel, position, token)
        expect(result).toEqual({ range: new TestRange(1, 5, 1, 10), text: 'count' })
        expect(h.request).toHaveBeenCalledWith('textDocument/prepareRename', {
            textDocument: { uri: 'file:///workspace/main.cpp' }, position: { line: 0, character: 4 },
        }, expect.any(AbortSignal))
    })

    it('returns versioned edits for both an open source and an unopened header, persisting changes and undo', async () => {
        const h = setup()
        h.request.mockResolvedValue({ documentChanges: [
            { textDocument: { uri: 'file:///workspace/main.cpp', version: 7 }, edits: [edit] },
            { textDocument: { uri: 'file:///workspace/count.h', version: null }, edits: [edit] },
        ] } satisfies WorkspaceEdit)
        const result = await h.run()
        expect(result?.rejectReason).toBeUndefined()
        expect(result?.edits).toHaveLength(2)
        expect(h.writeFiles).toHaveBeenCalledWith(h.files)
        expect(h.ns.editor.createModel).toHaveBeenCalledOnce()
        expect(h.writes).not.toHaveBeenCalled()
        expect(result?.edits.map((e) => (e as monaco.languages.IWorkspaceTextEdit).versionId)).toEqual([7, 7])
        h.models[0].replace('int total = 1;')
        h.models[1].replace('int total;')
        expect(h.files).toEqual({ '/workspace/main.cpp': 'int total = 1;', '/workspace/count.h': 'int total;' })
        h.models[1].replace('int count;')
        expect(h.files['/workspace/count.h']).toBe('int count;')
    })

    it('supports the legacy changes map and URI-encoded filenames', async () => {
        const h = setup({ '/workspace/main.cpp': 'int count;', '/workspace/a #%.h': 'int count;' })
        h.request.mockResolvedValue({ changes: { 'file:///workspace/a%20%23%25.h': [edit] } })
        const result = await h.run()
        expect(result?.rejectReason).toBeUndefined()
        expect((result?.edits[0] as monaco.languages.IWorkspaceTextEdit).resource.path).toBe('/workspace/a #%.h')
    })

    it('uses documentChanges when the server also includes a changes fallback', async () => {
        const h = setup()
        h.request.mockResolvedValue({
            changes: { 'file:///workspace/main.cpp': [edit] },
            documentChanges: [{ textDocument: { uri: 'file:///workspace/count.h', version: null }, edits: [edit] }],
        })
        const result = await h.run()
        expect(result?.edits).toHaveLength(1)
        expect((result?.edits[0] as monaco.languages.IWorkspaceTextEdit).resource.path).toBe('/workspace/count.h')
    })

    it.each([6, 8])('rejects server version %s when the current model version is 7, without partial edits', async (version) => {
        const h = setup()
        h.request.mockResolvedValue({ documentChanges: [
            { textDocument: { uri: 'file:///workspace/count.h', version: null }, edits: [edit] },
            { textDocument: { uri: 'file:///workspace/main.cpp', version }, edits: [edit] },
        ] })
        const result = await h.run()
        expect(result?.rejectReason).toContain('out of date')
        expect(result?.edits).toEqual([])
        expect(h.ns.editor.createModel).not.toHaveBeenCalled()
        expect(h.writes).not.toHaveBeenCalled()
    })

    it.each(['model', 'closed header', 'external file write', 'deleted file'])('rejects an in-flight rename after a %s change', async (kind) => {
        const h = setup()
        h.request.mockImplementation(async () => {
            if (kind === 'model') h.models[0].replace('int changed;')
            if (kind === 'closed header') h.files['/workspace/count.h'] = 'int changed;'
            if (kind === 'external file write') h.files['/workspace/main.cpp'] = 'int changed;'
            if (kind === 'deleted file') delete h.files['/workspace/count.h']
            return { changes: { 'file:///workspace/main.cpp': [edit] } }
        })
        const result = await h.run()
        expect(result?.rejectReason).toContain('workspace changed')
        expect(result?.edits).toEqual([])
    })

    it('never overwrites newer stored header text with an inactive cached model from an older workspace', async () => {
        const h = setup()
        h.models.push(new TestModel('/workspace/count.h', 'int stale;'))
        h.request.mockResolvedValue({ changes: { 'file:///workspace/count.h': [edit] } })
        const result = await h.run()
        expect(result?.rejectReason).toContain('Reopen the changed files')
        expect(result?.edits).toEqual([])
        expect(h.request).not.toHaveBeenCalled()
        expect(h.writes).not.toHaveBeenCalled()
        expect(h.files['/workspace/count.h']).toBe('int count;')
    })

    it('does not let a different editor model with the same path refactor the real workspace file', async () => {
        const h = setup()
        const foreign = new TestModel('/workspace/main.cpp', 'int count = 1;')
        const result = await h.rename.provider.provideRenameEdits(foreign as unknown as monaco.editor.ITextModel, position, 'total', token)
        expect(result?.rejectReason).toContain('Only workspace source files')
        expect(h.request).not.toHaveBeenCalled()
        expect(h.writes).not.toHaveBeenCalled()
    })

    it.each(['file:///usr/include/vector', 'file:///workspace/missing.h', 'https://example.com/workspace/count.h'])('rejects a target outside editable workspace files: %s', async (target) => {
        const h = setup()
        h.request.mockResolvedValue({ changes: { 'file:///workspace/main.cpp': [edit], [target]: [edit] } })
        const result = await h.run()
        expect(result?.rejectReason).toContain('outside this workspace')
        expect(result?.edits).toEqual([])
        expect(h.writes).not.toHaveBeenCalled()
    })

    it('rejects resource operations and invalid ranges before creating models', async () => {
        const h = setup()
        h.request.mockResolvedValue({ documentChanges: [
            { textDocument: { uri: 'file:///workspace/count.h', version: null }, edits: [edit] },
            { kind: 'rename', oldUri: 'file:///workspace/main.cpp', newUri: 'file:///workspace/new.cpp' },
        ] })
        expect((await h.run())?.rejectReason).toContain('create, move, or delete')
        h.request.mockResolvedValue({ changes: { 'file:///workspace/count.h': [{ newText: 'total', range: { ...range, end: { line: 9, character: 99 } } }] } })
        expect((await h.run())?.rejectReason).toContain('invalid rename range')
        expect(h.ns.editor.createModel).not.toHaveBeenCalled()
    })

    it('propagates language-server rejection and stops cancelled requests without edits', async () => {
        const h = setup()
        h.request.mockRejectedValue(new Error('Cannot rename a macro.'))
        expect((await h.run())?.rejectReason).toBe('Cannot rename a macro.')
        h.request.mockClear()
        const result = await h.rename.provider.provideRenameEdits(h.models[0] as unknown as monaco.editor.ITextModel, position, 'total', {
            ...token, isCancellationRequested: true,
        })
        expect(result?.rejectReason).toBe('Rename cancelled.')
        expect(h.request).not.toHaveBeenCalled()
        expect(h.writes).not.toHaveBeenCalled()
    })

    it('keeps same-path models and unopened headers inside the selected instance', async () => {
        const h = setup(undefined, { namespace: 'instance-a' })
        const foreignSource = new TestModel('file://instance-b/workspace/main.cpp', 'int unrelated;')
        const foreignHeader = new TestModel('file://instance-b/workspace/count.h', 'int unrelated;')
        h.models.push(foreignSource, foreignHeader)
        h.request.mockResolvedValue({ changes: {
            'file:///workspace/main.cpp': [edit], 'file:///workspace/count.h': [edit],
        } })
        const result = await h.run()
        expect(result?.rejectReason).toBeUndefined()
        expect(result?.edits.map((e) => (e as monaco.languages.IWorkspaceTextEdit).resource.authority)).toEqual(['instance-a', 'instance-a'])
        h.models[3].replace('int total;')
        expect(h.files['/workspace/count.h']).toBe('int total;')
        expect(foreignSource.getValue()).toBe('int unrelated;')
        expect(foreignHeader.getValue()).toBe('int unrelated;')
        h.request.mockClear()
        expect(await h.rename.provider.provideRenameEdits(foreignSource as unknown as monaco.editor.ITextModel, position, 'total', token)).toBeUndefined()
        expect(h.request).not.toHaveBeenCalled()
    })

    it.each(['all', 'header'])('rejects %s read-only edits before creating any models', async (protectedFile) => {
        const h = setup(undefined, { canWrite: (path) => protectedFile !== 'all' && !path.endsWith('.h') })
        h.request.mockResolvedValue({ changes: {
            'file:///workspace/main.cpp': [edit], 'file:///workspace/count.h': [edit],
        } })
        const result = await h.run()
        expect(result?.rejectReason).toContain('read-only')
        expect(result?.edits).toEqual([])
        expect(h.ns.editor.createModel).not.toHaveBeenCalled()
        expect(h.writes).not.toHaveBeenCalled()
    })

    it('rechecks edit permission after the server responds and when Monaco applies an edit', async () => {
        let writable = true
        const h = setup(undefined, { canWrite: () => writable })
        h.request.mockImplementation(async () => {
            writable = false
            return { changes: { 'file:///workspace/main.cpp': [edit] } }
        })
        expect((await h.run())?.rejectReason).toContain('read-only')
        writable = true
        h.request.mockResolvedValue({ changes: { 'file:///workspace/count.h': [edit] } })
        expect((await h.run())?.edits).toHaveLength(1)
        writable = false
        h.models[1].replace('int total;')
        expect(h.models[1].getValue()).toBe('int count;')
        expect(h.files['/workspace/count.h']).toBe('int count;')
        expect(h.writes).not.toHaveBeenCalled()
    })

    it('disposes its persistence listeners and hidden models when the provider unmounts', async () => {
        const h = setup()
        h.request.mockResolvedValue({ changes: { 'file:///workspace/main.cpp': [edit], 'file:///workspace/count.h': [edit] } })
        await h.run()
        h.rename.dispose()
        expect(h.models[0].disposed).toBe(false)
        expect(h.models[1].disposed).toBe(true)
        h.models[0].replace('int later;')
        expect(h.writes).not.toHaveBeenCalled()
    })
})

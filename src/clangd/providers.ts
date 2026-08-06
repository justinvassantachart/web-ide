// Bridges clangd's LSP responses into Monaco's provider APIs.
//
// We bypass `monaco-languageclient` on purpose — it requires swapping
// `monaco-editor` for `@codingame/monaco-vscode-*`, which would ripple
// through the rest of nova. Direct providers are ~250 LOC and keep
// nova's Monaco setup intact.

import type { editor, IDisposable, Position, Range } from 'monaco-editor'
import type * as monaco from 'monaco-editor'

import type { ClangdClient } from './ClangdClient'
import { isCppPath, toClangdUri } from './config'
import type {
    CompletionItem as LspCompletionItem,
    CompletionList,
    Diagnostic,
    DocumentSymbol,
    Hover,
    Location,
    Position as LspPosition,
    PublishDiagnosticsParams,
    Range as LspRange,
    SignatureHelp,
} from './lsp-types'

type MonacoNs = typeof monaco

// ---------- Position / range conversions ----------
// LSP is 0-indexed, Monaco is 1-indexed for both line and column.

function toLspPos(pos: Position): LspPosition {
    return { line: pos.lineNumber - 1, character: pos.column - 1 }
}

function toMonacoRange(monacoNs: MonacoNs, r: LspRange): Range {
    return new monacoNs.Range(
        r.start.line + 1,
        r.start.character + 1,
        r.end.line + 1,
        r.end.character + 1,
    )
}

// ---------- Enum conversions ----------
// LSP and Monaco share enum names but not always values — explicit maps
// catch the mismatches that naked casts would hide.

function completionKind(monacoNs: MonacoNs, lspKind: number | undefined): monaco.languages.CompletionItemKind {
    const K = monacoNs.languages.CompletionItemKind
    switch (lspKind) {
        case 1: return K.Text
        case 2: return K.Method
        case 3: return K.Function
        case 4: return K.Constructor
        case 5: return K.Field
        case 6: return K.Variable
        case 7: return K.Class
        case 8: return K.Interface
        case 9: return K.Module
        case 10: return K.Property
        case 11: return K.Unit
        case 12: return K.Value
        case 13: return K.Enum
        case 14: return K.Keyword
        case 15: return K.Snippet
        case 16: return K.Color
        case 17: return K.File
        case 18: return K.Reference
        case 19: return K.Folder
        case 20: return K.EnumMember
        case 21: return K.Constant
        case 22: return K.Struct
        case 23: return K.Event
        case 24: return K.Operator
        case 25: return K.TypeParameter
        default: return K.Text
    }
}

function diagSeverity(monacoNs: MonacoNs, lspSev: number | undefined): monaco.MarkerSeverity {
    const S = monacoNs.MarkerSeverity
    switch (lspSev) {
        case 1: return S.Error
        case 2: return S.Warning
        case 3: return S.Info
        case 4: return S.Hint
        default: return S.Info
    }
}

// LSP SymbolKind is 1-indexed, Monaco's is 0-indexed. Same names, off by one.
function symbolKind(monacoNs: MonacoNs, lspKind: number): monaco.languages.SymbolKind {
    const K = monacoNs.languages.SymbolKind
    if (lspKind < 1 || lspKind > 26) return K.Variable
    return (lspKind - 1) as monaco.languages.SymbolKind
}

// LSP CompletionTriggerKind is 1-indexed; Monaco is 0-indexed. +1 lands us in LSP's enum.
function toLspTriggerKind(m: monaco.languages.CompletionTriggerKind): 1 | 2 | 3 {
    return (m + 1) as 1 | 2 | 3
}

const DIAG_OWNER = 'clangd'

// ---------- Text edit + hover helpers ----------

function applyCompletionTextEdit(
    monacoNs: MonacoNs,
    item: LspCompletionItem,
    fallbackRange: Range,
): { range: Range | monaco.languages.CompletionItemRanges; insertText: string } {
    const insertText = item.insertText ?? item.label
    if (!item.textEdit) return { range: fallbackRange, insertText }

    if ('range' in item.textEdit) {
        return { range: toMonacoRange(monacoNs, item.textEdit.range), insertText: item.textEdit.newText }
    }
    return {
        range: {
            insert: toMonacoRange(monacoNs, item.textEdit.insert),
            replace: toMonacoRange(monacoNs, item.textEdit.replace),
        },
        insertText: item.textEdit.newText,
    }
}

function applyAdditionalEdits(
    monacoNs: MonacoNs,
    item: LspCompletionItem,
): monaco.languages.CompletionItem['additionalTextEdits'] {
    const edits = item.additionalTextEdits
    if (!edits || edits.length === 0) return undefined
    return edits.map((e) => ({
        range: toMonacoRange(monacoNs, e.range),
        text: e.newText,
    }))
}

function hoverContent(h: Hover): monaco.IMarkdownString[] {
    const out: monaco.IMarkdownString[] = []
    const push = (text: string) => {
        if (text.trim().length > 0) out.push({ value: text })
    }
    const c = h.contents
    if (typeof c === 'string') {
        push(c)
    } else if (Array.isArray(c)) {
        for (const part of c) {
            if (typeof part === 'string') push(part)
            else push('```' + part.language + '\n' + part.value + '\n```')
        }
    } else if (c && typeof c === 'object' && 'value' in c) {
        push(c.value)
    }
    return out
}

function markdownify(
    s: string | { kind: 'markdown' | 'plaintext'; value: string } | undefined,
): string | undefined {
    if (!s) return undefined
    return typeof s === 'string' ? s : s.value
}

// ---------- Document sync ----------

/**
 * Mirrors Monaco's open C/C++ models into clangd via didOpen / didChange /
 * didClose. clangd uses these messages as the source of truth for the file
 * the user is editing; without them, completions and diagnostics see stale
 * content.
 */
class DocumentSync {
    private readonly opened = new Map<string, IDisposable>()
    private readonly disposables: IDisposable[] = []
    private readonly client: ClangdClient

    constructor(monacoNs: MonacoNs, client: ClangdClient) {
        this.client = client
        monacoNs.editor.getModels().forEach((m) => this.openIfCpp(m))
        this.disposables.push(monacoNs.editor.onDidCreateModel((m) => this.openIfCpp(m)))
        this.disposables.push(monacoNs.editor.onWillDisposeModel((m) => this.close(m)))
    }

    dispose() {
        for (const d of this.disposables) d.dispose()
        for (const sub of this.opened.values()) sub.dispose()
        this.opened.clear()
    }

    private openIfCpp(model: editor.ITextModel) {
        // Key by full URI so two schemes can't collide on path alone.
        const key = model.uri.toString()
        if (!isCppPath(model.uri.path) || this.opened.has(key)) return

        const uri = toClangdUri(model.uri.path)
        this.client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'cpp', version: 1, text: model.getValue() },
        })

        // didChange is authoritative for the open file. The ClangdContext
        // watchdog handles unopened files for transitive #includes.
        let version = 1
        const sub = model.onDidChangeContent((e) => {
            version++
            this.client.notify('textDocument/didChange', {
                textDocument: { uri, version },
                contentChanges: e.changes.map((c) => ({
                    range: {
                        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
                        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
                    },
                    rangeLength: c.rangeLength,
                    text: c.text,
                })),
            })
        })
        this.opened.set(key, sub)
    }

    private close(model: editor.ITextModel) {
        const key = model.uri.toString()
        const sub = this.opened.get(key)
        if (!sub) return
        sub.dispose()
        this.opened.delete(key)
        this.client.notify('textDocument/didClose', {
            textDocument: { uri: toClangdUri(model.uri.path) },
        })
    }
}

// Monaco's CancellationToken → AbortSignal so ClangdClient stays Monaco-agnostic.
function signalFromToken(token: monaco.CancellationToken): AbortSignal {
    const ctl = new AbortController()
    if (token.isCancellationRequested) ctl.abort()
    else token.onCancellationRequested(() => ctl.abort())
    return ctl.signal
}

// Cancellation is a hot-path expected outcome — keep it out of the warn log.
function isCancellation(err: unknown): boolean {
    return err instanceof Error && err.message === 'cancelled'
}

// ---------- Provider registrations ----------

interface RegisterOptions {
    /** Monaco language IDs clangd should answer for. */
    languages: string[]
}

export function registerClangdProviders(
    monacoNs: MonacoNs,
    client: ClangdClient,
    opts: RegisterOptions = { languages: ['cpp', 'c'] },
): IDisposable {
    const disposables: IDisposable[] = []
    const sync = new DocumentSync(monacoNs, client)
    disposables.push({ dispose: () => sync.dispose() })

    for (const lang of opts.languages) {
        disposables.push(monacoNs.languages.registerCompletionItemProvider(lang, {
            // Restricting to `. > :` avoids spurious requests inside
            // comments and strings.
            triggerCharacters: ['.', '>', ':'],
            provideCompletionItems: async (model, position, context, token) => {
                if (!isCppPath(model.uri.path)) return { suggestions: [] }
                const word = model.getWordUntilPosition(position)
                const fallbackRange = new monacoNs.Range(
                    position.lineNumber,
                    word.startColumn,
                    position.lineNumber,
                    word.endColumn,
                )
                try {
                    const raw = await client.request<CompletionList | LspCompletionItem[] | null>(
                        'textDocument/completion',
                        {
                            textDocument: { uri: toClangdUri(model.uri.path) },
                            position: toLspPos(position),
                            context: {
                                triggerKind: toLspTriggerKind(context.triggerKind),
                                ...(context.triggerCharacter
                                    ? { triggerCharacter: context.triggerCharacter }
                                    : {}),
                            },
                        },
                        signalFromToken(token),
                    )
                    if (!raw) return { suggestions: [] }
                    const items: LspCompletionItem[] = Array.isArray(raw) ? raw : raw.items
                    const isIncomplete = Array.isArray(raw) ? false : raw.isIncomplete
                    return {
                        incomplete: isIncomplete,
                        suggestions: items.map((item) => {
                            const { range, insertText } = applyCompletionTextEdit(monacoNs, item, fallbackRange)
                            const suggestion: monaco.languages.CompletionItem = {
                                label: item.label,
                                kind: completionKind(monacoNs, item.kind),
                                detail: item.detail,
                                documentation: typeof item.documentation === 'string'
                                    ? item.documentation
                                    : item.documentation?.value,
                                sortText: item.sortText,
                                filterText: item.filterText,
                                preselect: item.preselect,
                                insertText,
                                range,
                                insertTextRules: item.insertTextFormat === 2
                                    ? monacoNs.languages.CompletionItemInsertTextRule.InsertAsSnippet
                                    : monacoNs.languages.CompletionItemInsertTextRule.None,
                                additionalTextEdits: applyAdditionalEdits(monacoNs, item),
                            }
                            // Honour both legacy boolean and LSP 3.15+ tags.
                            const deprecated =
                                item.deprecated ||
                                (Array.isArray(item.tags) && item.tags.includes(1))
                            if (deprecated) {
                                suggestion.tags = [monacoNs.languages.CompletionItemTag.Deprecated]
                            }
                            return suggestion
                        }),
                    }
                } catch (err) {
                    if (!isCancellation(err)) console.warn('[clangd] completion failed', err)
                    return { suggestions: [] }
                }
            },
        }))

        disposables.push(monacoNs.languages.registerHoverProvider(lang, {
            provideHover: async (model, position, token) => {
                if (!isCppPath(model.uri.path)) return null
                try {
                    const hover = await client.request<Hover | null>('textDocument/hover', {
                        textDocument: { uri: toClangdUri(model.uri.path) },
                        position: toLspPos(position),
                    }, signalFromToken(token))
                    if (!hover) return null
                    return {
                        range: hover.range ? toMonacoRange(monacoNs, hover.range) : undefined,
                        contents: hoverContent(hover),
                    }
                } catch (err) {
                    if (!isCancellation(err)) console.warn('[clangd] hover failed', err)
                    return null
                }
            },
        }))

        disposables.push(monacoNs.languages.registerSignatureHelpProvider(lang, {
            signatureHelpTriggerCharacters: ['(', ','],
            signatureHelpRetriggerCharacters: [')'],
            provideSignatureHelp: async (model, position, token) => {
                if (!isCppPath(model.uri.path)) return null
                try {
                    const help = await client.request<SignatureHelp | null>(
                        'textDocument/signatureHelp',
                        {
                            textDocument: { uri: toClangdUri(model.uri.path) },
                            position: toLspPos(position),
                        },
                        signalFromToken(token),
                    )
                    if (!help || !help.signatures || help.signatures.length === 0) return null
                    return {
                        value: {
                            signatures: help.signatures.map((s) => ({
                                label: s.label,
                                documentation: markdownify(s.documentation),
                                parameters: (s.parameters ?? []).map((p) => ({
                                    label: p.label,
                                    documentation: markdownify(p.documentation),
                                })),
                                activeParameter: s.activeParameter,
                            })),
                            activeSignature: help.activeSignature ?? 0,
                            activeParameter: help.activeParameter ?? 0,
                        },
                        dispose: () => {},
                    }
                } catch (err) {
                    if (!isCancellation(err)) console.warn('[clangd] signatureHelp failed', err)
                    return null
                }
            },
        }))

        disposables.push(monacoNs.languages.registerDefinitionProvider(lang, {
            provideDefinition: async (model, position, token) => {
                if (!isCppPath(model.uri.path)) return null
                try {
                    const res = await client.request<Location | Location[] | null>(
                        'textDocument/definition',
                        {
                            textDocument: { uri: toClangdUri(model.uri.path) },
                            position: toLspPos(position),
                        },
                        signalFromToken(token),
                    )
                    if (!res) return null
                    const locs = Array.isArray(res) ? res : [res]
                    return locs.map((l) => ({
                        uri: monacoNs.Uri.parse(l.uri),
                        range: toMonacoRange(monacoNs, l.range),
                    }))
                } catch (err) {
                    if (!isCancellation(err)) console.warn('[clangd] definition failed', err)
                    return null
                }
            },
        }))

        disposables.push(monacoNs.languages.registerDocumentSymbolProvider(lang, {
            displayName: 'clangd',
            provideDocumentSymbols: async (model, token) => {
                if (!isCppPath(model.uri.path)) return []
                try {
                    const res = await client.request<DocumentSymbol[] | null>(
                        'textDocument/documentSymbol',
                        { textDocument: { uri: toClangdUri(model.uri.path) } },
                        signalFromToken(token),
                    )
                    if (!res) return []
                    const flatten = (s: DocumentSymbol): monaco.languages.DocumentSymbol => ({
                        name: s.name,
                        detail: s.detail ?? '',
                        kind: symbolKind(monacoNs, s.kind),
                        tags: (s.tags ?? []).includes(1)
                            ? [monacoNs.languages.SymbolTag.Deprecated]
                            : [],
                        range: toMonacoRange(monacoNs, s.range),
                        selectionRange: toMonacoRange(monacoNs, s.selectionRange),
                        children: (s.children ?? []).map(flatten),
                    })
                    return res.map(flatten)
                } catch (err) {
                    if (!isCancellation(err)) console.warn('[clangd] documentSymbol failed', err)
                    return []
                }
            },
        }))
    }

    // Diagnostics arrive as notifications — route to the right Monaco model.
    const unsubscribe = client.on('textDocument/publishDiagnostics', (params) => {
        if (!params || typeof params !== 'object') return
        const p = params as unknown as PublishDiagnosticsParams
        const uri = monacoNs.Uri.parse(p.uri)
        const model = monacoNs.editor.getModel(uri)
        if (!model) return
        monacoNs.editor.setModelMarkers(
            model,
            DIAG_OWNER,
            (p.diagnostics ?? []).map((d: Diagnostic) => ({
                severity: diagSeverity(monacoNs, d.severity),
                message: d.message,
                source: d.source ?? 'clangd',
                code: d.code === undefined ? undefined : String(d.code),
                startLineNumber: d.range.start.line + 1,
                startColumn: d.range.start.character + 1,
                endLineNumber: d.range.end.line + 1,
                endColumn: d.range.end.character + 1,
                tags: (d.tags ?? [])
                    .map((t) =>
                        t === 1 ? monacoNs.MarkerTag.Unnecessary
                        : t === 2 ? monacoNs.MarkerTag.Deprecated
                        : undefined,
                    )
                    .filter((t): t is monaco.MarkerTag => t !== undefined),
            })),
        )
    })
    disposables.push({ dispose: unsubscribe })

    return {
        dispose: () => {
            for (const d of disposables) d.dispose()
        },
    }
}

/** Wipe clangd-owned markers from every model. Used when tearing down providers. */
export function clearClangdMarkers(monacoNs: MonacoNs) {
    for (const model of monacoNs.editor.getModels()) {
        monacoNs.editor.setModelMarkers(model, DIAG_OWNER, [])
    }
}

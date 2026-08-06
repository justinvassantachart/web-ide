// Minimal LSP types — just what nova talks to clangd about. We don't pull
// vscode-languageserver-protocol; its dep tree is large and we use a
// handful of methods.

// `Json` documents intent but params use `unknown` so ad-hoc literals
// type-check without casts. Callers narrow results via `as`.
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

export type LspParams = unknown

export interface LspRequest {
    jsonrpc: '2.0'
    id: number | string
    method: string
    params?: LspParams
}

export interface LspResponse {
    jsonrpc: '2.0'
    id: number | string
    result?: LspParams
    error?: { code: number; message: string; data?: LspParams }
}

export interface LspNotification {
    jsonrpc: '2.0'
    method: string
    params?: LspParams
}

export type LspMessage = LspRequest | LspResponse | LspNotification

export interface Position {
    line: number
    character: number
}

export interface Range {
    start: Position
    end: Position
}

export interface TextEdit {
    range: Range
    newText: string
}

export interface Diagnostic {
    range: Range
    severity?: 1 | 2 | 3 | 4
    code?: string | number
    source?: string
    message: string
    /** LSP DiagnosticTag: 1 = Unnecessary (dim), 2 = Deprecated (strikethrough). */
    tags?: Array<1 | 2>
    relatedInformation?: Array<{
        location: { uri: string; range: Range }
        message: string
    }>
}

export interface PublishDiagnosticsParams {
    uri: string
    diagnostics: Diagnostic[]
    version?: number
}

export interface CompletionItem {
    label: string
    kind?: number
    /** LSP CompletionItemTag: currently only 1 = Deprecated. */
    tags?: Array<1>
    detail?: string
    documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
    sortText?: string
    filterText?: string
    insertText?: string
    insertTextFormat?: 1 | 2 // Plain | Snippet
    textEdit?: TextEdit | { insert: Range; replace: Range; newText: string }
    additionalTextEdits?: TextEdit[]
    /** Legacy LSP <3.15. Modern clangd uses `tags: [1]`; we honour both. */
    deprecated?: boolean
    preselect?: boolean
}

export interface CompletionList {
    isIncomplete: boolean
    items: CompletionItem[]
}

export interface Hover {
    contents:
        | string
        | { kind: 'markdown' | 'plaintext'; value: string }
        | Array<string | { language: string; value: string }>
    range?: Range
}

export interface SignatureInformation {
    label: string
    documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
    parameters?: Array<{
        label: string | [number, number]
        documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
    }>
    activeParameter?: number
}

export interface SignatureHelp {
    signatures: SignatureInformation[]
    activeSignature?: number
    activeParameter?: number
}

export interface Location {
    uri: string
    range: Range
}

export interface DocumentSymbol {
    name: string
    detail?: string
    kind: number
    /** LSP SymbolTag: currently only 1 = Deprecated. */
    tags?: Array<1>
    range: Range
    selectionRange: Range
    children?: DocumentSymbol[]
}

// ===== Worker bridge protocol (main thread <-> clangd worker) =====

export type ClientToWorker =
    | { type: 'lsp'; message: LspMessage }
    | { type: 'fs:write'; path: string; content: string }
    | { type: 'fs:delete'; path: string }
    | { type: 'fs:writeAll'; files: Record<string, string> }

export type WorkerToClient =
    | { type: 'ready' }
    | { type: 'progress'; loaded: number; total: number }
    | { type: 'lsp'; message: LspMessage }
    | { type: 'error'; message: string }

/// <reference lib="WebWorker" />

// Hosts an Emscripten-built `clangd` and bridges its stdio to the main
// thread via postMessage. Inspired by guyutongxue/clangd-in-browser, with
// our own LSP framing and a fs:write protocol so the main thread can keep
// clangd's view of the workspace in sync.

import {
    CLANGD_CACHE_KEY,
    CLANGD_JS_URL,
    CLANGD_WASM_URL,
    COMPILE_FLAGS,
    WORKSPACE_PATH,
} from './config'
import { JsonStream } from './json-stream'
import type { ClientToWorker, LspMessage, WorkerToClient } from './lsp-types'

declare const self: DedicatedWorkerGlobalScope

interface ClangdFS {
    writeFile(path: string, data: string | Uint8Array): void
    unlink(path: string): void
    mkdir(path: string, mode?: number): void
    analyzePath(path: string, dontResolveLastLink?: boolean): { exists: boolean }
}
interface ClangdModule {
    FS: ClangdFS
    callMain(args: string[]): number
}
interface ClangdModuleOptions {
    thisProgram?: string
    locateFile?(path: string, prefix: string): string
    mainScriptUrlOrBlob?: string
    stdinReady?: () => Promise<void> | void
    stdin?: () => number | null
    stdout?: (charCode: number) => void
    stderr?: (charCode: number) => void
    onExit?: (code: number) => void
    onAbort?: (reason: unknown) => void
    print?: (text: string) => void
    printErr?: (text: string) => void
}
type ClangdFactory = (opts: ClangdModuleOptions) => Promise<ClangdModule>

function send(message: WorkerToClient) {
    self.postMessage(message)
}

/**
 * Cache-aware fetch. Tries the Cache API first; on miss, falls through to
 * the network and stores the response (best-effort — quota errors don't
 * fail the boot). Cached responses still expose a streaming body, so
 * progress reporting works the same way for both cases.
 */
async function fetchCached(url: string): Promise<Response> {
    if (typeof caches === 'undefined') return fetch(url)
    let cache: Cache
    try {
        cache = await caches.open(CLANGD_CACHE_KEY)
    } catch {
        // Private mode etc. — fall back to plain fetch.
        return fetch(url)
    }
    const cached = await cache.match(url)
    if (cached) return cached
    const fresh = await fetch(url)
    if (fresh.ok) {
        // Clone before we hand the original back — body streams are one-shot.
        cache.put(url, fresh.clone()).catch((err) => {
            console.warn('[clangd] cache.put failed (quota?):', err)
        })
    }
    return fresh
}

async function fetchWithProgress(url: string): Promise<ArrayBuffer> {
    const response = await fetchCached(url)
    if (!response.ok) {
        throw new Error(`clangd: fetch ${url} failed (${response.status})`)
    }
    // content-length is missing under gzip or chunked encoding;
    // Number('chunked') is NaN, so guard.
    const totalHeader = response.headers.get('content-length')
    const totalParsed = totalHeader ? Number(totalHeader) : 0
    const total = Number.isFinite(totalParsed) ? totalParsed : 0

    const reader = response.body?.getReader()
    if (!reader) {
        // Streaming reads unavailable — fall back to one-shot.
        const buf = await response.arrayBuffer()
        send({ type: 'progress', loaded: buf.byteLength, total: buf.byteLength })
        return buf
    }

    const chunks: Uint8Array[] = []
    let loaded = 0
    let lastReport = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(value)
        loaded += value.byteLength
        // Throttle: don't spam postMessage on every chunk.
        const now = performance.now()
        if (now - lastReport > 100) {
            send({ type: 'progress', loaded, total })
            lastReport = now
        }
    }
    send({ type: 'progress', loaded, total: total || loaded })

    const out = new Uint8Array(loaded)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.byteLength
    }
    return out.buffer
}

async function start() {
    // 1. Fetch wasm. Both blob URLs are intentionally never revoked: the
    //    JS one must stay alive for emscripten's pthread workers, and the
    //    wasm one is already consumed by WebAssembly.instantiate. Both
    //    die when terminate() reclaims the whole worker.
    const wasmBuffer = await fetchWithProgress(CLANGD_WASM_URL)
    const wasmBlobUrl = URL.createObjectURL(
        new Blob([wasmBuffer], { type: 'application/wasm' }),
    )

    // 2. Fetch the emscripten loader as text and import via blob URL —
    //    bypasses cross-origin module-loading restrictions.
    const jsResp = await fetchCached(CLANGD_JS_URL)
    if (!jsResp.ok) {
        throw new Error(`clangd: fetch ${CLANGD_JS_URL} failed (${jsResp.status})`)
    }
    const jsText = await jsResp.text()
    const jsBlobUrl = URL.createObjectURL(new Blob([jsText], { type: 'text/javascript' }))
    const factoryModule: { default: ClangdFactory } = await import(
        /* @vite-ignore */ jsBlobUrl
    )
    const Clangd = factoryModule.default

    // 3. Stdio glue. Stdin is a string FIFO that emscripten drains
    //    byte-by-byte; stdout is parsed as a stream of LSP JSON objects.
    const encoder = new TextEncoder()
    let stdinResolve: (() => void) | null = null
    const stdinChunks: string[] = []
    const currentBytes: (number | null)[] = []

    const stdinReady = (): Promise<void> | void => {
        if (stdinChunks.length > 0 || currentBytes.length > 0) return
        return new Promise<void>((r) => (stdinResolve = r))
    }
    const stdin = (): number | null => {
        if (currentBytes.length === 0) {
            const next = stdinChunks.shift()
            if (next === undefined) return null
            currentBytes.push(...encoder.encode(next), null)
        }
        const next = currentBytes.shift()
        return next === undefined ? null : next
    }

    const jsonStream = new JsonStream()
    const stdout = (charCode: number) => {
        const complete = jsonStream.insert(charCode)
        if (complete === null) return
        try {
            const message = JSON.parse(complete) as LspMessage
            send({ type: 'lsp', message })
        } catch (err) {
            send({ type: 'error', message: `clangd: failed to parse stdout: ${String(err)}` })
        }
    }
    // clangd dumps routine info AND crash traces to stderr. Buffer per
    // line, then route by its `I[…]`/`E[…]`/`F[…]` prefix so a crash is
    // visible in the console without info logs dimming everything.
    let stderrLine = ''
    const LF = 10
    const stderr = (charCode: number) => {
        if (charCode !== LF) {
            stderrLine += String.fromCharCode(charCode)
            return
        }
        if (stderrLine.length === 0) return
        const line = stderrLine
        stderrLine = ''
        if (line.startsWith('I[')) console.debug('[clangd]', line)
        else if (line.startsWith('E[') || line.startsWith('F[')) console.error('[clangd]', line)
        else console.warn('[clangd]', line)
    }

    const onAbort = (reason: unknown) => {
        send({ type: 'error', message: `clangd aborted: ${String(reason)}` })
    }

    // 4. Boot the module.
    const clangd = await Clangd({
        thisProgram: '/usr/bin/clangd',
        locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? wasmBlobUrl : `${prefix}${path}`,
        mainScriptUrlOrBlob: jsBlobUrl,
        stdinReady,
        stdin,
        stdout,
        stderr,
        onExit: (code: number) => onAbort(`exit ${code}`),
        onAbort,
    })

    // 5. Workspace + compile flags. Pre-create the workspace dir so
    //    fs:write doesn't race on missing parent.
    //    `.clangd` is YAML; JSON for a flat mapping happens to be valid
    //    YAML, so this works without a YAML serializer.
    ensureDir(clangd.FS, WORKSPACE_PATH)
    clangd.FS.writeFile(
        `${WORKSPACE_PATH}/.clangd`,
        JSON.stringify({ CompileFlags: { Add: [...COMPILE_FLAGS] } }),
    )

    // 6. Handle messages from the main thread. Wrapped so a throw doesn't
    //    become an invisible unhandled rejection inside the worker.
    self.addEventListener('message', (e: MessageEvent<ClientToWorker>) => {
        try {
            const data = e.data
            switch (data.type) {
                case 'lsp': {
                    writeLspToStdin(data.message)
                    break
                }
                case 'fs:write': {
                    writeFile(clangd.FS, data.path, data.content)
                    break
                }
                case 'fs:delete': {
                    tryUnlink(clangd.FS, data.path)
                    break
                }
                case 'fs:writeAll': {
                    for (const [path, content] of Object.entries(data.files)) {
                        writeFile(clangd.FS, path, content)
                    }
                    break
                }
            }
        } catch (err) {
            send({ type: 'error', message: `clangd: message handler threw: ${String(err)}` })
        }
    })

    function writeLspToStdin(message: LspMessage) {
        // LSP Content-Length is bytes, not chars — encode to measure.
        const body = JSON.stringify(message)
        const byteLen = encoder.encode(body).byteLength
        stdinChunks.push(`Content-Length: ${byteLen}\r\n\r\n`, body)
        stdinResolve?.()
        stdinResolve = null
    }

    // 7. Hand off to clangd. callMain blocks on stdin via Atomics; the
    //    upstream wait_stdin patch makes that responsive instead of
    //    spinning.
    send({ type: 'ready' })
    clangd.callMain([])
}

function ensureDir(fs: ClangdFS, path: string) {
    const segments = path.split('/').filter(Boolean)
    let cur = ''
    for (const seg of segments) {
        cur += '/' + seg
        if (!fs.analyzePath(cur).exists) {
            try { fs.mkdir(cur) } catch { /* race with parallel writes */ }
        }
    }
}

function writeFile(fs: ClangdFS, path: string, content: string) {
    const dir = path.substring(0, path.lastIndexOf('/'))
    if (dir) ensureDir(fs, dir)
    try {
        fs.writeFile(path, content)
    } catch (err) {
        send({ type: 'error', message: `clangd: writeFile ${path} failed: ${String(err)}` })
    }
}

function tryUnlink(fs: ClangdFS, path: string) {
    try {
        if (fs.analyzePath(path).exists) fs.unlink(path)
    } catch { /* best-effort */ }
}

start().catch((err: unknown) => {
    send({ type: 'error', message: `clangd: boot failed: ${String(err)}` })
})

// Main-thread side of the clangd bridge: request/response correlation,
// notification subscriptions, worker lifecycle.

import { EventEmitter } from '@/lib/event-emitter'
import type {
    ClientToWorker,
    LspMessage,
    LspNotification,
    LspParams,
    LspRequest,
    LspResponse,
    WorkerToClient,
} from './lsp-types'

type NotificationHandler = (params: LspParams) => void

export type ClangdStatus =
    | { state: 'idle' }                                              // not booted; arm() will boot
    | { state: 'disabled' }                                          // user/host turned it off
    | { state: 'starting'; loaded: number; total: number }            // downloading/initializing
    | { state: 'ready' }
    | { state: 'error'; message: string }
    | { state: 'disposed' }

type Resolver = {
    resolve: (value: LspParams) => void
    reject: (err: Error) => void
}

export class ClangdClient {
    public readonly onStatus = new EventEmitter<ClangdStatus>()

    private worker: Worker
    private nextRequestId = 1
    private pending = new Map<number | string, Resolver>()
    private notifHandlers = new Map<string, Set<NotificationHandler>>()
    private readyPromise: Promise<void>
    private resolveReady!: () => void
    private rejectReady!: (err: Error) => void
    private status: ClangdStatus = { state: 'starting', loaded: 0, total: 0 }
    private disposed = false

    constructor() {
        this.worker = new Worker(new URL('./clangd.worker.ts', import.meta.url), {
            type: 'module',
            name: 'clangd',
        })
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve
            this.rejectReady = reject
        })
        // Marker handler so dispose-before-await doesn't surface as
        // unhandled rejection. Consumers still see real failures.
        this.readyPromise.catch(() => {})
        this.worker.addEventListener('message', this.handleMessage)
        this.worker.addEventListener('error', this.handleError)
    }

    /** Resolves once clangd accepts LSP requests. */
    ready(): Promise<void> {
        return this.readyPromise
    }

    getStatus(): ClangdStatus {
        return this.status
    }

    /**
     * Pass `signal` (e.g. from Monaco's CancellationToken) to abort the
     * request locally AND send $/cancelRequest so clangd stops computing.
     */
    request<T = LspParams>(method: string, params?: LspParams, signal?: AbortSignal): Promise<T> {
        if (this.disposed) return Promise.reject(new Error('clangd disposed'))
        if (signal?.aborted) return Promise.reject(new Error('cancelled'))
        const id = this.nextRequestId++
        const req: LspRequest = { jsonrpc: '2.0', id, method, params }
        const promise = new Promise<LspParams>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
        })
        // Same unhandled-rejection trap as readyPromise.
        promise.catch(() => {})
        if (signal) {
            const onAbort = () => this.cancel(id)
            signal.addEventListener('abort', onAbort, { once: true })
            // `.finally` returns a new chained promise that also needs a catch.
            promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
        }
        this.post({ type: 'lsp', message: req })
        return promise as Promise<T>
    }

    notify(method: string, params?: LspParams): void {
        if (this.disposed) return
        this.post({ type: 'lsp', message: { jsonrpc: '2.0', method, params } })
    }

    /** Subscribe to a server-pushed notification; returns the unsubscribe. */
    on(method: string, handler: NotificationHandler): () => void {
        let set = this.notifHandlers.get(method)
        if (!set) {
            set = new Set()
            this.notifHandlers.set(method, set)
        }
        set.add(handler)
        return () => {
            const s = this.notifHandlers.get(method)
            if (!s) return
            s.delete(handler)
            if (s.size === 0) this.notifHandlers.delete(method)
        }
    }

    writeFiles(files: Record<string, string>): void {
        if (this.disposed) return
        this.post({ type: 'fs:writeAll', files })
    }

    writeFile(path: string, content: string): void {
        if (this.disposed) return
        this.post({ type: 'fs:write', path, content })
    }

    deleteFile(path: string): void {
        if (this.disposed) return
        this.post({ type: 'fs:delete', path })
    }

    cancel(id: number | string): void {
        if (this.disposed) return
        const resolver = this.pending.get(id)
        if (!resolver) return
        this.pending.delete(id)
        // Tell clangd first; the local rejection might queue follow-up
        // requests we want clangd to see *after* this cancel.
        this.post({
            type: 'lsp',
            message: { jsonrpc: '2.0', method: '$/cancelRequest', params: { id } },
        })
        resolver.reject(new Error('cancelled'))
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.worker.removeEventListener('message', this.handleMessage)
        this.worker.removeEventListener('error', this.handleError)
        this.worker.terminate()
        // Unblock anyone awaiting ready() — worker is gone, no response coming.
        if (this.status.state === 'starting') {
            this.rejectReady(new Error('clangd disposed'))
        }
        this.rejectAllPending('clangd disposed')
        this.notifHandlers.clear()
        this.setStatus({ state: 'disposed' })
    }

    private rejectAllPending(message: string): void {
        for (const { reject } of this.pending.values()) {
            reject(new Error(message))
        }
        this.pending.clear()
    }

    private post(msg: ClientToWorker) {
        this.worker.postMessage(msg)
    }

    private setStatus(next: ClangdStatus) {
        this.status = next
        this.onStatus.emit(next)
    }

    private handleMessage = (e: MessageEvent<WorkerToClient>) => {
        const msg = e.data
        switch (msg.type) {
            case 'ready': {
                this.setStatus({ state: 'ready' })
                this.resolveReady()
                break
            }
            case 'progress': {
                this.setStatus({ state: 'starting', loaded: msg.loaded, total: msg.total })
                break
            }
            case 'lsp': {
                this.dispatchLsp(msg.message)
                break
            }
            case 'error': {
                const err = new Error(msg.message)
                if (this.status.state === 'starting') this.rejectReady(err)
                this.setStatus({ state: 'error', message: msg.message })
                // Pending requests will never get answers — fail them now.
                this.rejectAllPending(msg.message)
                console.error('[clangd]', msg.message)
                break
            }
        }
    }

    private handleError = (e: ErrorEvent) => {
        const message = e.message || 'unknown worker error'
        if (this.status.state === 'starting') this.rejectReady(new Error(message))
        this.setStatus({ state: 'error', message })
        console.error('[clangd] worker error', e)
    }

    private dispatchLsp(message: LspMessage) {
        // Response to one of our requests.
        if ('id' in message && ('result' in message || 'error' in message)) {
            const res = message as LspResponse
            const resolver = this.pending.get(res.id)
            if (!resolver) return
            this.pending.delete(res.id)
            if (res.error) resolver.reject(new Error(`${res.error.code}: ${res.error.message}`))
            else resolver.resolve(res.result)
            return
        }

        // Server-initiated request (e.g. window/workDoneProgress/create).
        // LSP requires a response or clangd's outgoing promise hangs.
        if ('id' in message && 'method' in message) {
            const req = message as LspRequest
            this.post({
                type: 'lsp',
                message: {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32601, message: `web-ide does not implement ${req.method}` },
                } as LspResponse,
            })
            return
        }

        // Plain notification.
        const notif = message as LspNotification
        if (!notif.method) return
        const handlers = this.notifHandlers.get(notif.method)
        if (!handlers) return
        for (const h of handlers) {
            try {
                h(notif.params)
            } catch (err) {
                console.warn('[clangd] notification handler threw', notif.method, err)
            }
        }
    }
}

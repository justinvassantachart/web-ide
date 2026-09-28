import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    let readyPromise: Promise<void>
    const order: string[] = []
    const files = new Map<string, string>()
    const client = {
        ready: vi.fn(() => readyPromise),
        writeFiles: vi.fn((input: Record<string, string>) => {
            order.push('files')
            for (const [path, text] of Object.entries(input)) files.set(path, text)
        }),
        request: vi.fn(async () => {
            order.push('initialize')
            // Initialization must see the complete workspace, including files
            // that have never had an editor model/didOpen notification.
            expect(files.get('/workspace/helper.h')).toBe('int sharedValue;')
        }),
        notify: vi.fn(() => { order.push('initialized') }),
        dispose: vi.fn(),
    }
    return {
        client, order, files,
        reset() {
            order.length = 0
            files.clear()
            readyPromise = new Promise<void>((resolve, reject) => {
                resolveReady = resolve
                rejectReady = reject
            })
        },
        resolve() { order.push('ready'); resolveReady() },
        reject(error: Error) { rejectReady(error) },
    }
})

vi.mock('../../src/clangd/ClangdClient', () => ({
    ClangdClient: class { constructor() { return harness.client } },
}))

import { bootClangd } from '../../src/clangd/bootstrap'

const files = {
    '/workspace/main.cpp': '#include "helper.h"\nint main() { return sharedValue; }',
    '/workspace/helper.h': 'int sharedValue;',
}

beforeEach(() => {
    vi.clearAllMocks()
    harness.reset()
})

describe('clangd worker bootstrap ordering', () => {
    it('waits for the worker listener before seeding unopened headers and initializing', async () => {
        const pending = bootClangd(files)
        expect(harness.client.writeFiles).not.toHaveBeenCalled()
        expect(harness.client.request).not.toHaveBeenCalled()
        harness.resolve()
        await expect(pending).resolves.toBe(harness.client)
        expect(harness.order).toEqual(['ready', 'files', 'initialize', 'initialized'])
        expect(harness.client.writeFiles).toHaveBeenCalledExactlyOnceWith(files)
        expect(harness.client.dispose).not.toHaveBeenCalled()
    })

    it('does not send files to a worker that fails before readiness', async () => {
        const pending = bootClangd(files)
        const rejection = expect(pending).rejects.toThrow('worker boot failed')
        harness.reject(new Error('worker boot failed'))
        await rejection
        expect(harness.client.writeFiles).not.toHaveBeenCalled()
        expect(harness.client.request).not.toHaveBeenCalled()
        expect(harness.client.dispose).toHaveBeenCalledOnce()
    })

    it('disposes the worker if initialization fails after files are seeded', async () => {
        harness.client.request.mockRejectedValueOnce(new Error('initialization failed'))
        const pending = bootClangd(files)
        const rejection = expect(pending).rejects.toThrow('initialization failed')
        harness.resolve()
        await rejection
        expect(harness.client.writeFiles).toHaveBeenCalledExactlyOnceWith(files)
        expect(harness.client.notify).not.toHaveBeenCalled()
        expect(harness.client.dispose).toHaveBeenCalledOnce()
    })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const createEngine = vi.hoisted(() => vi.fn())
vi.mock('debugger-sh-upstream', () => ({
  Engine: { create: createEngine },
  toolchainProvenance: { cpp: { sha256: { llvm: 'compiler', sysroot: 'sysroot' } } },
  Duplex: class extends EventEmitter {
    readonly from = { flow: vi.fn() }
    readonly write = vi.fn(async () => {})
    readonly close = vi.fn()
  },
}))

import { UpstreamEngineAdapter } from '../../src/runtimes/UpstreamEngineAdapter'
import { createCppRuntimeProvider, createPythonRuntimeProvider } from '../../src/runtimes/providers'
import type { RuntimeHostDevice } from '../../src/web-ide/contracts/runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class FakeProcess {
  private readonly completion = deferred<{ exitCode: number; killed: boolean; error?: { type: 'load'; message: string } }>()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { closed: false, write: vi.fn(async () => {}), close: vi.fn(() => { this.stdin.closed = true }) }
  readonly debugger = { dap: Object.assign(new EventEmitter(), { send: vi.fn(() => ({ success: true })) }) }
  readonly kill = vi.fn(() => this.finish(137, true))
  then = this.completion.promise.then.bind(this.completion.promise)
  finish(exitCode = 0, killed = false, error?: { type: 'load'; message: string }) { this.completion.resolve({ exitCode, killed, ...(error ? { error } : {}) }) }
}

class FakeEngine {
  readonly files = new Map<string, string | Uint8Array>()
  readonly fs = {
    readDir: vi.fn(async () => [...new Set([...this.files.keys()].map(path => path.split('/')[1]))]),
    remove: vi.fn(async (path: string) => {
      for (const key of this.files.keys()) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key)
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, bytes: string | Uint8Array) => { this.files.set(path, bytes) }),
  }
  readonly processes: FakeProcess[] = []
  readonly run = vi.fn(() => { const process = new FakeProcess(); this.processes.push(process); return process })
  readonly dispose = vi.fn()
}

let engine: FakeEngine
const adapters: UpstreamEngineAdapter[] = []
beforeEach(() => { engine = new FakeEngine(); createEngine.mockReset().mockResolvedValue(engine) })
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.dispose())) })
async function create(language: 'c' | 'python' = 'python') {
  const adapter = await UpstreamEngineAdapter.create(language)
  adapters.push(adapter)
  adapter.fs = { 'main.py': 'print("ok")' }
  return adapter
}
async function spawned(index = 0) { await vi.waitFor(() => expect(engine.processes[index]).toBeDefined()); return { process: engine.processes[index] } }

describe('upstream adapter ownership and lifecycle', () => {
  it('requires an explicit valid backend and keeps existing providers lazy', () => {
    expect(() => createPythonRuntimeProvider({ backend: 'other' as 'upstream' })).toThrow('Unknown Engine backend')
    createPythonRuntimeProvider({ backend: 'upstream' })
    createCppRuntimeProvider({ backend: 'upstream' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('mounts owned text/binary snapshots and removes guest writes while preserving compiler objects', async () => {
    const adapter = await create()
    const bytes = new Uint8Array([0, 255, 128])
    adapter.binaryFiles = { '/image.bin': bytes }
    const first = adapter.run()
    bytes.fill(42)
    const { process } = await spawned()
    expect(engine.files.get('/image.bin')).toEqual(new Uint8Array([0, 255, 128]))
    expect(engine.run).toHaveBeenCalledWith('python', ['/main.py'], expect.objectContaining({ stdin: true }))
    engine.files.set('/guest-created.txt', 'do not carry forward')
    engine.files.set('/.web-ide-build/main.cpp.o', new Uint8Array([3]))
    process.finish()
    await first
    adapter.binaryFiles = {}
    const second = adapter.run()
    const { process: next } = await spawned(1)
    expect(engine.files.has('/guest-created.txt')).toBe(false)
    expect(engine.files.has('/image.bin')).toBe(false)
    expect(engine.files.has('/.web-ide-build/main.cpp.o')).toBe(true)
    next.finish()
    await second
  })

  it('Stop during an asynchronous mount prevents any process from starting', async () => {
    const adapter = await create()
    const blocked = deferred<void>()
    engine.fs.mkdir.mockImplementationOnce(() => blocked.promise)
    const run = adapter.run()
    await vi.waitFor(() => expect(engine.fs.mkdir).toHaveBeenCalled())
    const stop = adapter.cancelCurrentOperation()
    blocked.resolve()
    await expect(run).resolves.toEqual({ type: 'stopped' })
    await stop
    expect(engine.run).not.toHaveBeenCalled()
  })

  it('keeps one duplex path, aborts blocked host requests, and rejects old responses after rerun', async () => {
    const adapter = await create()
    const devices: RuntimeHostDevice[] = []
    const cleanup = vi.fn()
    adapter.hostDevice = (device) => { devices.push(device); return cleanup }
    const first = adapter.run()
    const { process } = await spawned()
    expect(engine.run.mock.calls[0]).toEqual(['python', ['/main.py'], expect.objectContaining({
      devices: { '/dev/debugger-sh-host': expect.any(Object) },
    })])
    const old = devices[0]
    await adapter.cancelCurrentOperation()
    expect(process.kill).toHaveBeenCalledOnce()
    expect(old.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(first).resolves.toEqual({ type: 'stopped' })
    const second = adapter.run()
    const { process: next } = await spawned(1)
    await expect(old.write(new Uint8Array([1]))).rejects.toThrow()
    expect(devices[1].signal.aborted).toBe(false)
    next.finish()
    await second
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('queues DAP initialization until the process exists, forwards output, and treats EOF as close', async () => {
    const adapter = await create()
    adapter.debugger.enabled = true
    const stdout: number[] = []
    adapter.stdout.on('data', chunk => stdout.push(...chunk))
    const run = adapter.run()
    adapter.debugger.send({ type: 'request', seq: 1, command: 'initialize', arguments: {} })
    const { process } = await spawned()
    expect(process.debugger.dap.send).toHaveBeenCalledWith(expect.objectContaining({ command: 'initialize' }))
    process.stdout.emit('data', new Uint8Array([0, 255]))
    await adapter.stdin.write('hello\n')
    await adapter.stdin.write('\x04')
    await adapter.stdin.write('input after EOF\n')
    expect(process.stdin.write).toHaveBeenCalledWith('hello\n')
    expect(process.stdin.write).toHaveBeenCalledOnce()
    expect(process.stdin.close).toHaveBeenCalledOnce()
    process.finish(7)
    await expect(run).resolves.toEqual({ type: 'completed', exitCode: 7 })
    expect(stdout).toEqual([0, 255])
  })

  it('retains PCH and archive inputs for compile-only work but never opens host devices', async () => {
    const adapter = await create('c')
    adapter.fs = { 'main.cpp': 'int main() { return 0; }' }
    adapter.cppArtifacts = { sources: ['/main.cpp'], precompiledHeader: '/course.pch', archives: ['/course.a'],
      requiredToolchain: { compilerSha256: 'compiler', sysrootSha256: 'sysroot', exceptionsSha256: 'sysroot' } }
    const opener = vi.fn()
    adapter.hostDevice = opener
    const run = adapter.compile()
    const { process } = await spawned()
    expect(engine.run).toHaveBeenCalledWith('cpp', expect.objectContaining({ compileOnly: true, debug: false,
      sources: ['main.cpp'], cxxFlags: expect.arrayContaining(['-include-pch', '/course.pch']), lldFlags: ['/course.a'] }))
    expect(opener).not.toHaveBeenCalled()
    process.finish()
    await run
    adapter.cppArtifacts.requiredToolchain!.compilerSha256 = 'legacy-compiler'
    await expect(adapter.run()).resolves.toMatchObject({ type: 'error', error: { message: expect.stringContaining('different C++ toolchain') } })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it('disposal is a barrier and never starts a replacement engine afterward', async () => {
    const adapter = await create()
    const run = adapter.run()
    await spawned()
    const disposing = adapter.dispose()
    await expect(run).resolves.toEqual({ type: 'stopped' })
    await disposing
    expect(engine.dispose).toHaveBeenCalledOnce()
    await expect(adapter.run()).rejects.toThrow('disposed')
  })

  it('distinguishes a runtime asset failure from a guest exit with the same code', async () => {
    const adapter = await create()
    const unavailable = adapter.run()
    const { process } = await spawned()
    process.finish(127, false, { type: 'load', message: 'Python runtime download unavailable' })
    await expect(unavailable).resolves.toEqual({ type: 'error', error: { type: 'EngineLoadError', message: 'Python runtime download unavailable' } })
    const guest = adapter.run()
    const { process: next } = await spawned(1)
    next.finish(127)
    await expect(guest).resolves.toEqual({ type: 'completed', exitCode: 127 })
  })

  it('cancels a deferred resource release without stopping the active program', async () => {
    const adapter = await create()
    const run = adapter.run()
    const { process } = await spawned()
    const controller = new AbortController()
    const release = adapter.releaseCompilerResources({ signal: controller.signal })
    controller.abort()
    await expect(release).resolves.toBe('cancelled')
    expect(process.kill).not.toHaveBeenCalled()
    expect(engine.dispose).not.toHaveBeenCalled()
    process.finish()
    await run
    await expect(adapter.releaseCompilerResources()).resolves.toBe('released')
    expect(engine.dispose).toHaveBeenCalledOnce()
  })
})

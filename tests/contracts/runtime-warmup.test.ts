import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Buffer as BrowserBuffer } from 'buffer/index.js'

const engineCreate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
vi.mock('debugger-sh', () => ({ Engine: { create: engineCreate } }))

import { createCppRuntimeProvider, cppRuntimeProvider } from '../../src/runtimes/providers'
import { buildRuntimeExecutionPlan, runtimeExecutionPlansEqual } from '../../src/runtimes/execution-plan'
import type { RuntimeExecutionPlan, RuntimeSession } from '../../src/web-ide/contracts/runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type Outcome = { type: 'completed'; exitCode: number } | { type: 'stopped' }
class Stream {
  listeners = new Set<(bytes: Uint8Array) => void>()
  on(_event: string, listener: (bytes: Uint8Array) => void) { this.listeners.add(listener) }
  emit(text: string) { for (const listener of this.listeners) listener(new TextEncoder().encode(text)) }
}
class Engine {
  fs = {}
  binaryFiles = {}
  cppArtifacts?: unknown
  hostDevice?: unknown
  stdout = new Stream()
  stderr = new Stream()
  debugger = { enabled: true, on: vi.fn(), send: vi.fn(() => ({ success: true })) }
  cacheStats = { entries: 2, latest: { compilerModule: { hits: 1 } } }
  stdin = { write: vi.fn() }
  pending = deferred<Outcome>()
  autoStop = true
  compile = vi.fn(() => this.pending.promise)
  run = vi.fn(async () => ({ type: 'completed', exitCode: 0 }))
  stop = vi.fn(() => { if (this.autoStop) this.pending.resolve({ type: 'stopped' }) })
}
const scope = { projectId: 'assignment', accountId: 'account' }
const input = (): RuntimeExecutionPlan => ({
  files: { '/workspace/main.cpp': 'int main() { return 1; }' },
  mode: 'run',
  binaryFiles: { '/sysroot/support.a': new Uint8Array([1, 2, 3]) },
  cppArtifacts: { sources: ['/workspace/main.cpp'], archives: ['/sysroot/support.a'] },
})
const sessions: RuntimeSession[] = []
class AliasingBytes extends Uint8Array {}
Object.defineProperty(AliasingBytes.prototype, 'slice', {
  value(this: AliasingBytes) { return this },
})
const byteInputs = [
  ['browser Buffer', () => BrowserBuffer.from([1, 2, 3])],
  ['slice-overriding subclass', () => new AliasingBytes([1, 2, 3])],
] as const
function session() {
  const value = createCppRuntimeProvider({ cpp: { scope, objectCache: true, retainWorker: true, cacheCompilerModule: true } }).createSession()
  sessions.push(value)
  return value
}
beforeEach(() => engineCreate.mockReset())
afterEach(async () => { for (const value of sessions.splice(0)) await value.disposeAndWait?.() })

describe('owned pure execution plans', () => {
  it.each(byteInputs)('owns %s inputs and every exposed binary snapshot', (_name, createBytes) => {
    const bytes = createBytes()
    const frozen = buildRuntimeExecutionPlan({ ...input(), binaryFiles: { '/sysroot/support.a': bytes } })
    bytes[0] = 9
    const exposed = frozen.binaryFiles!['/sysroot/support.a']
    exposed[1] = 9
    expect([...frozen.binaryFiles!['/sysroot/support.a']]).toEqual([1, 2, 3])
    expect(exposed.buffer).not.toBe(bytes.buffer)
    expect(frozen.binaryFiles!['/sysroot/support.a'].buffer).not.toBe(exposed.buffer)
  })

  it('preserves omitted optional fields for provider trust-boundary validation', () => {
    const frozen = buildRuntimeExecutionPlan({ files: { '/workspace/main.cpp': 'int main() {}' }, mode: 'run' })
    expect(Object.hasOwn(frozen, 'sourceAliases')).toBe(false)
    expect(Object.hasOwn(frozen, 'binaryFiles')).toBe(false)
    expect(Object.hasOwn(frozen, 'cppArtifacts')).toBe(false)
    expect(Object.hasOwn(frozen, 'entrypoint')).toBe(false)
    expect(Object.hasOwn(buildRuntimeExecutionPlan({ ...frozen, binaryFiles: {} }), 'binaryFiles')).toBe(true)
  })

  it('snapshots files, metadata and binary bytes without stream callbacks', () => {
    const plan = input()
    const finish = vi.fn(() => '')
    const frozen = buildRuntimeExecutionPlan({ ...plan, streamInterceptor: { push: (_stream, text) => text, finish } })
    plan.files['/workspace/main.cpp'] = 'edited'
    plan.binaryFiles!['/sysroot/support.a'][0] = 9
    frozen.binaryFiles!['/sysroot/support.a'][1] = 9
    expect(frozen.files['/workspace/main.cpp']).toContain('return 1')
    expect([...frozen.binaryFiles!['/sysroot/support.a']]).toEqual([1, 2, 3])
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.cppArtifacts?.archives)).toBe(true)
    expect(finish).not.toHaveBeenCalled()
  })
  it('compares complete binary contents, flags, aliases, entrypoint, profile and mode', () => {
    const original = buildRuntimeExecutionPlan(input())
    expect(runtimeExecutionPlansEqual(original, buildRuntimeExecutionPlan(input()))).toBe(true)
    for (const changed of [
      { ...input(), files: { '/workspace/main.cpp': 'int main() { return 2; }' } },
      { ...input(), mode: 'debug' as const },
      { ...input(), binaryFiles: { '/sysroot/support.a': new Uint8Array([1, 2, 4]) } },
      { ...input(), cppArtifacts: { ...input().cppArtifacts, precompiledHeader: '/sysroot/x.pch' } },
      { ...input(), sourceAliases: { '/workspace/main.cpp': '/workspace/original.cpp' } },
      { ...input(), entrypoint: '/workspace/main.cpp' },
    ]) expect(runtimeExecutionPlansEqual(original, buildRuntimeExecutionPlan(changed))).toBe(false)
  })
})

describe('compile-only runtime warmup', () => {
  it.each(byteInputs)('captures %s bytes before asynchronous engine initialization', async (_name, createBytes) => {
    const loading = deferred<unknown>()
    engineCreate.mockReturnValue(loading.promise)
    const engine = new Engine()
    const runtime = session()
    const bytes = createBytes()
    const warming = runtime.warmup!({ ...input(), binaryFiles: { '/sysroot/support.a': bytes } })
    bytes[0] = 9
    loading.resolve(engine)
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    expect(engine.binaryFiles).toEqual({ '/support.a': new Uint8Array([1, 2, 3]) })
    engine.pending.resolve({ type: 'completed', exitCode: 0 })
    expect((await warming).status).toBe('completed')
  })

  it('exposes fresh owned backend statistics only for an initialized configured session', async () => {
    const engine = new Engine()
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    expect(runtime.compilationStatistics!()).toBeUndefined()
    const warming = runtime.warmup!(input())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    engine.pending.resolve({ type: 'completed', exitCode: 0 })
    await warming
    const first = runtime.compilationStatistics!() as typeof engine.cacheStats
    first.entries = 99
    first.latest.compilerModule.hits = 99
    expect(runtime.compilationStatistics!()).toEqual(engine.cacheStats)
    expect((runtime.compilationStatistics!() as typeof first).entries).toBe(2)
    await runtime.disposeAndWait!()
    expect(runtime.compilationStatistics!()).toBeUndefined()
    const ordinary = cppRuntimeProvider.createSession()
    sessions.push(ordinary)
    expect(ordinary.compilationStatistics!()).toBeUndefined()
  })

  it('is default off and skips Debug and intercepted Tests without initialization', async () => {
    const ordinary = cppRuntimeProvider.createSession()
    sessions.push(ordinary)
    expect((await ordinary.warmup!(input())).status).toBe('skipped')
    const runtime = session()
    expect((await runtime.warmup!({ ...input(), mode: 'debug' })).status).toBe('skipped')
    expect((await runtime.warmup!({ ...input(), streamInterceptor: { push: (_s, t) => t, finish: () => '' } })).status).toBe('skipped')
    expect(engineCreate).not.toHaveBeenCalled()
  })
  it('compiles an owned snapshot with no terminal, exit, graphics or device callbacks', async () => {
    const engine = new Engine()
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    const events = vi.fn()
    for (const event of [runtime.events.stdout, runtime.events.stderr, runtime.events.terminalClear, runtime.events.exit, runtime.events.graphicsDraw]) event.subscribe(events)
    const device = vi.fn()
    runtime.registerHostDevice!(device)
    const plan = input()
    const task = runtime.warmup!(plan)
    plan.files['/workspace/main.cpp'] = 'edited'
    plan.binaryFiles!['/sysroot/support.a'][0] = 9
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    expect(engine.fs).toEqual({ 'main.cpp': 'int main() { return 1; }' })
    expect(engine.binaryFiles).toEqual({ '/support.a': new Uint8Array([1, 2, 3]) })
    engine.stderr.emit('compiler warning')
    engine.stdout.emit('compiler output')
    engine.pending.resolve({ type: 'completed', exitCode: 0 })
    const result = await task
    expect(result.status).toBe('completed')
    expect(result.diagnostics.join('')).toContain('compiler warning')
    expect(result.statistics).toEqual(engine.cacheStats)
    expect(engine.run).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
    expect(device).not.toHaveBeenCalled()
  })
  it('foreground preparation joins only an exactly matching plan and Run still executes fresh', async () => {
    const engine = new Engine()
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    const warmup = runtime.warmup!(input())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    let prepared = false
    const preparation = runtime.prepare(input()).then(result => { prepared = true; return result })
    await Promise.resolve()
    expect(prepared).toBe(false)
    expect(engine.stop).not.toHaveBeenCalled()
    engine.pending.resolve({ type: 'completed', exitCode: 0 })
    await warmup
    expect((await preparation).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
    expect(engine.stdout.listeners.size).toBe(1)
    expect(engine.stderr.listeners.size).toBe(1)
  })
  it('semantic and binary edits cancel and drain before foreground engine mutation', async () => {
    const engine = new Engine()
    engine.autoStop = false
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    const warmup = runtime.warmup!(input())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    const edited = input()
    edited.files['/workspace/main.cpp'] = 'int main() { return 2; }'
    edited.binaryFiles!['/sysroot/support.a'][2] = 4
    let prepared = false
    const foreground = runtime.prepare(edited).then(value => { prepared = true; return value })
    expect(engine.stop).toHaveBeenCalledOnce()
    expect(prepared).toBe(false)
    expect(engine.run).not.toHaveBeenCalled()
    engine.pending.resolve({ type: 'stopped' })
    expect((await warmup).status).toBe('cancelled')
    expect((await foreground).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.fs).toEqual({ 'main.cpp': 'int main() { return 2; }' })
    expect(engine.binaryFiles).toEqual({ '/support.a': new Uint8Array([1, 2, 4]) })
  })
  it('Stop during initialization prevents compilation and stale preparation side effects', async () => {
    const loading = deferred<unknown>()
    engineCreate.mockReturnValue(loading.promise)
    const runtime = session()
    const events = vi.fn()
    runtime.events.terminalClear.subscribe(events)
    const warmup = runtime.warmup!(input())
    const foreground = runtime.prepare(input())
    const stopped = runtime.stopAndWait!()
    const engine = new Engine()
    loading.resolve(engine)
    await stopped
    expect((await warmup).status).toBe('cancelled')
    expect((await foreground).success).toBe(false)
    expect(engine.compile).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
  })
  it('failed warmup is bounded, diagnostically visible and does not retry', async () => {
    const engine = new Engine()
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    const diagnostic = vi.fn()
    runtime.events.diagnostic.subscribe(diagnostic)
    const warmup = runtime.warmup!(input())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    engine.stderr.emit('x'.repeat(80_000))
    engine.pending.resolve({ type: 'completed', exitCode: 1 })
    const result = await warmup
    expect(result.status).toBe('failed')
    expect(result.diagnostics.join('').length).toBeLessThan(66_000)
    expect(result.diagnostics.join('')).toContain('truncated')
    expect(diagnostic).toHaveBeenCalledOnce()
    expect(engine.compile).toHaveBeenCalledOnce()
    expect((await runtime.prepare(input())).success).toBe(true)
  })

  it('disposal drains an active compile and releases retained execution inputs', async () => {
    const engine = new Engine()
    engineCreate.mockResolvedValue(engine)
    const runtime = session()
    const warmup = runtime.warmup!(input())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    await runtime.disposeAndWait!()
    expect((await warmup).status).toBe('cancelled')
    expect(engine.stop).toHaveBeenCalledOnce()
    expect(engine.fs).toEqual({})
    expect(engine.binaryFiles).toEqual({})
    expect(engine.cppArtifacts).toBeUndefined()
    const output = vi.fn()
    runtime.events.stdout.subscribe(output)
    engine.stdout.emit('late')
    expect(output).not.toHaveBeenCalled()
  })
})

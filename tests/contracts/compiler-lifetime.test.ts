import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeExecutionPlan, RuntimeSession } from '../../src/web-ide/contracts/runtime'

const create = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
vi.mock('debugger-sh', () => ({ Engine: { create } }))
import { createCppRuntimeProvider } from '../../src/runtimes/providers'
import { notifyRuntimeForegroundIntent } from '../../src/runtimes/foreground-intent'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type Result = { type: 'completed'; exitCode: number } | { type: 'stopped' }
const completed = { type: 'completed', exitCode: 0 } as const
class Engine {
  fs = {}
  binaryFiles = {}
  cppArtifacts?: unknown
  hostDevice?: unknown
  stdout = { on: vi.fn() }
  stderr = { on: vi.fn() }
  stdin = { write: vi.fn() }
  debugger = { enabled: false, on: vi.fn(), send: vi.fn() }
  cacheStats: { toolchainProfile: string; cacheEligible?: boolean; cacheEligibilityReason?: string } = { toolchainProfile: 'cache-receipt-v1' }
  pending = deferred<Result>()
  prepareCompiler = vi.fn<(_options?: { validateCacheInputs?: boolean }) => Promise<Result>>(async () => completed)
  compile = vi.fn(() => this.pending.promise)
  run = vi.fn(async (): Promise<Result> => completed)
  cancelCurrentOperation = vi.fn(async () => { this.pending.resolve({ type: 'stopped' }) })
  releaseCompilerResources = vi.fn(async (_options?: { signal?: AbortSignal }): Promise<'released' | 'cancelled'> => _options?.signal?.aborted ? 'cancelled' : 'released')
  stop = vi.fn(() => { this.pending.resolve({ type: 'stopped' }) })
  dispose = vi.fn(async () => { this.pending.resolve({ type: 'stopped' }) })
}
const plan = (): RuntimeExecutionPlan => ({ files: { '/workspace/main.cpp': 'int main() {}' }, mode: 'run' })
const sessions: RuntimeSession[] = []
function session(options: { preserve?: boolean; eager?: boolean; cache?: boolean | { maxEntries: number } } = {}) {
  const result = createCppRuntimeProvider({
    cpp: { scope: { accountId: 'a', projectId: 'p' }, objectCache: options.cache ?? true },
    preserveCompilerOnCancel: options.preserve ?? true,
    eagerCompilerReseedAfterStop: options.eager ?? false,
  }).createSession()
  sessions.push(result)
  return result
}
beforeEach(() => create.mockReset())
afterEach(async () => { for (const runtime of sessions.splice(0)) await runtime.disposeAndWait?.() })

describe('compiler lifecycle and foreground ownership', () => {
  it('does not initialize to release, suspend, resume, or dispose', async () => {
    const runtime = session()
    expect(await runtime.releaseCompilerResources!()).toBe('released')
    await runtime.suspendRuntime!()
    expect((await runtime.prepare(plan())).success).toBe(false)
    await runtime.resumeRuntime!()
    await runtime.disposeAndWait!()
    expect(create).not.toHaveBeenCalled()
  })

  it('disposes a late factory exactly once and never adopts or runs it', async () => {
    const loading = deferred<unknown>()
    create.mockReturnValue(loading.promise)
    const runtime = session()
    const preparation = runtime.prepareCompiler!()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const closing = runtime.disposeAndWait!()
    expect(runtime.disposeAndWait!()).toBe(closing)
    const engine = new Engine()
    loading.resolve(engine)
    await Promise.all([closing, preparation])
    expect(engine.dispose).toHaveBeenCalledOnce()
    expect(engine.prepareCompiler).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
  })

  it('claims toolchain preparation without dispatching the pending background TU', async () => {
    const engine = new Engine()
    const preparation = deferred<Result>()
    engine.prepareCompiler.mockReturnValue(preparation.promise)
    create.mockResolvedValue(engine)
    const runtime = session()
    const warming = runtime.warmup!(plan())
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledOnce())
    const foreground = runtime.prepare(plan())
    await runtime.cancelWarmupAndWait!()
    expect(engine.cancelCurrentOperation).not.toHaveBeenCalled()
    preparation.resolve(completed)
    expect((await foreground).success).toBe(true)
    await warming
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it.each(['before-wrapper', 'during-preparation'] as const)('honors early foreground intent before a complete foreground plan (%s)', async phase => {
    const engine = new Engine()
    const preparation = deferred<Result>()
    engine.prepareCompiler.mockReturnValue(preparation.promise)
    create.mockResolvedValue(engine)
    const runtime = session()
    const foregroundIntent = new AbortController()
    if (phase === 'before-wrapper') foregroundIntent.abort()
    const warming = runtime.warmup!(plan(), { foregroundIntent: foregroundIntent.signal })
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledOnce())
    foregroundIntent.abort()
    await runtime.cancelWarmupAndWait!()
    expect(engine.cancelCurrentOperation).not.toHaveBeenCalled()
    preparation.resolve(completed)
    await warming
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
    expect((await runtime.prepare(plan())).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it('protects a matching dispatched warmup from background cancellation but Stop fences start', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session()
    const warming = runtime.warmup!(plan())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    const foreground = runtime.prepare(plan())
    await runtime.cancelWarmupAndWait!()
    expect(engine.cancelCurrentOperation).not.toHaveBeenCalled()
    engine.pending.resolve(completed)
    expect((await foreground).success).toBe(true)
    await warming
    await runtime.stopAndWait!({ reason: 'user' })
    await runtime.start({ mode: 'run' })
    expect(engine.run).not.toHaveBeenCalled()
    expect((await runtime.warmup!(plan())).reason).toBe('already-attempted')
  })

  it('cancels a changed snapshot and preserves configured cancellation policy', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session()
    const warming = runtime.warmup!(plan())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    expect((await runtime.prepare({ ...plan(), files: { '/workspace/main.cpp': 'int main() { return 2; }' } })).success).toBe(true)
    expect((await warming).status).toBe('cancelled')
    expect(engine.cancelCurrentOperation).toHaveBeenCalledOnce()
    expect(engine.stop).not.toHaveBeenCalled()
    await runtime.start({ mode: 'run' })
    expect(engine.fs).toEqual({ 'main.cpp': 'int main() { return 2; }' })
  })

  it.each([false, { maxEntries: 0 }])('only prepares the compiler with disabled/zero cache %j', async cache => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session({ cache })
    expect((await runtime.warmup!(plan())).status).toBe('completed')
    expect(engine.prepareCompiler).toHaveBeenCalledOnce()
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
  })

  it('does not compile student TUs for an unsupported cache profile', async () => {
    const engine = new Engine()
    engine.cacheStats.toolchainProfile = 'legacy'
    create.mockResolvedValue(engine)
    const runtime = session()
    expect((await runtime.warmup!(plan())).status).toBe('completed')
    expect(engine.compile).not.toHaveBeenCalled()
  })

  it('validates the owned stock plan before compiling and never trusts a profile name alone', async () => {
    const engine = new Engine()
    engine.cacheStats.toolchainProfile = 'stock-certified-v1'
    const loading = deferred<unknown>()
    create.mockReturnValue(loading.promise)
    const runtime = session()
    const input = { ...plan(), binaryFiles: { '/sysroot/support.pch': new Uint8Array([1, 2]) },
      cppArtifacts: { precompiledHeader: '/sysroot/support.pch', cacheCertificate: '{ "exact": 1 }' } }
    engine.prepareCompiler.mockImplementation(async options => {
      expect(options).toEqual({ validateCacheInputs: true })
      expect(engine.fs).toEqual({ 'main.cpp': 'int main() {}' })
      expect(engine.binaryFiles).toEqual({ '/support.pch': new Uint8Array([1, 2]) })
      expect(engine.cppArtifacts).toMatchObject({ precompiledHeader: '/support.pch', cacheCertificate: '{ "exact": 1 }' })
      engine.cacheStats.cacheEligible = true
      return completed
    })
    const warming = runtime.warmup!(input)
    input.files['/workspace/main.cpp'] = 'changed'
    input.binaryFiles['/sysroot/support.pch'][0] = 9
    input.cppArtifacts.cacheCertificate = '{}'
    loading.resolve(engine)
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    engine.pending.resolve(completed)
    expect((await warming).status).toBe('completed')
    expect(engine.prepareCompiler).toHaveBeenCalledOnce()
    expect(engine.run).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('keeps stock ineligible preparation silent without dispatch (%s)', async cacheEligible => {
    const engine = new Engine()
    engine.cacheStats = { toolchainProfile: 'stock-certified-v1', cacheEligible, cacheEligibilityReason: 'stock-temporal' }
    create.mockResolvedValue(engine)
    const runtime = session()
    const diagnostic = vi.fn()
    runtime.events.diagnostic.subscribe(diagnostic)
    const result = await runtime.warmup!(plan())
    expect(result).toMatchObject({ status: 'skipped', reason: 'stock-temporal', diagnostics: [] })
    expect(engine.prepareCompiler).toHaveBeenCalledWith({ validateCacheInputs: true })
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
    expect(diagnostic).not.toHaveBeenCalled()
    expect((await runtime.prepare(plan())).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it.each(['foreground', 'zero-capacity', 'explicit-prepare'] as const)('does not scan stock inputs for %s toolchain preparation', async reason => {
    const engine = new Engine()
    engine.cacheStats = { toolchainProfile: 'stock-certified-v1', cacheEligible: true }
    create.mockResolvedValue(engine)
    const runtime = session({ cache: reason === 'zero-capacity' ? { maxEntries: 0 } : true })
    const intent = new AbortController()
    intent.abort()
    if (reason === 'explicit-prepare') await runtime.prepareCompiler!()
    else await runtime.warmup!(plan(), reason === 'foreground' ? { foregroundIntent: intent.signal } : undefined)
    expect(engine.prepareCompiler).toHaveBeenCalledExactlyOnceWith()
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.cppArtifacts).toBeUndefined()
  })

  it('lets foreground intent claim in-progress stock validation without dispatching a background TU', async () => {
    const engine = new Engine()
    engine.cacheStats = { toolchainProfile: 'stock-certified-v1', cacheEligible: true }
    const validation = deferred<Result>()
    engine.prepareCompiler.mockReturnValue(validation.promise)
    create.mockResolvedValue(engine)
    const runtime = session(), intent = new AbortController()
    const warming = runtime.warmup!(plan(), { foregroundIntent: intent.signal })
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledWith({ validateCacheInputs: true }))
    intent.abort()
    validation.resolve(completed)
    await warming
    expect(engine.compile).not.toHaveBeenCalled()
    expect((await runtime.prepare(plan())).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it('drains a prior toolchain-only preparation before validating the initial stock snapshot', async () => {
    const engine = new Engine()
    engine.cacheStats.toolchainProfile = 'stock-certified-v1'
    const preparation = deferred<Result>()
    engine.prepareCompiler.mockReturnValueOnce(preparation.promise).mockImplementation(async options => {
      expect(options).toEqual({ validateCacheInputs: true })
      engine.cacheStats.cacheEligible = true
      return completed
    })
    create.mockResolvedValue(engine)
    const runtime = session()
    const preparing = runtime.prepareCompiler!()
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledOnce())
    const warming = runtime.warmup!(plan())
    expect(engine.compile).not.toHaveBeenCalled()
    preparation.resolve(completed)
    await preparing
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    expect(engine.prepareCompiler).toHaveBeenCalledTimes(2)
    engine.pending.resolve(completed)
    expect((await warming).status).toBe('completed')
  })

  it.each(['legacy', 'cache-receipt-v1', 'stock-certified-v1'])('joins prior preparation without a redundant validation for %s when no stock scan is needed', async profile => {
    const engine = new Engine(), preparation = deferred<Result>()
    engine.cacheStats.toolchainProfile = profile
    engine.prepareCompiler.mockReturnValue(preparation.promise)
    create.mockResolvedValue(engine)
    const runtime = session({ cache: profile === 'stock-certified-v1' ? { maxEntries: 0 } : true })
    const preparing = runtime.prepareCompiler!()
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledOnce())
    const warming = runtime.warmup!(plan())
    preparation.resolve(completed)
    engine.pending.resolve(completed)
    await Promise.all([preparing, warming])
    expect(engine.prepareCompiler).toHaveBeenCalledExactlyOnceWith()
    expect(engine.compile).toHaveBeenCalledTimes(profile === 'cache-receipt-v1' ? 1 : 0)
  })

  it('aborts pending release at prepare and defers a new release across prepare→start', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session()
    await runtime.prepareCompiler!()
    await runtime.prepare(plan())
    const released = runtime.releaseCompilerResources!()
    expect(engine.releaseCompilerResources).not.toHaveBeenCalled()
    await runtime.prepare(plan())
    expect(await released).toBe('cancelled')
    const nextRelease = runtime.releaseCompilerResources!()
    await runtime.start({ mode: 'run' })
    expect(await nextRelease).toBe('released')
    expect(engine.releaseCompilerResources).toHaveBeenCalledOnce()
  })

  it('preserves conservative Stop for a generic consumer on the new engine', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session({ preserve: false })
    await runtime.prepareCompiler!()
    await runtime.stopAndWait!()
    expect(engine.stop).toHaveBeenCalledOnce()
    expect(engine.cancelCurrentOperation).not.toHaveBeenCalled()
    expect(runtime.capabilities.compileOnlyJoin).toBeUndefined()
  })

  it('suspends immediately, drains the old operation, and resumes lazily', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session()
    const warming = runtime.warmup!(plan())
    await vi.waitFor(() => expect(engine.compile).toHaveBeenCalledOnce())
    const suspended = runtime.suspendRuntime!()
    expect(engine.cancelCurrentOperation).toHaveBeenCalledOnce()
    expect((await runtime.prepare(plan())).success).toBe(false)
    await suspended
    await warming
    expect(engine.releaseCompilerResources).toHaveBeenCalledOnce()
    await runtime.resumeRuntime!()
    expect(engine.prepareCompiler).toHaveBeenCalledOnce()
    expect((await runtime.prepare(plan())).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledOnce()
  })

  it('awaits disposal failures from a late factory without adopting its resources', async () => {
    const loading = deferred<unknown>()
    create.mockReturnValue(loading.promise)
    const runtime = session()
    const preparing = runtime.prepareCompiler!()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const closing = runtime.disposeAndWait!()
    const engine = new Engine()
    engine.dispose.mockRejectedValue(new Error('device cleanup failed'))
    loading.resolve(engine)
    await expect(closing).rejects.toThrow('Runtime disposal failed')
    await preparing
    expect(engine.prepareCompiler).not.toHaveBeenCalled()
    sessions.splice(sessions.indexOf(runtime), 1)
  })

  it.each(['new-foreground', 'test-workflow'] as const)('does not reseed after Stop when %s owns the intent', async reason => {
    const engine = new Engine()
    const activeRun = deferred<Result>()
    engine.run.mockReturnValueOnce(activeRun.promise)
    engine.cancelCurrentOperation.mockImplementation(async () => { activeRun.resolve({ type: 'stopped' }) })
    create.mockResolvedValue(engine)
    const runtime = session({ eager: true })
    const prepared = plan()
    if (reason === 'test-workflow') prepared.streamInterceptor = { push: (_stream, text) => text, finish: () => '' }
    await runtime.prepare(prepared)
    const running = runtime.start({ mode: 'run' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledOnce())
    const stopped = runtime.stopAndWait!({ reason: 'user' })
    if (reason === 'new-foreground') notifyRuntimeForegroundIntent(runtime)
    await stopped
    await running
    await Promise.resolve()
    expect(engine.prepareCompiler).not.toHaveBeenCalled()
  })

  it('post-Stop reseeding prepares once and an immediate Run joins it', async () => {
    const engine = new Engine()
    engine.cacheStats.toolchainProfile = 'stock-certified-v1'
    const activeRun = deferred<Result>()
    engine.run.mockReturnValueOnce(activeRun.promise)
    engine.cancelCurrentOperation.mockImplementation(async () => { activeRun.resolve({ type: 'stopped' }) })
    const preparation = deferred<Result>()
    engine.prepareCompiler.mockReturnValue(preparation.promise)
    create.mockResolvedValue(engine)
    const runtime = session({ eager: true })
    await runtime.prepare(plan())
    const running = runtime.start({ mode: 'run' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledOnce())
    await runtime.stopAndWait!({ reason: 'user' })
    await running
    await vi.waitFor(() => expect(engine.prepareCompiler).toHaveBeenCalledOnce())
    expect(engine.prepareCompiler).toHaveBeenCalledExactlyOnceWith()
    const foreground = runtime.prepare(plan())
    let ready = false
    void foreground.then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    preparation.resolve(completed)
    expect((await foreground).success).toBe(true)
    await runtime.start({ mode: 'run' })
    expect(engine.run).toHaveBeenCalledTimes(2)
    expect(engine.compile).not.toHaveBeenCalled()
    await runtime.stopAndWait!({ reason: 'user' })
    expect(engine.prepareCompiler).toHaveBeenCalledOnce()
  })

  it('release follows an existing factory and passes its abortable request to the engine', async () => {
    const loading = deferred<unknown>()
    create.mockReturnValue(loading.promise)
    const runtime = session()
    const preparation = runtime.prepareCompiler!()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const release = runtime.releaseCompilerResources!({ signal: controller.signal })
    const engine = new Engine()
    loading.resolve(engine)
    await preparation
    expect(await release).toBe('released')
    expect(engine.releaseCompilerResources).toHaveBeenCalledOnce()
    expect(engine.releaseCompilerResources.mock.calls[0][0]?.signal).toBeInstanceOf(AbortSignal)
    expect(create).toHaveBeenCalledOnce()
  })


  it('settles the run and disposes resources when an exit listener throws', async () => {
    const engine = new Engine()
    create.mockResolvedValue(engine)
    const runtime = session()
    runtime.events.exit.subscribe(() => { throw new Error('host exit callback failed') })
    await runtime.prepare(plan())
    await expect(runtime.start({ mode: 'run' })).rejects.toThrow('host exit callback failed')
    expect(await runtime.waitForSettlement!()).toEqual(completed)
    await runtime.disposeAndWait!()
    expect(engine.dispose).toHaveBeenCalledOnce()
  })

})

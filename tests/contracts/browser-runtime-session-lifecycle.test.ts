import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineCreate = vi.hoisted(() =>
  vi.fn<(language: string) => Promise<unknown>>(),
)

vi.mock('debugger-sh', () => ({
  Engine: { create: engineCreate },
}))

import { cppRuntimeProvider } from '../../src/runtimes/providers'
import type {
  RuntimeExecutionMode,
  RuntimeSession,
} from '../../src/web-ide/contracts/runtime'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly settled: boolean
  resolve(value: T): void
}

interface FakeRunError {
  type: 'error'
  error: { type: string; message: string }
}

type FakeRunResult =
  | { type: 'completed'; exitCode: number }
  | { type: 'stopped' }
  | FakeRunError

interface DapRequest {
  command: string
  arguments?: Record<string, unknown>
}

interface DapResponse {
  success?: boolean
  body?: Record<string, unknown>
}

function deferred<T>(): Deferred<T> {
  let settled = false
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value) {
      if (settled) return
      settled = true
      settle(value)
    },
  }
}

class FakeDataStream {
  private readonly listeners = new Set<(chunk: Uint8Array) => void>()

  readonly on = vi.fn(
    (_event: 'data', listener: (chunk: Uint8Array) => void): void => {
      this.listeners.add(listener)
    },
  )

  emit(text: string): void {
    this.emitBytes(new TextEncoder().encode(text))
  }

  emitBytes(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk)
  }
}

class FakeDebugger {
  enabled = false
  readonly requests: DapRequest[] = []
  responder: (request: DapRequest) => DapResponse = () => ({ success: true })
  private readonly listeners = new Set<(message: unknown) => void>()

  readonly on = vi.fn(
    (_event: 'event', listener: (message: unknown) => void): void => {
      this.listeners.add(listener)
    },
  )

  readonly send = vi.fn((message: unknown): DapResponse => {
    const request = message as DapRequest
    this.requests.push(request)
    return this.responder(request)
  })

  emit(event: string, body?: Record<string, unknown>): void {
    const message = { type: 'event', event, body }
    for (const listener of this.listeners) listener(message)
  }
}

class FakeEngine {
  fs: Record<string, unknown> = {}
  readonly stdout = new FakeDataStream()
  readonly stderr = new FakeDataStream()
  readonly stdin = { write: vi.fn(() => Promise.resolve()) }
  readonly debugger = new FakeDebugger()
  readonly calls: string[] = []
  settleRunOnStop = true
  private readonly runs: Deferred<FakeRunResult>[] = []

  readonly run = vi.fn((): Promise<FakeRunResult> => {
    this.calls.push('run')
    const invocation = deferred<FakeRunResult>()
    this.runs.push(invocation)
    return invocation.promise
  })

  readonly stop = vi.fn((): void => {
    if (this.settleRunOnStop) this.activeRun()?.resolve({ type: 'stopped' })
  })

  complete(result: FakeRunResult): void {
    const active = this.activeRun()
    if (!active) throw new Error('No active fake run')
    active.resolve(result)
  }

  private activeRun(): Deferred<FakeRunResult> | undefined {
    return [...this.runs].reverse().find((run) => !run.settled)
  }
}

const sessions: RuntimeSession[] = []
const workspace = { '/workspace/main.cpp': 'int main() { return 0; }' }

function createSession(): RuntimeSession {
  const session = cppRuntimeProvider.createSession()
  sessions.push(session)
  return session
}

async function beginRun(
  session: RuntimeSession,
  engine: FakeEngine,
  mode: RuntimeExecutionMode,
): Promise<{ running: Promise<void> }> {
  await session.prepare({ files: workspace, mode })
  const running = session.start({ mode })
  await vi.waitFor(() => expect(engine.run).toHaveBeenCalled())
  return { running }
}

function commands(engine: FakeEngine, command: string): DapRequest[] {
  return engine.debugger.requests.filter((request) => request.command === command)
}

beforeEach(() => {
  engineCreate.mockReset()
})

afterEach(() => {
  for (const session of sessions.splice(0).reverse()) session.dispose?.()
  vi.useRealTimers()
})

describe('BrowserRuntimeSession run lifecycle', () => {
  it('publishes one stable completed settlement without changing the void start API', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    engineCreate.mockResolvedValueOnce(engine)

    const { running } = await beginRun(adapter, engine, 'run')
    const firstSettlement = adapter.waitForSettlement!()
    const sameSettlement = adapter.waitForSettlement!()
    expect(sameSettlement).toBe(firstSettlement)

    engine.complete({ type: 'completed', exitCode: 7 })

    await expect(running).resolves.toBeUndefined()
    await expect(firstSettlement).resolves.toEqual({
      type: 'completed',
      exitCode: 7,
    })
    expect(adapter.stopAndWait!()).toBe(firstSettlement)
    expect(engine.stop).not.toHaveBeenCalled()
  })

  it('shares one pending stopped settlement across repeated running stops', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const exits: number[] = []
    engineCreate.mockResolvedValueOnce(engine)
    engine.settleRunOnStop = false
    adapter.events.exit.subscribe((code) => exits.push(code))

    const { running } = await beginRun(adapter, engine, 'run')
    const pendingSettlement = adapter.waitForSettlement!()
    const firstStop = adapter.stopAndWait!()
    const repeatedStop = adapter.stopAndWait!()

    expect(firstStop).toBe(pendingSettlement)
    expect(repeatedStop).toBe(firstStop)
    let stopSettled = false
    void firstStop.then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)
    engine.complete({ type: 'stopped' })
    await expect(firstStop).resolves.toEqual({ type: 'stopped' })
    await running
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([0])
  })

  it('awaits the same stopped settlement when a debug session is paused', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    const paused = vi.fn()
    engineCreate.mockResolvedValueOnce(engine)
    engine.debugger.responder = ({ command }) => {
      if (command === 'stackTrace') {
        return {
          success: true,
          body: {
            stackFrames: [
              { id: 1, name: 'main', line: 3, source: { path: '/main.cpp' } },
            ],
          },
        }
      }
      if (command === 'scopes') return { success: true, body: { scopes: [] } }
      return { success: true }
    }
    adapter.events.debugPaused.subscribe(paused)

    const { running } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('stopped', { threadId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(paused).toHaveBeenCalledTimes(1)

    const pendingSettlement = adapter.waitForSettlement!()
    expect(adapter.stopAndWait!()).toBe(pendingSettlement)
    await expect(pendingSettlement).resolves.toEqual({ type: 'stopped' })
    await running
    expect(engine.stop).toHaveBeenCalledTimes(1)
  })

  it('preserves run-before-initialize ordering and retries configuration until acknowledged', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    const exits: number[] = []
    let configurationAttempts = 0
    engineCreate.mockResolvedValueOnce(engine)
    engine.debugger.responder = ({ command }) => {
      engine.calls.push(command)
      if (command === 'configurationDone') {
        configurationAttempts += 1
        return { success: configurationAttempts >= 2 }
      }
      return { success: true }
    }
    adapter.events.exit.subscribe((code) => exits.push(code))

    const { running } = await beginRun(adapter, engine, 'debug')

    expect(engine.calls.slice(0, 2)).toEqual(['run', 'initialize'])
    engine.debugger.emit('initialized')
    expect(commands(engine, 'configurationDone')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(0)
    expect(commands(engine, 'configurationDone')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(49)
    expect(commands(engine, 'configurationDone')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(commands(engine, 'configurationDone')).toHaveLength(2)
    expect(engine.debugger.requests.map(({ command }) => command)).toEqual([
      'initialize',
      'setBreakpoints',
      'setExceptionBreakpoints',
      'configurationDone',
      'setBreakpoints',
      'setExceptionBreakpoints',
      'configurationDone',
    ])

    engine.complete({ type: 'completed', exitCode: 7 })
    await running

    expect(exits).toEqual([7])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds debugger configuration retries and terminates a blocked session', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    const exits: number[] = []
    const errors: string[] = []
    engineCreate.mockResolvedValueOnce(engine)
    engine.debugger.responder = ({ command }) => ({
      success: command !== 'configurationDone',
    })
    adapter.events.exit.subscribe((code) => exits.push(code))
    adapter.events.stderr.subscribe((text) => errors.push(text))

    const { running } = await beginRun(adapter, engine, 'debug')
    const settlement = adapter.waitForSettlement!()
    engine.debugger.emit('initialized')
    await vi.advanceTimersByTimeAsync(120_000)
    await running

    expect(commands(engine, 'configurationDone').length).toBeGreaterThan(1)
    expect(commands(engine, 'configurationDone').length).toBeLessThan(3_000)
    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
    expect(errors.join('')).toContain('Debugger configuration timed out')
    await expect(settlement).resolves.toEqual({
      type: 'error',
      error: {
        type: 'DebuggerConfigurationError',
        message: 'Debugger configuration timed out before the runtime became ready.',
      },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a failed stackTrace once and cancels the retry when its session stops', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    const pauses: number[] = []
    let stackAttempts = 0
    let stackReady = true
    engineCreate.mockResolvedValueOnce(engine)
    engine.debugger.responder = ({ command }) => {
      if (command === 'stackTrace') {
        stackAttempts += 1
        if (!stackReady || stackAttempts === 1) return { success: false }
        return {
          success: true,
          body: {
            stackFrames: [
              { id: 1, name: 'main', line: 8, source: { path: '/main.cpp' } },
            ],
          },
        }
      }
      if (command === 'scopes') {
        return { success: true, body: { scopes: [] } }
      }
      return { success: true }
    }
    adapter.events.debugPaused.subscribe(({ line }) => pauses.push(line ?? -1))

    const { running } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('initialized')
    await vi.advanceTimersByTimeAsync(0)
    engine.debugger.emit('stopped', { threadId: 1 })

    await vi.advanceTimersByTimeAsync(0)
    expect(stackAttempts).toBe(1)
    expect(pauses).toEqual([])
    await vi.advanceTimersByTimeAsync(50)
    expect(stackAttempts).toBe(2)
    expect(pauses).toEqual([8])

    stackReady = false
    engine.debugger.emit('stopped', { threadId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(stackAttempts).toBe(3)
    adapter.stop()
    await vi.advanceTimersByTimeAsync(50)
    await running

    expect(stackAttempts).toBe(3)
    expect(pauses).toEqual([8])
  })

  it('does not let deferred events from a stopped run affect its replacement', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    engineCreate.mockResolvedValueOnce(engine)

    const { running: firstRun } = await beginRun(adapter, engine, 'debug')
    const firstSettlement = adapter.waitForSettlement!()
    engine.debugger.emit('initialized')
    engine.debugger.emit('stopped', { threadId: 1 })
    adapter.stop()
    await firstRun
    await expect(firstSettlement).resolves.toEqual({ type: 'stopped' })

    const secondRun = adapter.start({ mode: 'run' })
    const secondSettlement = adapter.waitForSettlement!()
    expect(secondSettlement).not.toBe(firstSettlement)
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(100)

    expect(commands(engine, 'configurationDone')).toHaveLength(0)
    expect(commands(engine, 'stackTrace')).toHaveLength(0)

    engine.complete({ type: 'completed', exitCode: 0 })
    await secondRun
    await expect(secondSettlement).resolves.toEqual({
      type: 'completed',
      exitCode: 0,
    })
  })

  it('settles an automatically replaced run before starting its successor', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const exits: number[] = []
    engineCreate.mockResolvedValueOnce(engine)
    adapter.events.exit.subscribe((code) => exits.push(code))

    const { running: firstRun } = await beginRun(adapter, engine, 'run')
    const firstSettlement = adapter.waitForSettlement!()
    const secondRun = adapter.start({ mode: 'run' })
    const secondSettlement = adapter.waitForSettlement!()

    expect(secondSettlement).not.toBe(firstSettlement)
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2))
    await firstRun
    await expect(firstSettlement).resolves.toEqual({ type: 'stopped' })

    engine.complete({ type: 'completed', exitCode: 4 })
    await secondRun
    await expect(secondSettlement).resolves.toEqual({
      type: 'completed',
      exitCode: 4,
    })
    expect(exits).toEqual([0, 4])
    expect(engine.stop).toHaveBeenCalledTimes(1)
  })

  it('reports resolved engine errors as failures instead of successful exits', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const exits: number[] = []
    const errors: string[] = []
    engineCreate.mockResolvedValueOnce(engine)
    adapter.events.exit.subscribe((code) => exits.push(code))
    adapter.events.stderr.subscribe((text) => errors.push(text))

    const { running } = await beginRun(adapter, engine, 'run')
    const settlement = adapter.waitForSettlement!()
    engine.complete({
      type: 'error',
      error: { type: 'EngineError', message: 'worker failed' },
    })
    await running

    expect(exits).toEqual([1])
    expect(errors.join('')).toContain('Runtime error: EngineError: worker failed')
    await expect(settlement).resolves.toEqual({
      type: 'error',
      error: { type: 'EngineError', message: 'worker failed' },
    })
  })

  it('settles engine initialization failures as typed errors exactly once', async () => {
    const adapter = createSession()
    const exits: number[] = []
    engineCreate.mockRejectedValueOnce(new TypeError('engine unavailable'))
    adapter.events.exit.subscribe((code) => exits.push(code))

    await adapter.prepare({ files: workspace, mode: 'run' })
    const running = adapter.start({ mode: 'run' })
    const settlement = adapter.waitForSettlement!()

    await expect(running).resolves.toBeUndefined()
    await expect(settlement).resolves.toEqual({
      type: 'error',
      error: { type: 'TypeError', message: 'engine unavailable' },
    })
    expect(adapter.waitForSettlement!()).toBe(settlement)
    expect(exits).toEqual([1])
  })

  it('flushes intercepted trailing output before publishing normal exit', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const events: string[] = []
    engineCreate.mockResolvedValueOnce(engine)
    adapter.events.stdout.subscribe((text) => events.push(`stdout:${text}`))
    adapter.events.exit.subscribe((code) => events.push(`exit:${code}`))

    await adapter.prepare({
      files: workspace,
      mode: 'run',
      streamInterceptor: {
        push: (stream, chunk) => {
          void stream
          return chunk === 'partial' ? '' : chunk
        },
        finish: () => 'partial',
      },
    })
    const running = adapter.start({ mode: 'run' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
    engine.stdout.emit('partial')
    engine.complete({ type: 'completed', exitCode: 0 })
    await running

    expect(events.slice(-2)).toEqual(['stdout:partial', 'exit:0'])
  })

  it('decodes split multibyte output independently across stdout and stderr', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const stdout: string[] = []
    const stderr: string[] = []
    engineCreate.mockResolvedValueOnce(engine)
    adapter.events.stdout.subscribe((text) => stdout.push(text))
    adapter.events.stderr.subscribe((text) => stderr.push(text))

    const runningState = await beginRun(adapter, engine, 'run')
    const euro = new TextEncoder().encode('€')
    engine.stdout.emitBytes(euro.slice(0, 2))
    engine.stderr.emit('warning')
    engine.stdout.emitBytes(euro.slice(2))
    engine.complete({ type: 'completed', exitCode: 0 })
    await runningState.running

    expect(stdout.join('')).toContain('€')
    expect(stdout.join('')).not.toContain('�')
    expect(stderr.join('')).toContain('warning')
    expect(stderr.join('')).not.toContain('�')
  })

  it('discards an Engine.create result that resolves after disposal', async () => {
    const engine = new FakeEngine()
    const creation = deferred<unknown>()
    const adapter = createSession()
    const exits: number[] = []
    engineCreate.mockReturnValueOnce(creation.promise)
    adapter.events.exit.subscribe((code) => exits.push(code))

    await adapter.prepare({ files: workspace, mode: 'run' })
    const running = adapter.start({ mode: 'run' })
    await vi.waitFor(() => expect(engineCreate).toHaveBeenCalledTimes(1))
    adapter.dispose?.()
    const firstDisposal = adapter.disposeAndWait!()
    const repeatedDisposal = adapter.disposeAndWait!()
    let disposalSettled = false
    void firstDisposal.then(() => {
      disposalSettled = true
    })
    expect(repeatedDisposal).toBe(firstDisposal)
    await Promise.resolve()
    expect(disposalSettled).toBe(false)
    creation.resolve(engine)
    await running
    await expect(firstDisposal).resolves.toEqual({ type: 'stopped' })

    expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(engine.run).not.toHaveBeenCalled()
    expect(exits).toEqual([])
    await expect(adapter.start({ mode: 'run' })).rejects.toThrow(
      'Cannot start a disposed runtime session',
    )
  })

  it('publishes debugResumed once from a successful resume command', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    const adapter = createSession()
    const resumed = vi.fn()
    engineCreate.mockResolvedValueOnce(engine)
    engine.debugger.responder = ({ command }) => {
      if (command === 'stackTrace') {
        return {
          success: true,
          body: {
            stackFrames: [
              { id: 1, name: 'main', line: 1, source: { path: '/main.cpp' } },
            ],
          },
        }
      }
      if (command === 'scopes') return { success: true, body: { scopes: [] } }
      return { success: true }
    }
    adapter.events.debugResumed.subscribe(resumed)

    const { running } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('stopped', { threadId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    await adapter.stepOver()
    await adapter.stepOver()

    expect(commands(engine, 'next')).toHaveLength(1)
    expect(resumed).toHaveBeenCalledTimes(1)
    // Current built-in adapters do not emit this, but ignore a future/late
    // event so one user command still produces one public transition.
    engine.debugger.emit('continued')
    expect(resumed).toHaveBeenCalledTimes(1)

    engine.complete({ type: 'completed', exitCode: 0 })
    await running
  })

  it('rejects active C++ breakpoint edits without mutating accepted breakpoints', async () => {
    const engine = new FakeEngine()
    const adapter = createSession()
    const diagnostics = vi.fn()
    const validated = vi.fn()
    const stderr: string[] = []
    const message =
      'Stop the current debug session before changing breakpoints; this runtime cannot replace them while execution is active.'
    engineCreate.mockResolvedValueOnce(engine)
    adapter.events.diagnostic.subscribe(diagnostics)
    adapter.events.breakpointsValidated.subscribe(validated)
    adapter.events.stderr.subscribe((text) => stderr.push(text))

    await adapter.setBreakpoints('/workspace/main.cpp', [2])
    const { running: firstRun } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(commands(engine, 'configurationDone')).toHaveLength(1))

    await expect(
      adapter.setBreakpoints('/workspace/main.cpp', [3]),
    ).rejects.toThrow(message)
    expect(commands(engine, 'setBreakpoints')).toHaveLength(1)
    expect(validated).toHaveBeenCalledExactlyOnceWith({
      file: '/workspace/main.cpp',
      lines: [2],
    })
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith({
      message,
      severity: 'warning',
      phase: 'execution',
      mode: 'debug',
    })
    expect(stderr.join('')).toContain(message)

    adapter.stop()
    await firstRun

    // Starting again without an edit proves the rejected value never replaced
    // the accepted map.
    const { running: secondRun } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(commands(engine, 'configurationDone')).toHaveLength(2))
    expect(commands(engine, 'setBreakpoints')[1]?.arguments).toEqual({
      source: { path: '/main.cpp' },
      breakpoints: [{ line: 2 }],
    })
    adapter.stop()
    await secondRun

    // Once idle, the same edit is accepted and used by the following session.
    await expect(
      adapter.setBreakpoints('/workspace/main.cpp', [3]),
    ).resolves.toBeUndefined()
    const { running: thirdRun } = await beginRun(adapter, engine, 'debug')
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(commands(engine, 'configurationDone')).toHaveLength(3))
    expect(commands(engine, 'setBreakpoints')[2]?.arguments).toEqual({
      source: { path: '/main.cpp' },
      breakpoints: [{ line: 3 }],
    })

    engine.complete({ type: 'completed', exitCode: 0 })
    await thirdRun
  })
})

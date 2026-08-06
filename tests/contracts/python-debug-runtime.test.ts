import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineCreate = vi.hoisted(() =>
  vi.fn<(language: string) => Promise<unknown>>(),
)

vi.mock('debugger-sh', () => ({
  Engine: { create: engineCreate },
}))

import { pythonRuntimeProvider } from '../../src/runtimes/providers'
import type {
  DebugPauseState,
  RuntimeExecutionPlan,
  RuntimeSession,
} from '../../src/web-ide/contracts/runtime'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly settled: boolean
  resolve(value: T): void
}

interface DapRequest {
  type: 'request'
  seq: number
  command: string
  arguments: Record<string, unknown>
}

interface DapResponse {
  success: boolean
  body?: Record<string, unknown>
}

type RunResult =
  | { type: 'completed'; exitCode: number }
  | { type: 'stopped' }

function deferred<T>(): Deferred<T> {
  let settled = false
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value) {
      if (settled) return
      settled = true
      resolvePromise(value)
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
}

function successfulDapResponse(request: DapRequest): DapResponse {
  if (request.command === 'setBreakpoints') {
    const breakpoints = Array.isArray(request.arguments.breakpoints)
      ? request.arguments.breakpoints
      : []
    return {
      success: true,
      body: {
        breakpoints: breakpoints.map((breakpoint) => ({
          verified: true,
          line: (breakpoint as { line?: number }).line,
        })),
      },
    }
  }
  return { success: true }
}

class FakeDebugger {
  enabled = false
  filterInternals = false
  readonly requests: DapRequest[] = []
  responder: (request: DapRequest) => DapResponse = successfulDapResponse
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
  private readonly runs: Deferred<RunResult>[] = []

  readonly run = vi.fn(() => {
    const invocation = deferred<RunResult>()
    this.runs.push(invocation)
    return invocation.promise
  })
  readonly stop = vi.fn(() => this.activeRun()?.resolve({ type: 'stopped' }))

  complete(exitCode = 0): void {
    const active = this.activeRun()
    if (!active) throw new Error('No active fake run')
    active.resolve({ type: 'completed', exitCode })
  }

  private activeRun(): Deferred<RunResult> | undefined {
    return [...this.runs].reverse().find((run) => !run.settled)
  }
}

const sessions: RuntimeSession[] = []

function createSession(engine: FakeEngine): RuntimeSession {
  engineCreate.mockResolvedValueOnce(engine)
  const session = pythonRuntimeProvider.createSession()
  sessions.push(session)
  return session
}

async function startDebug(
  session: RuntimeSession,
  engine: FakeEngine,
  plan: Omit<RuntimeExecutionPlan, 'mode'>,
): Promise<{ running: Promise<void> }> {
  await expect(session.prepare({ ...plan, mode: 'debug' })).resolves.toEqual({
    success: true,
    errors: [],
  })
  const running = session.start({ mode: 'debug' })
  await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
  return { running }
}

function requests(engine: FakeEngine, command: string): DapRequest[] {
  return engine.debugger.requests.filter((request) => request.command === command)
}

beforeEach(() => {
  engineCreate.mockReset()
})

afterEach(() => {
  for (const session of sessions.splice(0).reverse()) session.dispose?.()
  vi.useRealTimers()
})

describe('Python browser debugger contract', () => {
  it('performs the DAP handshake lazily and configures /main.py without breakpoints', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const { running } = await startDebug(session, engine, {
      files: { '/workspace/main.py': 'print("ready")' },
      entrypoint: '/workspace/main.py',
    })

    expect(engineCreate).toHaveBeenCalledExactlyOnceWith('python')
    expect(engine.debugger.enabled).toBe(true)
    expect(engine.debugger.requests.map(({ command }) => command)).toEqual([
      'initialize',
    ])

    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))

    expect(engine.debugger.requests.map(({ command }) => command)).toEqual([
      'initialize',
      'setBreakpoints',
      'setExceptionBreakpoints',
      'configurationDone',
    ])
    expect(requests(engine, 'setBreakpoints')[0]?.arguments).toEqual({
      source: { path: '/main.py' },
      breakpoints: [],
    })

    engine.complete()
    await running
  })

  it('does not accumulate empty breakpoint sources and resets after accepted breakpoints are cleared', async () => {
    const firstEngine = new FakeEngine()
    const session = createSession(firstEngine)

    await expect(session.prepare({
      files: { '/workspace/main.py': 'value = 1\nprint(value)' },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    await session.setBreakpoints('/workspace/main.py', [2])

    const firstRun = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(firstEngine.run).toHaveBeenCalledTimes(1))

    // Empty edits after the adapter exists must remain true no-ops: they do
    // not send an update and do not create a source that configuration later
    // needs to replay.
    await session.setBreakpoints('/workspace/never-configured.py', [])
    await session.setBreakpoints('/workspace/never-configured.py', [])
    expect(requests(firstEngine, 'setBreakpoints')).toHaveLength(0)

    firstEngine.debugger.emit('initialized')
    await vi.waitFor(() => (
      expect(requests(firstEngine, 'configurationDone')).toHaveLength(1)
    ))
    expect(requests(firstEngine, 'setBreakpoints').map(({ arguments: args }) => args)).toEqual([
      { source: { path: '/main.py' }, breakpoints: [{ line: 2 }] },
    ])

    firstEngine.complete()
    await firstRun
    expect(firstEngine.stop).not.toHaveBeenCalled()

    // Clearing an accepted Python breakpoint while idle discards the adapter
    // whose native breakpoint table cannot safely be cleared in place. A
    // repeated clear remains a no-op and does not stop it twice.
    await session.setBreakpoints('/workspace/main.py', [])
    expect(firstEngine.stop).toHaveBeenCalledTimes(1)
    await session.setBreakpoints('/workspace/main.py', [])
    expect(firstEngine.stop).toHaveBeenCalledTimes(1)

    const secondEngine = new FakeEngine()
    engineCreate.mockResolvedValueOnce(secondEngine)
    await expect(session.prepare({
      files: { '/workspace/main.py': 'print("fresh workspace")' },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    const secondRun = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(secondEngine.run).toHaveBeenCalledTimes(1))
    secondEngine.debugger.emit('initialized')
    await vi.waitFor(() => (
      expect(requests(secondEngine, 'configurationDone')).toHaveLength(1)
    ))

    expect(engineCreate).toHaveBeenCalledTimes(2)
    expect(requests(secondEngine, 'setBreakpoints').map(({ arguments: args }) => args)).toEqual([
      { source: { path: '/main.py' }, breakpoints: [] },
    ])

    secondEngine.complete()
    await secondRun
  })

  it('retains accepted editor breakpoints across an ephemeral Python test plan', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const mainSource = 'value = 1\nprint(value)'

    await expect(session.prepare({
      files: { '/workspace/main.py': mainSource },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    await session.setBreakpoints('/workspace/main.py', [2])
    const firstDebugRun = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))
    expect(requests(engine, 'setBreakpoints')[0]?.arguments).toEqual({
      source: { path: '/main.py' },
      breakpoints: [{ line: 2 }],
    })
    engine.complete()
    await firstDebugRun

    // The Python unittest provider stages main.py under an ephemeral name and
    // selects a nested runner. That execution-only plan must not erase the
    // breakpoint intent owned by the editor workspace.
    await expect(session.prepare({
      files: {
        '/workspace/__web_ide_user_main__.py': mainSource,
        '/workspace/__web_ide/unittest_runner.py': 'print("tests")',
        '/workspace/test_main.py': 'import unittest',
      },
      mode: 'run',
      entrypoint: '/workspace/__web_ide/unittest_runner.py',
    })).resolves.toEqual({ success: true, errors: [] })
    const testRun = session.start({ mode: 'run' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2))
    expect(engine.debugger.enabled).toBe(false)
    engine.complete()
    await testRun

    await expect(session.prepare({
      files: { '/workspace/main.py': mainSource },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    const secondDebugRun = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(3))
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(2))

    expect(engineCreate).toHaveBeenCalledExactlyOnceWith('python')
    expect(requests(engine, 'setBreakpoints').map(({ arguments: args }) => args)).toEqual([
      { source: { path: '/main.py' }, breakpoints: [{ line: 2 }] },
      { source: { path: '/main.py' }, breakpoints: [{ line: 2 }] },
    ])

    engine.complete()
    await secondDebugRun
  })

  it('maps an alternate entrypoint and imported module in both DAP directions', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const pauses: DebugPauseState[] = []
    const validated: { file: string; lines: number[] }[] = []
    const resumed = vi.fn()
    let activeFrames: Record<string, unknown>[] = [
      {
        id: 101,
        name: 'lesson',
        line: 7,
        source: { path: '/lesson.py' },
      },
      {
        id: 202,
        name: 'move_twice',
        line: 3,
        source: { path: '/helpers/steps.py' },
      },
      {
        id: 303,
        name: 'bdb.dispatch_line',
        line: 120,
        source: { path: '/usr/lib/python/bdb.py' },
      },
    ]

    engine.debugger.responder = (request) => {
      if (request.command === 'stackTrace') {
        return { success: true, body: { stackFrames: activeFrames } }
      }
      if (request.command === 'scopes') {
        const frameId = request.arguments.frameId as number
        return {
          success: true,
          body: { scopes: [{ name: 'Locals', variablesReference: frameId * 10 }] },
        }
      }
      if (request.command === 'variables') {
        const reference = request.arguments.variablesReference
        if (reference === 1010) {
          return {
            success: true,
            body: {
              variables: [
                {
                  name: 'count',
                  value: '2',
                  variablesReference: 0,
                },
                {
                  name: 'payload',
                  value: "{'items': [1, 2]}",
                  variablesReference: 500,
                },
              ],
            },
          }
        }
        if (reference === 500) {
          return {
            success: true,
            body: {
              variables: [{
                name: '[0]',
                value: '[1, 2]',
                variablesReference: 501,
              }],
            },
          }
        }
        if (reference === 501) {
          return {
            success: true,
            body: {
              variables: [
                { name: '[0]', value: '1', variablesReference: 0 },
                { name: '[1]', value: '2', variablesReference: 0 },
              ],
            },
          }
        }
        if (reference === 2020) {
          return {
            success: true,
            body: {
              variables: [{
                name: 'step',
                value: '1',
                variablesReference: 0,
              }],
            },
          }
        }
        return { success: true, body: { variables: [] } }
      }
      return successfulDapResponse(request)
    }

    session.events.debugPaused.subscribe((pause) => pauses.push(pause))
    session.events.breakpointsValidated.subscribe((event) => validated.push(event))
    session.events.debugResumed.subscribe(resumed)

    await expect(session.prepare({
      files: {
        '/workspace/lesson.py': 'from helpers.steps import move_twice\nmove_twice()',
        '/workspace/helpers/__init__.py': '',
        '/workspace/helpers/steps.py': 'def move_twice():\n    return 2',
      },
      mode: 'debug',
      entrypoint: '/workspace/lesson.py',
    })).resolves.toEqual({ success: true, errors: [] })
    await session.setBreakpoints('/workspace/lesson.py', [7])
    await session.setBreakpoints('/workspace/helpers/steps.py', [3])

    const running = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))

    expect(requests(engine, 'setBreakpoints').map(({ arguments: args }) => args)).toEqual([
      { source: { path: '/lesson.py' }, breakpoints: [{ line: 7 }] },
      { source: { path: '/helpers/steps.py' }, breakpoints: [{ line: 3 }] },
    ])
    expect(validated).toEqual([])

    engine.debugger.emit('stopped', { threadId: 17 })
    await vi.waitFor(() => expect(pauses).toHaveLength(1))

    expect(requests(engine, 'stackTrace').at(-1)?.arguments).toEqual({ threadId: 17 })
    expect(pauses[0]).toMatchObject({
      file: '/workspace/lesson.py',
      line: 7,
      func: 'lesson',
      memorySnapshot: null,
    })
    expect(pauses[0]?.callStack.map(({ funcName }) => funcName)).toEqual([
      'lesson',
      'move_twice',
    ])
    expect(pauses[0]?.callStack[0]?.variables).toMatchObject([
      {
        name: 'count',
        type: '',
        value: '2',
      },
      {
        name: 'payload',
        type: '',
        isStruct: true,
        members: [{
          name: '[0]',
          isStruct: true,
          members: [
            { name: '[0]', value: '1' },
            { name: '[1]', value: '2' },
          ],
        }],
      },
    ])
    const genericVariables = [
      ...(pauses[0]?.callStack.flatMap(({ variables }) => variables) ?? []),
    ]
    for (let index = 0; index < genericVariables.length; index += 1) {
      const variable = genericVariables[index]
      if (!variable) continue
      expect(variable).not.toHaveProperty('address')
      expect(variable).not.toHaveProperty('rawValue')
      expect(variable).not.toHaveProperty('size')
      expect(variable).not.toHaveProperty('isPointer')
      expect(variable).not.toHaveProperty('pointsTo')
      expect(variable).not.toHaveProperty('pointeeType')
      genericVariables.push(...(variable.members ?? []))
    }

    await session.stepInto()
    await session.stepInto()

    activeFrames = [{
      id: 202,
      name: 'move_twice',
      line: 3,
      source: { path: 'file:///helpers/steps.py' },
    }]
    engine.debugger.emit('stopped', { threadId: 29 })
    await vi.waitFor(() => expect(pauses).toHaveLength(2))
    expect(pauses[1]).toMatchObject({
      file: '/workspace/helpers/steps.py',
      line: 3,
      func: 'move_twice',
      memorySnapshot: null,
    })

    await session.stepOver()
    await session.stepOver()

    engine.debugger.emit('stopped', { threadId: 31 })
    await vi.waitFor(() => expect(pauses).toHaveLength(3))
    await session.stepOut()
    await session.stepOut()

    engine.debugger.emit('stopped', { threadId: 37 })
    await vi.waitFor(() => expect(pauses).toHaveLength(4))
    await session.continueExecution()
    await session.continueExecution()

    expect(
      engine.debugger.requests
        .filter(({ command }) => ['stepIn', 'next', 'stepOut', 'continue'].includes(command))
        .map(({ command, arguments: args }) => [command, args]),
    ).toEqual([
      ['stepIn', { threadId: 17 }],
      ['next', { threadId: 29 }],
      ['stepOut', { threadId: 31 }],
      ['continue', { threadId: 37 }],
    ])
    expect(resumed).toHaveBeenCalledTimes(4)

    engine.complete()
    await running
  })

  it('defers freely running breakpoint edits until pause without publishing Python validation', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const pauses: DebugPauseState[] = []
    const breakpointRequestCountsAtPause: number[] = []
    const validated = vi.fn()

    engine.debugger.responder = (request) => {
      if (request.command === 'stackTrace') {
        return {
          success: true,
          body: {
            stackFrames: [{
              id: 11,
              name: '<module>',
              line: 3,
              source: { path: '/main.py' },
            }],
          },
        }
      }
      if (request.command === 'scopes') {
        return { success: true, body: { scopes: [] } }
      }
      return successfulDapResponse(request)
    }
    session.events.debugPaused.subscribe((pause) => {
      breakpointRequestCountsAtPause.push(requests(engine, 'setBreakpoints').length)
      pauses.push(pause)
    })
    session.events.breakpointsValidated.subscribe(validated)

    await expect(session.prepare({
      files: { '/workspace/main.py': 'seed = 1\nseed += 1\nprint(seed)' },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    await session.setBreakpoints('/workspace/main.py', [1])

    const running = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))
    expect(requests(engine, 'setBreakpoints')).toHaveLength(1)
    expect(validated).not.toHaveBeenCalled()

    await session.setBreakpoints('/workspace/main.py', [2])
    expect(requests(engine, 'setBreakpoints')).toHaveLength(1)

    engine.debugger.emit('stopped', { threadId: 11 })
    await vi.waitFor(() => expect(pauses).toHaveLength(1))
    expect(breakpointRequestCountsAtPause).toEqual([2])
    expect(requests(engine, 'setBreakpoints')[1]?.arguments).toEqual({
      source: { path: '/main.py' },
      breakpoints: [{ line: 2 }],
    })
    expect(validated).not.toHaveBeenCalled()

    await session.setBreakpoints('/workspace/main.py', [3])
    expect(requests(engine, 'setBreakpoints')[2]?.arguments).toEqual({
      source: { path: '/main.py' },
      breakpoints: [{ line: 3 }],
    })
    expect(validated).not.toHaveBeenCalled()

    engine.complete()
    await running
  })

  it('bounds aggregate variable requests and nodes across an entire pause', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const pauses: DebugPauseState[] = []
    const frames = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `frame_${index + 1}`,
      line: index + 1,
      source: { path: '/main.py' },
    }))

    engine.debugger.responder = (request) => {
      if (request.command === 'stackTrace') {
        return { success: true, body: { stackFrames: frames } }
      }
      if (request.command === 'scopes') {
        const frameId = request.arguments.frameId as number
        return {
          success: true,
          body: {
            scopes: [1, 2, 3].map((scope) => ({
              name: `scope_${scope}`,
              variablesReference: frameId * 10 + scope,
            })),
          },
        }
      }
      if (request.command === 'variables') {
        const reference = request.arguments.variablesReference
        return {
          success: true,
          body: {
            variables: Array.from({ length: 4 }, (_, index) => ({
              name: `[${index}]`,
              value: `${reference}:${index}`,
              variablesReference: 0,
            })),
          },
        }
      }
      return successfulDapResponse(request)
    }
    session.events.debugPaused.subscribe((pause) => pauses.push(pause))

    const { running } = await startDebug(session, engine, {
      files: { '/workspace/main.py': 'print("bounded")' },
      entrypoint: '/workspace/main.py',
    })
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))
    engine.debugger.emit('stopped', { threadId: 41 })
    await vi.waitFor(() => expect(pauses).toHaveLength(1))

    const variableRequests = requests(engine, 'variables')
    const renderedVariables = pauses[0]?.callStack.reduce(
      (total, frame) => total + frame.variables.length,
      0,
    )
    expect(pauses[0]?.callStack).toHaveLength(100)
    expect(variableRequests).toHaveLength(250)
    expect(renderedVariables).toBe(1_000)
    expect(variableRequests.every(({ arguments: args }) => (
      typeof args.count === 'number' && args.count <= 100
    ))).toBe(true)
    expect(variableRequests.at(-1)?.arguments.count).toBe(4)

    engine.complete()
    await running
  })

  it('keeps workspace imports but excludes sysroot and generated launcher frames', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const pauses: DebugPauseState[] = []

    engine.debugger.responder = (request) => {
      if (request.command === 'stackTrace') {
        return {
          success: true,
          body: {
            stackFrames: [
              {
                id: 1,
                name: 'imported_function',
                line: 2,
                source: { path: '/pkg/module.py' },
              },
              {
                id: 2,
                name: 'runtime_support',
                line: 8,
                source: { path: '/runtime_support.py' },
              },
              {
                id: 3,
                name: '__web_ide_launcher',
                line: 6,
                source: { path: '/main.py' },
              },
              {
                id: 4,
                name: '<module>',
                line: 3,
                source: { path: '/lesson.py' },
              },
            ],
          },
        }
      }
      if (request.command === 'scopes') {
        return { success: true, body: { scopes: [] } }
      }
      return successfulDapResponse(request)
    }
    session.events.debugPaused.subscribe((pause) => pauses.push(pause))

    const { running } = await startDebug(session, engine, {
      files: {
        '/workspace/lesson.py': 'from pkg.module import imported_function\nimported_function()',
        '/workspace/pkg/__init__.py': '',
        '/workspace/pkg/module.py': 'def imported_function():\n    return 1',
        '/sysroot/runtime_support.py': 'def internal():\n    return 0',
      },
      entrypoint: '/workspace/lesson.py',
    })
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))
    engine.debugger.emit('stopped', { threadId: 43 })
    await vi.waitFor(() => expect(pauses).toHaveLength(1))

    expect(pauses[0]?.file).toBe('/workspace/pkg/module.py')
    expect(pauses[0]?.callStack.map(({ id, funcName, file }) => ({
      id,
      funcName,
      file,
    }))).toEqual([
      {
        id: '1',
        funcName: 'imported_function',
        file: '/workspace/pkg/module.py',
      },
      {
        id: '4',
        funcName: '<module>',
        file: '/workspace/lesson.py',
      },
    ])
    expect(requests(engine, 'scopes').map(({ arguments: args }) => args.frameId)).toEqual([
      1,
      4,
    ])

    engine.complete()
    await running
  })

  it('rejects an oversized UTF-8 breakpoint map without loading or mutating the engine', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)
    const diagnostics: string[] = []
    const validated = vi.fn()
    session.events.diagnostic.subscribe(({ message }) => diagnostics.push(message))
    session.events.breakpointsValidated.subscribe(validated)

    await expect(session.prepare({
      files: { '/workspace/main.py': 'print("debug")' },
      mode: 'debug',
      entrypoint: '/workspace/main.py',
    })).resolves.toEqual({ success: true, errors: [] })
    await expect(
      session.setBreakpoints('/workspace/main.py', [2]),
    ).resolves.toBeUndefined()

    const oversizedFile = `/workspace/${'界'.repeat(1_200)}.py`
    await expect(session.setBreakpoints(oversizedFile, [1])).rejects.toThrow(
      /accepts at most 3500/,
    )
    expect(diagnostics).toEqual([
      expect.stringMatching(/Breakpoint configuration is \d+ bytes; this runtime accepts at most 3500\./),
    ])
    expect(validated).toHaveBeenCalledExactlyOnceWith({
      file: oversizedFile,
      lines: [],
    })
    expect(engineCreate).not.toHaveBeenCalled()

    const running = session.start({ mode: 'debug' })
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1))
    engine.debugger.emit('initialized')
    await vi.waitFor(() => expect(requests(engine, 'configurationDone')).toHaveLength(1))

    expect(requests(engine, 'setBreakpoints').map(({ arguments: args }) => args)).toEqual([
      { source: { path: '/main.py' }, breakpoints: [{ line: 2 }] },
    ])

    engine.complete()
    await running
  })

  it('rejects an alternate entrypoint that would shadow a real main.py', async () => {
    const engine = new FakeEngine()
    const session = createSession(engine)

    await expect(session.prepare({
      files: {
        '/workspace/main.py': 'VALUE = "keep me"',
        '/workspace/lesson.py': 'import main',
      },
      mode: 'debug',
      entrypoint: '/workspace/lesson.py',
    })).resolves.toEqual({
      success: false,
      errors: [
        'Runtime entrypoint "/workspace/lesson.py" cannot be selected while the workspace also contains "main.py"; stage the original file under an ephemeral path before selecting an alternate entrypoint',
      ],
    })
    expect(engineCreate).not.toHaveBeenCalled()
  })
})

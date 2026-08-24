import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const executionState = {
    isCompiling: false,
    isRunning: false,
    setIsCompiling: vi.fn<(value: boolean) => void>(),
    setIsRunning: vi.fn<(value: boolean) => void>(),
    setRightTab: vi.fn<(id: string) => void>(),
  }
  const debugState = {
    reset: vi.fn(),
    setDebugMode: vi.fn(),
  }
  const testState = {
    reset: vi.fn(),
    processEvent: vi.fn(),
    finalize: vi.fn(),
  }
  return {
    debugState,
    engineIndex: 0,
    engines: [] as object[],
    executionState,
    hostIndex: 0,
    hosts: [] as Array<Record<string, unknown> | undefined>,
    prepareWorkbenchExecution: vi.fn(),
    resources: [] as Array<Record<string, unknown>>,
    testState,
  }
})

vi.mock('react', () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}))

vi.mock('@/store/execution-store', () => ({
  useExecutionStore: {
    getState: () => harness.executionState,
  },
}))

vi.mock('@/store/debug-store', () => ({
  useDebugStore: {
    getState: () => harness.debugState,
  },
}))

vi.mock('@/testing/test-store', () => ({
  useTestStore: {
    getState: () => harness.testState,
  },
}))

vi.mock('@/vfs/volume', () => ({
  getAllFiles: () => ({ '/workspace/main.py': 'print("instance")' }),
}))

vi.mock('@/engine/engine-context', () => ({
  useEngine: () => harness.engines[harness.engineIndex++],
}))

vi.mock('@/web-ide/react/host-context', () => ({
  useWebIDEHost: () => harness.hosts[harness.hostIndex++],
}))

vi.mock('@/testing/test-execution', () => ({
  prepareWorkbenchExecution: (request: unknown) =>
    harness.prepareWorkbenchExecution(request),
}))

vi.mock('@/testing/use-test-provider', () => ({
  useSelectedTestProvider: () => undefined,
}))

vi.mock('@/web-ide/react/contribution-context', () => ({
  useIDEWorkspaceResources: () => harness.resources,
}))

import { useRunPipeline } from '../../src/components/layout/use-run-pipeline'
import type { RuntimeSession } from '../../src/web-ide/contracts/runtime'

function runtime(id: string) {
  return {
    id,
    prepare: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    stopAndWait: vi.fn().mockResolvedValue({ type: 'stopped' }),
  } as unknown as RuntimeSession & {
    prepare: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    stopAndWait: ReturnType<typeof vi.fn>
  }
}

function host() {
  return { events: { emit: vi.fn() } }
}

beforeEach(() => {
  harness.engineIndex = 0
  harness.engines.length = 0
  harness.hostIndex = 0
  harness.hosts.length = 0
  harness.resources.length = 0
  harness.executionState.isCompiling = false
  harness.executionState.isRunning = false
  harness.executionState.setIsCompiling.mockReset()
  harness.executionState.setIsCompiling.mockImplementation((value) => {
    harness.executionState.isCompiling = value
  })
  harness.executionState.setIsRunning.mockReset()
  harness.executionState.setIsRunning.mockImplementation((value) => {
    harness.executionState.isRunning = value
  })
  harness.executionState.setRightTab.mockReset()
  harness.debugState.reset.mockReset()
  harness.debugState.setDebugMode.mockReset()
  harness.testState.reset.mockReset()
  harness.testState.processEvent.mockReset()
  harness.testState.finalize.mockReset()
  harness.prepareWorkbenchExecution.mockReset()
  harness.prepareWorkbenchExecution.mockImplementation(async (request: {
    files: Record<string, string>
    mode: 'run' | 'debug'
  }) => ({ files: request.files, mode: request.mode }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('instance-scoped panel execution controller', () => {
  it('keeps prepare/start/stop/restart bound to the runtime instance that created it', async () => {
    const firstRuntime = runtime('runtime.first')
    const secondRuntime = runtime('runtime.second')
    const firstHost = host()
    const secondHost = host()
    harness.engines.push(firstRuntime, secondRuntime)
    harness.hosts.push(firstHost, secondHost)

    const first = useRunPipeline().execution
    const second = useRunPipeline().execution
    expect(first).not.toBe(second)

    await first.start('run')
    expect(firstRuntime.prepare).toHaveBeenCalledTimes(1)
    expect(firstRuntime.start).toHaveBeenCalledExactlyOnceWith({ mode: 'run' })
    expect(secondRuntime.prepare).not.toHaveBeenCalled()
    expect(secondRuntime.start).not.toHaveBeenCalled()

    harness.executionState.isRunning = false
    await second.start('debug')
    expect(secondRuntime.prepare).toHaveBeenCalledTimes(1)
    expect(secondRuntime.start).toHaveBeenCalledExactlyOnceWith({ mode: 'debug' })
    expect(firstRuntime.start).toHaveBeenCalledTimes(1)

    await first.stop()
    expect(firstRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(secondRuntime.stopAndWait).not.toHaveBeenCalled()

    harness.executionState.isRunning = false
    await second.restart('run')
    expect(secondRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(secondRuntime.start).toHaveBeenCalledTimes(2)
    expect(secondRuntime.start).toHaveBeenLastCalledWith({ mode: 'run' })
    expect(firstRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(firstRuntime.start).toHaveBeenCalledTimes(1)
  })

  it('contains preparation failures and reports the failing operation', async () => {
    const failure = new Error('prepare exploded')
    const selectedRuntime = runtime('runtime.prepare-failure')
    const selectedHost = host()
    selectedRuntime.prepare.mockRejectedValueOnce(failure)
    harness.engines.push(selectedRuntime)
    harness.hosts.push(selectedHost)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = useRunPipeline().execution
    await expect(controller.start('run')).resolves.toBeUndefined()

    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(harness.executionState.isCompiling).toBe(false)
    expect(harness.executionState.isRunning).toBe(false)
    expect(harness.testState.finalize).toHaveBeenCalledTimes(1)
    expect(selectedHost.events.emit).toHaveBeenCalledWith('compile_error', { debug: false })
    expect(error).toHaveBeenCalledWith('[web-ide] runtime preparation failed', failure)
  })

  it('contains start failures and restores an idle workbench', async () => {
    const failure = new Error('start exploded')
    const selectedRuntime = runtime('runtime.start-failure')
    selectedRuntime.start.mockRejectedValueOnce(failure)
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = useRunPipeline().execution
    await expect(controller.start('debug')).resolves.toBeUndefined()

    expect(harness.executionState.isRunning).toBe(false)
    expect(harness.debugState.setDebugMode).toHaveBeenLastCalledWith('idle')
    expect(harness.testState.finalize).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[web-ide] runtime start failed', failure)
  })

  it('contains stop failures and still resets debugger presentation state', async () => {
    const failure = new Error('stop exploded')
    const selectedRuntime = runtime('runtime.stop-failure')
    selectedRuntime.stopAndWait.mockRejectedValueOnce(failure)
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = useRunPipeline().execution
    await controller.stop()

    expect(harness.debugState.reset).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[web-ide] runtime stop failed', failure)
  })
})

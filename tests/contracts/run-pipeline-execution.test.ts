import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const createCoordinator = () => {
    let generation = 0
    let pendingRun: Promise<void> | undefined
    let pendingRunIsPreparing = false
    return {
      beginTransition: () => {
        generation += 1
        return generation
      },
      clearPendingRun: (task: Promise<void>) => {
        if (pendingRun === task) {
          pendingRun = undefined
          pendingRunIsPreparing = false
        }
      },
      getGeneration: () => generation,
      getPendingRun: () => pendingRun,
      isPreparing: (task: Promise<void>) =>
        pendingRun === task && pendingRunIsPreparing,
      isCurrent: (candidate: number) => generation === candidate,
      markRuntimeStart: (candidate: number) => {
        if (generation === candidate && pendingRun) {
          pendingRunIsPreparing = false
        }
      },
      setPendingRun: (task: Promise<void>) => {
        pendingRun = task
        pendingRunIsPreparing = true
      },
    }
  }
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
    coordinatorIndex: 0,
    coordinators: [] as Array<ReturnType<typeof createCoordinator>>,
    createCoordinator,
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

vi.mock('@/components/layout/run-pipeline-context', () => ({
  useRunPipelineCoordinator: () =>
    harness.coordinators[harness.coordinatorIndex++],
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
  harness.coordinatorIndex = 0
  harness.coordinators.length = 0
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
    harness.coordinators.push(
      harness.createCoordinator(),
      harness.createCoordinator(),
    )
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
    harness.coordinators.push(harness.createCoordinator())
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
    harness.coordinators.push(harness.createCoordinator())
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
    harness.coordinators.push(harness.createCoordinator())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = useRunPipeline().execution
    await controller.stop()

    expect(harness.debugState.reset).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[web-ide] runtime stop failed', failure)
  })

  it('drains pending preparation even when runtime stop rejects', async () => {
    const failure = new Error('stop exploded while preparing')
    const selectedRuntime = runtime('runtime.stop-failure-during-prepare')
    let finishPrepare: (() => void) | undefined
    selectedRuntime.prepare.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishPrepare = () => resolve({ success: true, errors: [] })
      }),
    )
    selectedRuntime.stopAndWait.mockRejectedValueOnce(failure)
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host())
    harness.coordinators.push(harness.createCoordinator())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = useRunPipeline().execution
    const starting = controller.start('debug')
    await vi.waitFor(() => expect(selectedRuntime.prepare).toHaveBeenCalledTimes(1))
    let stopSettled = false
    const stopping = Promise.resolve(controller.stop()).then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    finishPrepare?.()
    await Promise.all([starting, stopping])

    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(stopSettled).toBe(true)
    expect(error).toHaveBeenCalledWith('[web-ide] runtime stop failed', failure)
  })

  it.each(['stop', 'restart'] as const)(
    'contains a failed %s without waiting forever on an active runtime',
    async (transition) => {
      const failure = new Error(`${transition} rejected while active`)
      const selectedRuntime = runtime(`runtime.active-${transition}-failure`)
      let finishStart: (() => void) | undefined
      selectedRuntime.start.mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishStart = resolve
        }),
      )
      selectedRuntime.stopAndWait.mockRejectedValueOnce(failure)
      harness.engines.push(selectedRuntime)
      harness.hosts.push(host())
      harness.coordinators.push(harness.createCoordinator())
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const controller = useRunPipeline().execution
      const starting = controller.start('debug')
      await vi.waitFor(() => expect(selectedRuntime.start).toHaveBeenCalledTimes(1))

      const transitioning = transition === 'stop'
        ? Promise.resolve(controller.stop())
        : Promise.resolve(controller.restart('debug'))
      await expect(transitioning).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith(
        transition === 'stop'
          ? '[web-ide] runtime stop failed'
          : '[web-ide] runtime restart stop failed',
        failure,
      )
      expect(selectedRuntime.start).toHaveBeenCalledTimes(1)

      finishStart?.()
      await starting
    },
  )

  it('shares cancellation across controllers while preparation is pending', async () => {
    const selectedRuntime = runtime('runtime.cancel-prepare')
    let finishPrepare: (() => void) | undefined
    selectedRuntime.prepare.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishPrepare = () => resolve({ success: true, errors: [] })
      }),
    )
    harness.engines.push(selectedRuntime)
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host(), host())
    const coordinator = harness.createCoordinator()
    harness.coordinators.push(coordinator, coordinator)

    const starter = useRunPipeline().execution
    const stopper = useRunPipeline().execution
    const starting = starter.start('debug')
    await vi.waitFor(() => expect(selectedRuntime.prepare).toHaveBeenCalledTimes(1))

    let stopSettled = false
    const stopping = Promise.resolve(stopper.stop()).then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    finishPrepare?.()
    await Promise.all([starting, stopping])

    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(selectedRuntime.stopAndWait).toHaveBeenCalledTimes(2)
    expect(harness.executionState.isCompiling).toBe(false)
    expect(harness.executionState.isRunning).toBe(false)
  })

  it('registers before a compile event can stop through another controller', async () => {
    const selectedRuntime = runtime('runtime.reentrant-compile-stop')
    const selectedHost = host()
    harness.engines.push(selectedRuntime, selectedRuntime)
    harness.hosts.push(selectedHost, host())
    const coordinator = harness.createCoordinator()
    harness.coordinators.push(coordinator, coordinator)

    const starter = useRunPipeline().execution
    const stopper = useRunPipeline().execution
    let stopping: Promise<void> | undefined
    selectedHost.events.emit.mockImplementation((event: string) => {
      if (event === 'compile_debug') stopping = Promise.resolve(stopper.stop())
    })

    const starting = starter.start('debug')
    await vi.waitFor(() => expect(stopping).toBeDefined())
    await Promise.all([starting, stopping])

    expect(harness.prepareWorkbenchExecution).not.toHaveBeenCalled()
    expect(selectedRuntime.prepare).not.toHaveBeenCalled()
    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(selectedRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(harness.executionState.isCompiling).toBe(false)
  })

  it('drains shared cancellation during workbench preparation', async () => {
    const selectedRuntime = runtime('runtime.cancel-workbench-prepare')
    let finishWorkbenchPrepare: (() => void) | undefined
    harness.prepareWorkbenchExecution.mockImplementationOnce(
      (request: { files: Record<string, string>; mode: 'run' | 'debug' }) =>
        new Promise((resolve) => {
          finishWorkbenchPrepare = () => resolve({
            files: request.files,
            mode: request.mode,
          })
        }),
    )
    harness.engines.push(selectedRuntime, selectedRuntime)
    harness.hosts.push(host(), host())
    const coordinator = harness.createCoordinator()
    harness.coordinators.push(coordinator, coordinator)

    const starter = useRunPipeline().execution
    const stopper = useRunPipeline().execution
    const starting = starter.start('debug')
    await vi.waitFor(() => {
      expect(harness.prepareWorkbenchExecution).toHaveBeenCalledTimes(1)
    })
    let stopSettled = false
    const stopping = Promise.resolve(stopper.stop()).then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    finishWorkbenchPrepare?.()
    await Promise.all([starting, stopping])

    expect(selectedRuntime.prepare).not.toHaveBeenCalled()
    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(selectedRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(harness.executionState.isCompiling).toBe(false)
  })

  it('does not start when a public run event synchronously stops execution', async () => {
    const selectedRuntime = runtime('runtime.reentrant-stop')
    const selectedHost = host()
    harness.engines.push(selectedRuntime)
    harness.hosts.push(selectedHost)
    harness.coordinators.push(harness.createCoordinator())

    const controller = useRunPipeline().execution
    let stopping: Promise<void> | undefined
    selectedHost.events.emit.mockImplementation((event: string) => {
      if (event === 'run') stopping = Promise.resolve(controller.stop())
    })

    await controller.start('run')
    await stopping

    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(selectedRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(harness.executionState.isRunning).toBe(false)
    expect(harness.debugState.setDebugMode).toHaveBeenLastCalledWith('idle')
  })

  it('lets a later stop cancel restart while preparation is pending', async () => {
    const selectedRuntime = runtime('runtime.restart-then-stop')
    let finishPrepare: (() => void) | undefined
    selectedRuntime.prepare.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishPrepare = () => resolve({ success: true, errors: [] })
      }),
    )
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host())
    harness.coordinators.push(harness.createCoordinator())

    const controller = useRunPipeline().execution
    const starting = controller.start('debug')
    await vi.waitFor(() => expect(selectedRuntime.prepare).toHaveBeenCalledTimes(1))
    const restarting = Promise.resolve(controller.restart('debug'))
    const stopping = Promise.resolve(controller.stop())

    finishPrepare?.()
    await Promise.all([starting, restarting, stopping])

    expect(selectedRuntime.start).not.toHaveBeenCalled()
    expect(harness.debugState.reset).toHaveBeenCalledTimes(1)
    expect(harness.executionState.isRunning).toBe(false)
  })

  it('lets a later restart win after stop cancels pending preparation', async () => {
    const selectedRuntime = runtime('runtime.stop-then-restart')
    let finishPrepare: (() => void) | undefined
    selectedRuntime.prepare.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishPrepare = () => resolve({ success: true, errors: [] })
      }),
    )
    harness.engines.push(selectedRuntime)
    harness.hosts.push(host())
    harness.coordinators.push(harness.createCoordinator())

    const controller = useRunPipeline().execution
    const starting = controller.start('debug')
    await vi.waitFor(() => expect(selectedRuntime.prepare).toHaveBeenCalledTimes(1))
    const stopping = Promise.resolve(controller.stop())
    const restarting = Promise.resolve(controller.restart('debug'))

    finishPrepare?.()
    await Promise.all([starting, stopping, restarting])

    expect(selectedRuntime.start).toHaveBeenCalledExactlyOnceWith({ mode: 'debug' })
    expect(harness.debugState.reset).toHaveBeenCalledTimes(1)
  })

  it('lets a re-entrant stop cancel restart from the public restart event', async () => {
    const selectedRuntime = runtime('runtime.reentrant-restart-stop')
    const selectedHost = host()
    harness.engines.push(selectedRuntime)
    harness.hosts.push(selectedHost)
    harness.coordinators.push(harness.createCoordinator())

    const controller = useRunPipeline().execution
    let stopping: Promise<void> | undefined
    selectedHost.events.emit.mockImplementation((event: string) => {
      if (event === 'debug_restart') stopping = Promise.resolve(controller.stop())
    })

    await controller.restart('debug')
    await stopping

    expect(selectedRuntime.stopAndWait).toHaveBeenCalledTimes(1)
    expect(selectedRuntime.prepare).not.toHaveBeenCalled()
    expect(selectedRuntime.start).not.toHaveBeenCalled()
  })
})

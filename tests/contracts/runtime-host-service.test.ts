import { describe, expect, it, vi } from 'vitest'
import type {
  IDEPlugin,
  RuntimeEventChannels,
  RuntimeHostServiceV1,
  RuntimeSession,
} from '../../src/web-ide'
import {
  registerRuntimeHostService,
  RuntimeHostServicesUnavailableError,
  validateRuntimeHostServiceV1,
} from '../../src/runtimes/host-service'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'

const eventSource = { subscribe: () => () => undefined }

function createSession(hostChannels: boolean) {
  const services = new Map<string, RuntimeHostServiceV1>()
  const disposed = vi.fn<(capability: string) => void>()
  const session = {
    id: `fake.runtime.${hostChannels ? 'host' : 'legacy'}`,
    languageIds: ['cpp'],
    capabilities: {
      debug: true,
      breakpoints: true,
      stdin: true,
      graphics: false,
      ...(hostChannels ? { hostChannels: true } : {}),
    },
    events: {
      stdout: eventSource,
      stderr: eventSource,
      terminalClear: eventSource,
      graphicsDraw: eventSource,
      debugPaused: eventSource,
      debugResumed: eventSource,
      exit: eventSource,
      diagnostic: eventSource,
      breakpointsValidated: eventSource,
    } as RuntimeEventChannels,
    prepare: vi.fn(async () => ({ success: true, errors: [] })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setBreakpoints: vi.fn(async () => undefined),
    stepInto: vi.fn(async () => undefined),
    stepOver: vi.fn(async () => undefined),
    stepOut: vi.fn(async () => undefined),
    continueExecution: vi.fn(async () => undefined),
    ...(hostChannels ? {
      registerHostService(service: RuntimeHostServiceV1) {
        if (services.has(service.capability)) throw new Error('duplicate active service')
        services.set(service.capability, service)
        let active = true
        return {
          dispose() {
            if (!active) return
            active = false
            services.delete(service.capability)
            disposed(service.capability)
          },
        }
      },
    } : {}),
  } satisfies RuntimeSession
  return { disposed, services, session }
}

const service: RuntimeHostServiceV1 = {
  capability: 'synthetic.graphics',
  version: 1,
  limits: {
    maxFrameBytes: 16 * 1024,
    maxPendingSends: 32,
    maxInFlightRequests: 32,
  },
  open: () => ({ dispose: () => undefined }),
}

describe('optional runtime host-service bridge', () => {
  it('binds the exact R-P01 limit names and validates descriptor bounds', () => {
    expect(() => validateRuntimeHostServiceV1(service)).not.toThrow()
    expect(Object.keys(service.limits!)).toEqual([
      'maxFrameBytes',
      'maxPendingSends',
      'maxInFlightRequests',
    ])
    expect(() => validateRuntimeHostServiceV1({
      ...service,
      capability: 'not_reverse_dns',
    })).toThrow(/reverse-DNS/)
    expect(() => validateRuntimeHostServiceV1({ ...service, version: 0 })).toThrow(/positive/)
    expect(() => validateRuntimeHostServiceV1({
      ...service,
      limits: { ...service.limits, maxPendingSends: 1025 },
    })).toThrow(/between 0 and 1024/)
    expect(() => validateRuntimeHostServiceV1({
      ...service,
      limits: { maximumFrameBytes: 1024 } as never,
    })).toThrow(/unknown/)
    expect(() => validateRuntimeHostServiceV1({
      ...service,
      limits: { maxFrameBytes: 1 },
    })).toThrow(/must be at least/)
  })

  it('reports a legacy provider without host-channel support cleanly', () => {
    const { session } = createSession(false)
    expect(() => registerRuntimeHostService(session, service))
      .toThrow(RuntimeHostServicesUnavailableError)
  })

  it('keeps identical service capabilities scoped to each runtime instance', () => {
    const first = createSession(true)
    const second = createSession(true)
    const firstRegistration = registerRuntimeHostService(first.session, service)
    const secondRegistration = registerRuntimeHostService(second.session, service)

    expect(first.services.get(service.capability)).toBe(service)
    expect(second.services.get(service.capability)).toBe(service)
    firstRegistration.dispose()
    firstRegistration.dispose()
    expect(first.services.size).toBe(0)
    expect(second.services.get(service.capability)).toBe(service)
    expect(first.disposed).toHaveBeenCalledTimes(1)

    secondRegistration.dispose()
    expect(second.disposed).toHaveBeenCalledTimes(1)
  })

  it('tears activation registrations down before a StrictMode-style reactivation', () => {
    const runtime = createSession(true)
    const plugin: IDEPlugin = {
      id: 'synthetic.host-service.plugin',
      activate(context) {
        if (!context.runtime) throw new Error('runtime required')
        context.register(registerRuntimeHostService(context.runtime, service))
      },
    }
    const manager = new IDEPluginManager([plugin])

    const firstActivation = manager.activate({ runtime: runtime.session })
    expect(runtime.services.size).toBe(1)
    firstActivation.dispose()
    expect(runtime.services.size).toBe(0)

    const secondActivation = manager.activate({ runtime: runtime.session })
    expect(runtime.services.size).toBe(1)
    secondActivation.dispose()
    secondActivation.dispose()
    expect(runtime.services.size).toBe(0)
    expect(runtime.disposed).toHaveBeenCalledTimes(2)
  })
})

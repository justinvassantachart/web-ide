import { beforeEach, describe, expect, it, vi } from 'vitest'

const reactHarness = vi.hoisted(() => ({
  cleanups: [] as Array<(() => void) | undefined>,
  setEngine: vi.fn(),
  useEffect: vi.fn(),
}))

vi.mock('react', () => ({
  default: {},
  createContext: vi.fn(() => ({ Provider: Symbol('Provider') })),
  useContext: vi.fn(),
  useEffect: reactHarness.useEffect,
  useState: vi.fn(() => [null, reactHarness.setEngine]),
}))

import { EngineProvider } from '../../src/engine/EngineContext'
import type { RuntimeSession } from '../../src/web-ide/contracts/runtime'

function renderProvider(session: RuntimeSession): void {
  EngineProvider({ createSession: () => session, children: null })
}

beforeEach(() => {
  reactHarness.cleanups.length = 0
  reactHarness.setEngine.mockReset()
  reactHarness.useEffect.mockReset()
  reactHarness.useEffect.mockImplementation(
    (effect: () => (() => void) | undefined) => {
      reactHarness.cleanups.push(effect())
    },
  )
})

describe('EngineProvider runtime cleanup', () => {
  it('prefers awaited disposal while retaining legacy cleanup fallbacks', () => {
    const disposeAndWait = vi.fn(() => Promise.resolve({ type: 'stopped' as const }))
    const dispose = vi.fn()
    const stop = vi.fn()
    renderProvider({ disposeAndWait, dispose, stop } as unknown as RuntimeSession)

    reactHarness.cleanups[0]?.()

    expect(disposeAndWait).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()

    reactHarness.cleanups.length = 0
    renderProvider({ dispose, stop } as unknown as RuntimeSession)
    reactHarness.cleanups[0]?.()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()

    reactHarness.cleanups.length = 0
    renderProvider({ stop } as unknown as RuntimeSession)
    reactHarness.cleanups[0]?.()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('contains a rejected awaited disposal instead of leaking an unhandled rejection', async () => {
    const error = new Error('worker cleanup failed')
    const disposeAndWait = vi.fn(() => Promise.reject(error))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderProvider({ disposeAndWait } as unknown as RuntimeSession)

    reactHarness.cleanups[0]?.()
    await Promise.resolve()

    expect(disposeAndWait).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[web-ide] runtime cleanup failed', error)
    warn.mockRestore()
  })
})

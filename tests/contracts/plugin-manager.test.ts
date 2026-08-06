import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  IDECommandContribution,
  IDEPanelContribution,
} from '../../src/web-ide/contracts/contributions'
import type { IDEPlugin } from '../../src/web-ide/contracts/plugin'
import type { RuntimeProvider } from '../../src/web-ide/contracts/runtime'
import type { LanguageToolingProvider } from '../../src/web-ide/contracts/language-tooling'
import { ContributionRegistry } from '../../src/web-ide/core/contribution-registry'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'

const runtimeCapabilities = {
  debug: true,
  breakpoints: true,
  stdin: true,
  graphics: false,
} as const

function command(id: string, order?: number): IDECommandContribution {
  return {
    id,
    title: id,
    order,
    execute: () => undefined,
  }
}

function panel(id: string, order?: number): IDEPanelContribution {
  return {
    id,
    title: id,
    order,
    component: () => null,
  }
}

function runtime(id: string, order?: number): RuntimeProvider {
  return {
    id,
    label: id,
    languageIds: ['cpp'],
    capabilities: runtimeCapabilities,
    order,
    createSession: () => {
      throw new Error('Session creation is not part of plugin registration')
    },
  }
}

function languageTooling(id: string, order?: number): LanguageToolingProvider {
  return {
    id,
    label: id,
    languageIds: ['cpp'],
    component: () => null,
    order,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IDEPluginManager static contributions', () => {
  it('rejects duplicate plugin ids before reading any contributions', () => {
    const readContributions = vi.fn(() => undefined)
    const firstPlugin = { id: 'duplicate' } as IDEPlugin
    Object.defineProperty(firstPlugin, 'contributes', {
      get: readContributions,
    })

    expect(
      () => new IDEPluginManager([firstPlugin, { id: 'duplicate' }]),
    ).toThrow('A plugin with id "duplicate" is already registered')
    expect(readContributions).not.toHaveBeenCalled()
  })

  it('registers and orders every declarative contribution', () => {
    const run = command('run', 20)
    const tests = panel('tests', 20)
    const cpp = runtime('cpp', 20)
    const manager = new IDEPluginManager([
      {
        id: 'base',
        contributes: {
          commands: [run],
          panels: [tests],
          runtimeProviders: [cpp],
          languageToolingProviders: [languageTooling('clangd', 20)],
        },
      },
      {
        id: 'early',
        contributes: {
          commands: [command('stop', -10)],
          panels: [panel('canvas', -10)],
          runtimeProviders: [runtime('python', -10)],
          languageToolingProviders: [languageTooling('pylsp', -10)],
        },
      },
    ])

    expect(manager.commands.get('run')).toBe(run)
    expect(manager.commands.getSnapshot().map(({ id }) => id)).toEqual([
      'stop',
      'run',
    ])
    expect(manager.panels.getSnapshot().map(({ id }) => id)).toEqual([
      'canvas',
      'tests',
    ])
    expect(manager.runtimeProviders.getSnapshot().map(({ id }) => id)).toEqual([
      'python',
      'cpp',
    ])
    expect(
      manager.languageToolingProviders.getSnapshot().map(({ id }) => id),
    ).toEqual(['pylsp', 'clangd'])
  })

  it('rolls back every earlier registration when construction fails', () => {
    const register = vi.spyOn(ContributionRegistry.prototype, 'register')
    const dispose = vi.spyOn(ContributionRegistry.prototype, 'dispose')

    expect(
      () =>
        new IDEPluginManager([
          {
            id: 'first',
            contributes: { commands: [command('run')] },
          },
          {
            id: 'conflict',
            contributes: { commands: [command('run')] },
          },
        ]),
    ).toThrow('A contribution with id "run" is already registered')

    const commandRegistry = register.mock.contexts[0] as ContributionRegistry<
      IDECommandContribution
    >
    expect(register).toHaveBeenCalledTimes(2)
    expect(register.mock.contexts[1]).toBe(commandRegistry)
    expect(commandRegistry.getSnapshot()).toEqual([])
    expect(commandRegistry.isDisposed).toBe(true)
    // Activities, commands, panels, workspace resources, runtime providers,
    // test providers, and language-tooling providers all roll back.
    expect(dispose).toHaveBeenCalledTimes(7)
  })
})

describe('IDEPluginManager activation', () => {
  it('activates in declaration order and tears plugin scopes down in reverse', () => {
    const calls: string[] = []
    const manager = new IDEPluginManager([
      {
        id: 'first',
        contributes: { commands: [command('static')] },
        activate(context) {
          calls.push('activate:first')
          context.commands.register(command('dynamic-command'))
          context.runtimeProviders.register(runtime('dynamic-runtime'))
          context.languageToolingProviders.register(
            languageTooling('dynamic-tooling'),
          )
          context.register(() => calls.push('resource:first'))
          return () => calls.push('deactivate:first')
        },
      },
      {
        id: 'second',
        activate(context) {
          calls.push('activate:second')
          context.panels.register(panel('dynamic-panel'))
          context.register(() => calls.push('resource:second'))
          return () => calls.push('deactivate:second')
        },
      },
    ])

    const activation = manager.activate()

    expect(calls).toEqual(['activate:first', 'activate:second'])
    expect(manager.commands.has('static')).toBe(true)
    expect(manager.commands.has('dynamic-command')).toBe(true)
    expect(manager.panels.has('dynamic-panel')).toBe(true)
    expect(manager.runtimeProviders.has('dynamic-runtime')).toBe(true)
    expect(manager.languageToolingProviders.has('dynamic-tooling')).toBe(true)

    activation.dispose()
    activation.dispose()

    expect(calls).toEqual([
      'activate:first',
      'activate:second',
      'deactivate:second',
      'resource:second',
      'deactivate:first',
      'resource:first',
    ])
    expect(manager.commands.has('static')).toBe(true)
    expect(manager.commands.has('dynamic-command')).toBe(false)
    expect(manager.panels.has('dynamic-panel')).toBe(false)
    expect(manager.runtimeProviders.has('dynamic-runtime')).toBe(false)
    expect(manager.languageToolingProviders.has('dynamic-tooling')).toBe(false)
  })

  it('cleans the failing and all prior scopes before rethrowing activation errors', () => {
    const activationError = new Error('second plugin failed')
    const calls: string[] = []
    const manager = new IDEPluginManager([
      {
        id: 'first',
        contributes: { commands: [command('static')] },
        activate(context) {
          calls.push('activate:first')
          context.commands.register(command('first-dynamic'))
          context.register(() => calls.push('resource:first'))
          return () => calls.push('deactivate:first')
        },
      },
      {
        id: 'failing',
        activate(context) {
          calls.push('activate:failing')
          context.panels.register(panel('failing-dynamic'))
          context.register(() => calls.push('resource:failing'))
          throw activationError
        },
      },
      {
        id: 'never-reached',
        activate() {
          calls.push('activate:never')
        },
      },
    ])

    expect(() => manager.activate()).toThrow(activationError)
    expect(calls).toEqual([
      'activate:first',
      'activate:failing',
      'resource:failing',
      'deactivate:first',
      'resource:first',
    ])
    expect(manager.commands.getSnapshot().map(({ id }) => id)).toEqual([
      'static',
    ])
    expect(manager.panels.getSnapshot()).toEqual([])
  })

  it('keeps the activation error authoritative when a cleanup also fails', () => {
    const activationError = new Error('activation failed')
    const cleanupError = new Error('cleanup failed')
    const cleanup = vi.fn(() => {
      throw cleanupError
    })
    const manager = new IDEPluginManager([
      {
        id: 'failing',
        activate(context) {
          context.register(cleanup)
          throw activationError
        },
      },
    ])

    let thrown: unknown
    try {
      manager.activate()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(activationError)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('supports independent activate/deactivate cycles with the same manager', () => {
    const activate = vi.fn()
    const deactivate = vi.fn()
    const manager = new IDEPluginManager([
      {
        id: 'strict-mode-safe',
        activate(context) {
          activate()
          context.commands.register(command('cycle-command'))
          return deactivate
        },
      },
    ])

    const first = manager.activate()
    expect(manager.commands.has('cycle-command')).toBe(true)
    first.dispose()
    expect(manager.commands.has('cycle-command')).toBe(false)

    const second = manager.activate()
    expect(manager.commands.has('cycle-command')).toBe(true)
    second.dispose()

    expect(activate).toHaveBeenCalledTimes(2)
    expect(deactivate).toHaveBeenCalledTimes(2)
    expect(manager.commands.has('cycle-command')).toBe(false)
  })

  it('immediately releases resources registered through a stale context', () => {
    const lateCleanup = vi.fn()
    let registerLateResource: (() => void) | undefined
    let registerLateCommand: (() => void) | undefined
    const manager = new IDEPluginManager([
      {
        id: 'retained-context',
        activate(context) {
          registerLateResource = () => {
            context.register(lateCleanup)
          }
          registerLateCommand = () => {
            context.commands.register(command('too-late'))
          }
        },
      },
    ])
    const activation = manager.activate()
    activation.dispose()

    registerLateResource?.()
    registerLateCommand?.()

    expect(lateCleanup).toHaveBeenCalledTimes(1)
    expect(manager.commands.has('too-late')).toBe(false)
  })
})

describe('IDEPluginManager disposal', () => {
  it('cleans live cycles in reverse order and permanently disposes registries', () => {
    const calls: string[] = []
    let cycle = 0
    const manager = new IDEPluginManager([
      {
        id: 'plugin',
        contributes: {
          commands: [command('run')],
          panels: [panel('tests')],
          runtimeProviders: [runtime('cpp')],
          languageToolingProviders: [languageTooling('clangd')],
        },
        activate(context) {
          cycle += 1
          const currentCycle = cycle
          context.register(() => calls.push(`cycle:${currentCycle}`))
        },
      },
    ])
    const first = manager.activate()
    const second = manager.activate()

    manager.dispose()
    manager.dispose()
    first.dispose()
    second.dispose()

    expect(calls).toEqual(['cycle:2', 'cycle:1'])
    expect(manager.isDisposed).toBe(true)
    expect(manager.commands.isDisposed).toBe(true)
    expect(manager.panels.isDisposed).toBe(true)
    expect(manager.runtimeProviders.isDisposed).toBe(true)
    expect(manager.languageToolingProviders.isDisposed).toBe(true)
    expect(manager.commands.getSnapshot()).toEqual([])
    expect(manager.panels.getSnapshot()).toEqual([])
    expect(manager.runtimeProviders.getSnapshot()).toEqual([])
    expect(manager.languageToolingProviders.getSnapshot()).toEqual([])
    expect(() => manager.activate()).toThrow(
      'Cannot activate a disposed plugin manager',
    )
  })

  it('attempts all cleanup even when an active plugin resource throws', () => {
    const calls: string[] = []
    const cleanupError = new Error('resource cleanup failed')
    let cycle = 0
    const manager = new IDEPluginManager([
      {
        id: 'plugin',
        contributes: { commands: [command('run')] },
        activate(context) {
          cycle += 1
          const currentCycle = cycle
          context.register(() => {
            calls.push(`cycle:${currentCycle}`)
            if (currentCycle === 2) throw cleanupError
          })
        },
      },
    ])
    manager.activate()
    manager.activate()

    expect(() => manager.dispose()).toThrow(AggregateError)
    expect(calls).toEqual(['cycle:2', 'cycle:1'])
    expect(manager.commands.isDisposed).toBe(true)
    expect(manager.commands.getSnapshot()).toEqual([])
    expect(() => manager.dispose()).not.toThrow()
  })
})

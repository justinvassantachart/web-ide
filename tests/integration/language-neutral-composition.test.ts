import { describe, expect, it } from 'vitest'

import { pythonRuntimePlugin } from '../../src/runtimes/providers'
import type { WebIDEConfiguration } from '../../src/web-ide/contracts/configuration'
import type { IDEPlugin } from '../../src/web-ide/contracts/plugin'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'

const karelRuntimePlugin: IDEPlugin = {
  id: 'host.runtime.karel.plugin',
  contributes: {
    runtimeProviders: [
      {
        id: 'host.runtime.karel',
        label: 'Karel',
        languageIds: ['karel'],
        capabilities: {
          debug: false,
          breakpoints: false,
          stdin: false,
          graphics: true,
        },
        createSession: () => {
          throw new Error('Composition does not create runtime sessions')
        },
      },
    ],
  },
}

describe('language-neutral workbench composition', () => {
  it.each([
    ['Python', 'web-ide.runtime.python', pythonRuntimePlugin],
    ['Karel', 'host.runtime.karel', karelRuntimePlugin],
  ])('allows a %s host to omit language tooling', (_label, runtimeId, plugin) => {
    const configuration = {
      runtimeProvider: runtimeId,
      plugins: [plugin],
    } satisfies WebIDEConfiguration
    const manager = new IDEPluginManager(configuration.plugins)

    expect(configuration).not.toHaveProperty('languageToolingProvider')
    expect(manager.runtimeProviders.has(configuration.runtimeProvider)).toBe(true)
    expect(manager.languageToolingProviders.getSnapshot()).toEqual([])

    manager.dispose()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/debug/MemoryVisualizer', () => ({
  MemoryVisualizer: () => null,
}))
vi.mock('../../src/components/debug/VariablesPanel', () => ({
  VariablesPanel: () => null,
}))
vi.mock('../../src/components/sidebar/ExplorerView', () => ({
  ExplorerView: () => null,
}))

import { pythonRuntimePlugin } from '../../src/runtimes/providers'
import type { IDEWorkbenchSnapshot } from '../../src/web-ide/contracts/contributions'
import type { IDEPlugin } from '../../src/web-ide/contracts/plugin'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import { coreWorkbenchPlugin } from '../../src/web-ide/plugins/core-workbench'

const managers: IDEPluginManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0).reverse()) manager.dispose()
})

describe('Python debug workbench composition', () => {
  it('shows Debug and Variables while withholding the native-memory Graph', () => {
    const manager = new IDEPluginManager([
      pythonRuntimePlugin,
      coreWorkbenchPlugin,
    ])
    managers.push(manager)

    const provider = manager.runtimeProviders.get('web-ide.runtime.python')
    expect(provider).toMatchObject({
      languageIds: ['python'],
      capabilities: {
        debug: true,
        breakpoints: true,
        stdin: true,
        graphics: false,
        memoryVisualization: false,
      },
    })

    const snapshot = {
      runState: 'idle',
      isCompiling: false,
      runtimeReady: true,
      runtimeCapabilities: provider!.capabilities,
      testingAvailable: false,
    } satisfies IDEWorkbenchSnapshot

    const visibleCommands = manager.commands
      .getSnapshot()
      .filter((command) => command.when?.(snapshot) ?? true)
      .map(({ id }) => id)
    const visiblePanels = manager.panels
      .getSnapshot()
      .filter((panel) => panel.when?.(snapshot) ?? true)
      .map(({ id }) => id)

    expect(visibleCommands).toEqual(['workbench.run', 'workbench.debug'])
    expect(visiblePanels).toEqual(['variables'])
    expect(manager.panels.has('graph')).toBe(true)
  })

  it('keeps the Graph compatible with debug providers that omit memoryVisualization', () => {
    const legacyRuntimePlugin: IDEPlugin = {
      id: 'host.runtime.legacy.plugin',
      contributes: {
        runtimeProviders: [{
          id: 'host.runtime.legacy',
          label: 'Legacy debugger',
          languageIds: ['legacy'],
          capabilities: {
            debug: true,
            breakpoints: true,
            stdin: true,
            graphics: false,
          },
          createSession: () => {
            throw new Error('Composition does not create runtime sessions')
          },
        }],
      },
    }
    const manager = new IDEPluginManager([
      legacyRuntimePlugin,
      coreWorkbenchPlugin,
    ])
    managers.push(manager)

    const provider = manager.runtimeProviders.get('host.runtime.legacy')
    expect(provider?.capabilities).not.toHaveProperty('memoryVisualization')
    const snapshot = {
      runState: 'idle',
      isCompiling: false,
      runtimeReady: true,
      runtimeCapabilities: provider!.capabilities,
      testingAvailable: false,
    } satisfies IDEWorkbenchSnapshot
    const visiblePanels = manager.panels
      .getSnapshot()
      .filter((panel) => panel.when?.(snapshot) ?? true)
      .map(({ id }) => id)

    expect(visiblePanels).toEqual(['variables', 'graph'])
  })
})

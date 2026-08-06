import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/canvas/CanvasView', () => ({
  CanvasView: () => null,
}))
vi.mock('../../src/components/debug/MemoryVisualizer', () => ({
  MemoryVisualizer: () => null,
}))
vi.mock('../../src/components/debug/VariablesPanel', () => ({
  VariablesPanel: () => null,
}))
vi.mock('../../src/testing/TestsPanel', () => ({
  TestsPanel: () => null,
}))

import { cppRuntimePlugin } from '../../src/runtimes/providers'
import { cppTestingPlugin, testingPlugin } from '../../src/testing'
import { cppLanguageToolingPlugin } from '../../src/clangd/plugin'
import type { WebIDEConfiguration } from '../../src/web-ide/contracts/configuration'
import type {
  IDECommandContext,
  IDEWorkbenchSnapshot,
} from '../../src/web-ide/contracts/contributions'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import { canvasPlugin } from '../../src/web-ide/plugins/canvas'
import { coreWorkbenchPlugin } from '../../src/web-ide/plugins/core-workbench'

const webIDEConfiguration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.cpp',
  languageToolingProvider: 'web-ide.language-tooling.cpp',
  testProvider: 'web-ide.testing.cpp',
  brand: 'WEB·IDE',
  plugins: [
    cppRuntimePlugin,
    cppLanguageToolingPlugin,
    cppTestingPlugin,
    coreWorkbenchPlugin,
    canvasPlugin,
    testingPlugin,
  ],
}

const managers: IDEPluginManager[] = []

function createManager(configuration: WebIDEConfiguration): IDEPluginManager {
  const manager = new IDEPluginManager(configuration.plugins)
  managers.push(manager)
  return manager
}

function cloneConfiguration(
  plugins = webIDEConfiguration.plugins,
): WebIDEConfiguration {
  return {
    runtimeProvider: webIDEConfiguration.runtimeProvider,
    languageToolingProvider: webIDEConfiguration.languageToolingProvider,
    testProvider: webIDEConfiguration.testProvider,
    plugins: [...plugins],
  }
}

function contributionIds(
  manager: IDEPluginManager,
): {
  commands: string[]
  panels: string[]
  runtimeProviders: string[]
  testProviders: string[]
  languageToolingProviders: string[]
} {
  return {
    commands: manager.commands.getSnapshot().map(({ id }) => id),
    panels: manager.panels.getSnapshot().map(({ id }) => id),
    runtimeProviders: manager.runtimeProviders.getSnapshot().map(({ id }) => id),
    testProviders: manager.testProviders.getSnapshot().map(({ id }) => id),
    languageToolingProviders: manager.languageToolingProviders
      .getSnapshot()
      .map(({ id }) => id),
  }
}

afterEach(() => {
  for (const manager of managers.splice(0).reverse()) manager.dispose()
})

describe('default C++ Web IDE composition', () => {
  it('selects the C++ runtime provider and composes the real panels in order', () => {
    const manager = createManager(webIDEConfiguration)

    expect(webIDEConfiguration.runtimeProvider).toBe('web-ide.runtime.cpp')
    expect(webIDEConfiguration.languageToolingProvider).toBe(
      'web-ide.language-tooling.cpp',
    )
    expect(manager.runtimeProviders.get(webIDEConfiguration.runtimeProvider)).toMatchObject({
      id: 'web-ide.runtime.cpp',
      languageIds: ['c', 'cpp'],
      capabilities: {
        debug: true,
        breakpoints: true,
        stdin: true,
        graphics: false,
        memoryVisualization: true,
      },
    })
    expect(manager.testProviders.get(webIDEConfiguration.testProvider!)).toBe(
      cppTestingPlugin.contributes?.testProviders?.[0],
    )
    expect(
      manager.languageToolingProviders.get(
        webIDEConfiguration.languageToolingProvider!,
      ),
    ).toBe(cppLanguageToolingPlugin.contributes?.languageToolingProviders?.[0])
    expect(manager.panels.getSnapshot().map(({ id }) => id)).toEqual([
      'variables',
      'graph',
      'canvas',
      'tests',
    ])
  })

  it('omits the optional Canvas and Tests plugins without disturbing the core composition', () => {
    const plugins = webIDEConfiguration.plugins.filter(
      (plugin) => plugin !== canvasPlugin
        && plugin !== testingPlugin
        && plugin !== cppTestingPlugin,
    )
    const configuration = cloneConfiguration(plugins)
    const manager = createManager(configuration)

    expect(manager.runtimeProviders.has(configuration.runtimeProvider)).toBe(true)
    expect(manager.panels.getSnapshot().map(({ id }) => id)).toEqual([
      'variables',
      'graph',
    ])
    expect(
      manager.commands
        .getSnapshot()
        .filter(({ surface }) => surface === 'toolbar')
        .map(({ title }) => title),
    ).toEqual(['Run', 'Debug', 'Stop'])
    expect(manager.panels.has('canvas')).toBe(false)
    expect(manager.panels.has('tests')).toBe(false)
    expect(manager.commands.has('workbench.test')).toBe(false)
  })

  it('hides debug commands and panels when the selected session does not support debugging', () => {
    const manager = createManager(webIDEConfiguration)
    const debugCommand = manager.commands.get('workbench.debug')
    const snapshot = {
      runState: 'idle',
      isCompiling: false,
      runtimeReady: true,
      runtimeCapabilities: {
        debug: false,
        breakpoints: false,
        stdin: true,
        graphics: false,
      },
      testingAvailable: false,
    } satisfies IDEWorkbenchSnapshot

    expect(debugCommand?.when?.(snapshot)).toBe(false)
    expect(manager.commands.get('workbench.run')?.when?.(snapshot)).toBe(true)
    expect(manager.panels.get('variables')?.when?.(snapshot)).toBe(false)
    expect(manager.panels.get('graph')?.when?.(snapshot)).toBe(false)
  })

  it('runs ordered toolbar commands only through the stable command context', async () => {
    const manager = createManager(webIDEConfiguration)
    const start = vi
      .fn<IDECommandContext['execution']['start']>()
      .mockResolvedValue(undefined)
    const stop = vi.fn<IDECommandContext['execution']['stop']>()
    const restart = vi
      .fn<IDECommandContext['execution']['restart']>()
      .mockResolvedValue(undefined)
    const snapshot = vi
      .fn<IDECommandContext['workspace']['snapshot']>()
      .mockReturnValue(Object.freeze({}))
    const reveal = vi.fn<IDECommandContext['panels']['reveal']>()
    const context = Object.freeze({
      execution: Object.freeze({ start, stop, restart }),
      workspace: Object.freeze({ snapshot }),
      panels: Object.freeze({ reveal }),
    }) satisfies IDECommandContext
    const toolbarCommands = manager.commands
      .getSnapshot()
      .filter(({ surface }) => surface === 'toolbar')

    expect(toolbarCommands.map(({ title }) => title)).toEqual([
      'Run',
      'Debug',
      'Tests',
      'Stop',
    ])

    for (const command of toolbarCommands) await command.execute(context)

    expect(start.mock.calls).toEqual([['run'], ['debug'], ['test']])
    expect(start).toHaveBeenNthCalledWith(3, 'test')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(restart).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('keeps separate configuration and manager instances isolated', () => {
    const firstConfiguration = cloneConfiguration()
    const secondConfiguration = cloneConfiguration()
    const firstManager = createManager(firstConfiguration)
    const secondManager = createManager(secondConfiguration)

    expect(firstConfiguration).not.toBe(secondConfiguration)
    expect(firstConfiguration.plugins).not.toBe(secondConfiguration.plugins)
    expect(firstManager.commands).not.toBe(secondManager.commands)
    expect(firstManager.panels.getSnapshot()).not.toBe(
      secondManager.panels.getSnapshot(),
    )
    expect(contributionIds(firstManager)).toEqual(contributionIds(secondManager))

    firstManager.dispose()

    expect(contributionIds(firstManager)).toEqual({
      commands: [],
      panels: [],
      runtimeProviders: [],
      testProviders: [],
      languageToolingProviders: [],
    })
    expect(contributionIds(secondManager)).toEqual({
      commands: [
        'workbench.run',
        'workbench.debug',
        'workbench.test',
        'workbench.stop',
      ],
      panels: ['variables', 'graph', 'canvas', 'tests'],
      runtimeProviders: ['web-ide.runtime.cpp'],
      testProviders: ['web-ide.testing.cpp'],
      languageToolingProviders: ['web-ide.language-tooling.cpp'],
    })
  })

  it('preserves static composition across activation and deactivation', () => {
    const manager = createManager(webIDEConfiguration)
    const beforeActivation = {
      commands: manager.commands.getSnapshot(),
      panels: manager.panels.getSnapshot(),
      runtimeProviders: manager.runtimeProviders.getSnapshot(),
      testProviders: manager.testProviders.getSnapshot(),
      languageToolingProviders: manager.languageToolingProviders.getSnapshot(),
    }

    const activation = manager.activate()

    expect(manager.commands.getSnapshot()).toBe(beforeActivation.commands)
    expect(manager.panels.getSnapshot()).toBe(beforeActivation.panels)
    expect(manager.runtimeProviders.getSnapshot()).toBe(
      beforeActivation.runtimeProviders,
    )
    expect(manager.testProviders.getSnapshot()).toBe(beforeActivation.testProviders)
    expect(manager.languageToolingProviders.getSnapshot()).toBe(
      beforeActivation.languageToolingProviders,
    )

    activation.dispose()

    expect(manager.commands.getSnapshot()).toBe(beforeActivation.commands)
    expect(manager.panels.getSnapshot()).toBe(beforeActivation.panels)
    expect(manager.runtimeProviders.getSnapshot()).toBe(
      beforeActivation.runtimeProviders,
    )
    expect(manager.testProviders.getSnapshot()).toBe(beforeActivation.testProviders)
    expect(manager.languageToolingProviders.getSnapshot()).toBe(
      beforeActivation.languageToolingProviders,
    )
  })
})

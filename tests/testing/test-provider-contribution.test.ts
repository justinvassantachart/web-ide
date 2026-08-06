import { describe, expect, it } from 'vitest'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import type { TestProvider } from '../../src/web-ide/contracts/testing'

function testProvider(id: string): TestProvider {
  return {
    id,
    label: id,
    languageIds: ['example'],
    prepare: ({ files, mode }) => ({ execution: { files, mode } }),
  }
}

describe('TestProvider plugin contributions', () => {
  it('supports static and activation-scoped providers through the public registrar', () => {
    const base = testProvider('example.base-tests')
    const dynamic = testProvider('example.dynamic-tests')
    const manager = new IDEPluginManager([
      {
        id: 'example.testing',
        contributes: { testProviders: [base] },
        activate(context) {
          context.testProviders.register(dynamic)
        },
      },
    ])

    expect(manager.testProviders.getSnapshot()).toEqual([base])
    const activation = manager.activate()
    expect(manager.testProviders.getSnapshot()).toEqual([base, dynamic])

    activation.dispose()
    expect(manager.testProviders.getSnapshot()).toEqual([base])

    manager.dispose()
    expect(manager.testProviders.getSnapshot()).toEqual([])
    expect(manager.testProviders.isDisposed).toBe(true)
  })
})

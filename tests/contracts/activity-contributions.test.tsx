import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { IDEActivityContribution, IDEPlugin } from '../../src/web-ide'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'

function activity(id: string, order: number): IDEActivityContribution {
  return {
    id,
    title: id,
    icon: 'extensions',
    order,
    component: ({ runtime, workspace }) => (
      <output>{`${runtime.id}:${Object.keys(workspace.snapshot()).length}`}</output>
    ),
  }
}

describe('open activity contribution API', () => {
  it('orders host-authored activities and cleans dynamic registrations', () => {
    let registerDynamic: (() => void) | undefined
    const plugin: IDEPlugin = {
      id: 'host.activity-plugin',
      contributes: {
        activities: [activity('host.instructions', 10), activity('host.tools', 30)],
      },
      activate(context) {
        registerDynamic = () => {
          context.activities.register(activity('host.dynamic', 20))
        }
      },
    }
    const manager = new IDEPluginManager([plugin])
    const activation = manager.activate()

    expect(manager.activities.getSnapshot().map(({ id }) => id)).toEqual([
      'host.instructions',
      'host.tools',
    ])

    registerDynamic?.()
    expect(manager.activities.getSnapshot().map(({ id }) => id)).toEqual([
      'host.instructions',
      'host.dynamic',
      'host.tools',
    ])

    const Dynamic = manager.activities.get('host.dynamic')?.component
    expect(Dynamic).toBeDefined()
    const DynamicActivity = Dynamic!
    const snapshot = vi.fn(() => ({ '/workspace/main.txt': 'hello' }))
    expect(
      renderToStaticMarkup(
        <DynamicActivity
          runtime={{ id: 'fake.runtime' } as never}
          workspace={{ snapshot }}
          panels={{ reveal: vi.fn() }}
        />,
      ),
    ).toContain('fake.runtime:1')

    activation.dispose()
    expect(manager.activities.has('host.dynamic')).toBe(false)
    expect(manager.activities.has('host.instructions')).toBe(true)
    manager.dispose()
  })
})

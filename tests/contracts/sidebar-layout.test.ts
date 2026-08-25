import { describe, expect, it, vi } from 'vitest'

import {
  createSidebarLayoutController,
  type SidebarLayoutStorage,
} from '../../src/web-ide/core/sidebar-layout'

function memoryStorage(initial?: string): SidebarLayoutStorage & { read(): string | null } {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    read: () => value,
  }
}

describe('sidebar layout controller', () => {
  it('preserves the stored Explorer default when no host selection exists', () => {
    const controller = createSidebarLayoutController(undefined, memoryStorage())
    expect(controller.getSnapshot()).toEqual({
      selectedActivityId: 'workbench.files',
      collapsed: false,
    })
  })

  it('gives an exact host selection precedence over persisted sidebar state', () => {
    const storage = memoryStorage(JSON.stringify({
      activeView: 'workbench.files',
      collapsed: true,
    }))
    const controller = createSidebarLayoutController('host.assignment', storage)

    expect(controller.getSnapshot()).toEqual({
      selectedActivityId: 'host.assignment',
      collapsed: false,
    })
    expect(storage.read()).toContain('workbench.files')
  })

  it('keeps later selection, collapse, persistence, and subscriptions mount-owned', () => {
    const firstStorage = memoryStorage()
    const secondStorage = memoryStorage()
    const first = createSidebarLayoutController('host.assignment', firstStorage)
    const second = createSidebarLayoutController('host.notes', secondStorage)
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    first.subscribe(firstListener)
    second.subscribe(secondListener)

    first.handleActivityClick('host.assignment')
    expect(first.getSnapshot()).toEqual({
      selectedActivityId: 'host.assignment',
      collapsed: true,
    })
    first.selectActivity('workbench.files')

    expect(first.getSnapshot()).toEqual({
      selectedActivityId: 'workbench.files',
      collapsed: false,
    })
    expect(second.getSnapshot()).toEqual({
      selectedActivityId: 'host.notes',
      collapsed: false,
    })
    expect(firstListener).toHaveBeenCalledTimes(2)
    expect(secondListener).not.toHaveBeenCalled()
    expect(firstStorage.read()).toBe(JSON.stringify({
      activeView: 'workbench.files',
      collapsed: false,
    }))
    expect(secondStorage.read()).toBeNull()
  })

  it('fails safely when persisted storage is corrupt or unavailable', () => {
    const corrupt = createSidebarLayoutController(undefined, memoryStorage('{'))
    const unavailable: SidebarLayoutStorage = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }
    const blocked = createSidebarLayoutController(undefined, unavailable)

    expect(corrupt.getSnapshot().selectedActivityId).toBe('workbench.files')
    expect(blocked.getSnapshot().selectedActivityId).toBe('workbench.files')
    expect(() => blocked.toggleCollapsed()).not.toThrow()
  })
})

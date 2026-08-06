import { describe, expect, it, vi } from 'vitest'

import { ContributionRegistry } from '../../src/web-ide/core/contribution-registry'

interface TestContribution {
  id: string
  order?: number
  label: string
}

describe('ContributionRegistry', () => {
  it('registers, retrieves, and removes contributions through a disposable', () => {
    const registry = new ContributionRegistry<TestContribution>()
    const contribution = { id: 'editor', label: 'Editor' }

    const registration = registry.register(contribution)

    expect(registry.has('editor')).toBe(true)
    expect(registry.get('editor')).toBe(contribution)
    expect(registry.get('missing')).toBeUndefined()

    registration.dispose()
    registration.dispose()

    expect(registry.has('editor')).toBe(false)
    expect(registry.getSnapshot()).toEqual([])
  })

  it('rejects duplicate ids without replacing the original contribution', () => {
    const registry = new ContributionRegistry<TestContribution>()
    const original = { id: 'terminal', label: 'Terminal' }
    registry.register(original)

    expect(() =>
      registry.register({ id: 'terminal', label: 'Replacement' }),
    ).toThrow(/already registered/)
    expect(registry.get('terminal')).toBe(original)
  })

  it('orders by explicit order and then by stable registration order', () => {
    const registry = new ContributionRegistry<TestContribution>()
    registry.register({ id: 'late', order: 20, label: 'Late' })
    registry.register({ id: 'default-first', label: 'Default first' })
    registry.register({ id: 'early', order: -10, label: 'Early' })
    registry.register({ id: 'default-second', order: 0, label: 'Default second' })
    registry.register({ id: 'also-late', order: 20, label: 'Also late' })

    expect(registry.getSnapshot().map(({ id }) => id)).toEqual([
      'early',
      'default-first',
      'default-second',
      'late',
      'also-late',
    ])
  })

  it('caches frozen snapshots until the registry changes', () => {
    const registry = new ContributionRegistry<TestContribution>()
    const initial = registry.getSnapshot()

    expect(registry.getSnapshot()).toBe(initial)
    expect(Object.isFrozen(initial)).toBe(true)

    const registration = registry.register({ id: 'tests', label: 'Tests' })
    const registered = registry.getSnapshot()
    expect(registered).not.toBe(initial)
    expect(registry.getSnapshot()).toBe(registered)
    expect(Object.isFrozen(registered)).toBe(true)
    expect(() => (registered as TestContribution[]).push({
      id: 'mutated',
      label: 'Mutated',
    })).toThrow(TypeError)

    registration.dispose()
    expect(registry.getSnapshot()).not.toBe(registered)
  })

  it('notifies active subscriptions for registration, removal, and disposal', () => {
    const registry = new ContributionRegistry<TestContribution>()
    const listener = vi.fn()
    const subscription = registry.subscribe(listener)
    const registration = registry.register({ id: 'canvas', label: 'Canvas' })

    expect(listener).toHaveBeenCalledTimes(1)
    registration.dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    registry.dispose()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(registry.isDisposed).toBe(true)
    expect(registry.getSnapshot()).toEqual([])

    subscription.dispose()
    registry.dispose()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('stops notifications when a subscription is disposed', () => {
    const registry = new ContributionRegistry<TestContribution>()
    const listener = vi.fn()
    const subscription = registry.subscribe(listener)
    subscription.dispose()
    subscription.dispose()

    registry.register({ id: 'files', label: 'Files' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects registrations after disposal and ignores later subscriptions', () => {
    const registry = new ContributionRegistry<TestContribution>()
    registry.dispose()
    const listener = vi.fn()
    const subscription = registry.subscribe(listener)

    expect(() => registry.register({ id: 'debug', label: 'Debug' })).toThrow(
      /registry is disposed/,
    )
    subscription.dispose()
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps registry instances isolated', () => {
    const first = new ContributionRegistry<TestContribution>()
    const second = new ContributionRegistry<TestContribution>()
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    first.subscribe(firstListener)
    second.subscribe(secondListener)

    first.register({ id: 'editor', label: 'Editor' })

    expect(first.getSnapshot().map(({ id }) => id)).toEqual(['editor'])
    expect(second.getSnapshot()).toEqual([])
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()
  })
})

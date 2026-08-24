import { describe, expect, it, vi } from 'vitest'

import type {
  IDESourceDecoration,
  IDESourceLocation,
} from '../../src/web-ide/contracts/source-presentation'
import { SourcePresentationController } from '../../src/web-ide/core/source-presentation'

const MAIN = '/workspace/main.py'
const HELPER = '/workspace/lib/helper.py'

function createController(onReveal = vi.fn()) {
  const visible = new Map([
    [MAIN, [
      'first',
      'second line',
      ...Array.from({ length: 10 }, (_, index) => `main ${index + 3}`),
    ].join('\n')],
    [HELPER, Array.from({ length: 12 }, (_, index) => `helper ${index + 1}`).join('\n')],
  ])
  return {
    controller: new SourcePresentationController({
      readVisibleSource: (path) => visible.get(path),
      onReveal,
    }),
    onReveal,
    visible,
  }
}

describe('SourcePresentationController', () => {
  it('publishes exact immutable snapshots only when presentation changes', () => {
    const { controller } = createController()
    const owner = controller.createOwner()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    const initial = controller.getSnapshot()
    const mutable = {
      path: MAIN,
      line: 4,
      column: 2,
      kind: 'current' as const,
    }

    expect(controller.getSnapshot()).toBe(initial)
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.decorations)).toBe(true)

    owner.replaceDecorations([
      mutable,
      { path: HELPER, line: 9, kind: 'historical' },
      { path: MAIN, line: 12, kind: 'error' },
    ])
    mutable.line = 99
    const presented = controller.getSnapshot()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(presented).not.toBe(initial)
    expect(controller.getSnapshot()).toBe(presented)
    expect(presented.decorations).toEqual([
      { path: MAIN, line: 4, column: 2, kind: 'current' },
      { path: HELPER, line: 9, kind: 'historical' },
      { path: MAIN, line: 12, kind: 'error' },
    ])
    expect(Object.isFrozen(presented)).toBe(true)
    expect(Object.isFrozen(presented.decorations)).toBe(true)
    expect(presented.decorations.every(Object.isFrozen)).toBe(true)

    owner.replaceDecorations(presented.decorations)
    expect(controller.getSnapshot()).toBe(presented)
    expect(listener).toHaveBeenCalledTimes(1)

    owner.clearDecorations()
    const cleared = controller.getSnapshot()
    expect(cleared.decorations).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
    owner.clearDecorations()
    expect(controller.getSnapshot()).toBe(cleared)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    owner.replaceDecorations([{ path: MAIN, line: 1, kind: 'current' }])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reveals only normalized visible positions without changing presentation state', () => {
    const { controller, onReveal } = createController()
    const owner = controller.createOwner()
    const listener = vi.fn()
    controller.subscribe(listener)
    const before = controller.getSnapshot()

    owner.reveal({ path: MAIN, line: 7, column: 3 })

    expect(onReveal).toHaveBeenCalledWith({ path: MAIN, line: 7, column: 3 })
    expect(Object.isFrozen(onReveal.mock.calls[0]![0])).toBe(true)
    expect(controller.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('isolates owners and controller instances without exposing owner identities', () => {
    const first = createController().controller
    const second = createController().controller
    const firstOwner = first.createOwner()
    const siblingOwner = first.createOwner()
    const secondOwner = second.createOwner()

    expect(Object.keys(firstOwner).sort()).toEqual([
      'clearDecorations',
      'dispose',
      'replaceDecorations',
      'reveal',
    ])
    firstOwner.replaceDecorations([{ path: MAIN, line: 1, kind: 'current' }])
    siblingOwner.replaceDecorations([{ path: HELPER, line: 2, kind: 'historical' }])
    secondOwner.replaceDecorations([{ path: MAIN, line: 3, kind: 'error' }])

    expect(first.getSnapshot().decorations).toEqual([
      { path: MAIN, line: 1, kind: 'current' },
      { path: HELPER, line: 2, kind: 'historical' },
    ])
    expect(second.getSnapshot().decorations).toEqual([
      { path: MAIN, line: 3, kind: 'error' },
    ])

    firstOwner.dispose()
    expect(first.getSnapshot().decorations).toEqual([
      { path: HELPER, line: 2, kind: 'historical' },
    ])
    expect(second.getSnapshot().decorations).toEqual([
      { path: MAIN, line: 3, kind: 'error' },
    ])
  })

  it('atomically rejects malformed, hidden, inherited, and accessor-backed input', () => {
    const { controller } = createController()
    const owner = controller.createOwner()
    owner.replaceDecorations([{ path: MAIN, line: 1, kind: 'current' }])
    const before = controller.getSnapshot()
    const listener = vi.fn()
    controller.subscribe(listener)

    const inherited = Object.create({ path: MAIN, line: 1, kind: 'error' })
    const accessor = { path: MAIN, line: 1 } as Record<string, unknown>
    Object.defineProperty(accessor, 'kind', { get: () => 'error', enumerable: true })
    const symbolBacked = { path: MAIN, line: 1, kind: 'error' } as Record<PropertyKey, unknown>
    symbolBacked[Symbol('owner')] = 'private'
    const invalid: unknown[] = [
      { path: 'main.py', line: 1, kind: 'error' },
      { path: '/sysroot/main.py', line: 1, kind: 'error' },
      { path: '/workspace/../secret.py', line: 1, kind: 'error' },
      { path: '/workspace/lib//helper.py', line: 1, kind: 'error' },
      { path: '/workspace/lib\\helper.py', line: 1, kind: 'error' },
      { path: '/workspace/missing.py', line: 1, kind: 'error' },
      { path: MAIN, line: 0, kind: 'error' },
      { path: MAIN, line: 1.5, kind: 'error' },
      { path: MAIN, line: Number.POSITIVE_INFINITY, kind: 'error' },
      { path: MAIN, line: 1, column: 0, kind: 'error' },
      { path: MAIN, line: 13, kind: 'error' },
      { path: MAIN, line: 2, column: 13, kind: 'error' },
      { path: MAIN, line: 1, kind: 'warning' },
      { path: MAIN, line: 1, kind: 'error', ownerId: 'escape' },
      inherited,
      accessor,
      symbolBacked,
      null,
      [],
    ]

    for (const decoration of invalid) {
      expect(() => owner.replaceDecorations([
        { path: HELPER, line: 2, kind: 'historical' },
        decoration as IDESourceDecoration,
      ])).toThrow()
      expect(controller.getSnapshot()).toBe(before)
    }
    expect(listener).not.toHaveBeenCalled()

    expect(() => owner.replaceDecorations(
      Array.from(
        { length: 257 },
        () => ({ path: MAIN, line: 1, kind: 'error' as const }),
      ),
    )).toThrow(/at most 256/)
    expect(controller.getSnapshot()).toBe(before)

    const inheritedLocation = Object.create({ path: MAIN, line: 1 })
    expect(() => owner.reveal(inheritedLocation as IDESourceLocation)).toThrow()
  })

  it('revokes disposed owners and controllers deterministically', () => {
    const { controller } = createController()
    const owner = controller.createOwner()
    const staleAfterController = controller.createOwner()
    const listener = vi.fn()
    controller.subscribe(listener)
    owner.replaceDecorations([{ path: MAIN, line: 1, kind: 'current' }])

    owner.dispose()
    owner.dispose()
    expect(() => owner.reveal({ path: MAIN, line: 1 })).toThrow(/no longer active/)
    expect(() => owner.replaceDecorations([])).toThrow(/no longer active/)
    expect(() => owner.clearDecorations()).toThrow(/no longer active/)

    staleAfterController.replaceDecorations([
      { path: HELPER, line: 2, kind: 'historical' },
    ])
    controller.dispose()
    controller.dispose()

    expect(controller.getSnapshot().decorations).toEqual([])
    expect(() => staleAfterController.reveal({ path: MAIN, line: 1 }))
      .toThrow(/no longer active/)
    expect(() => staleAfterController.replaceDecorations([]))
      .toThrow(/no longer active/)
    expect(() => staleAfterController.clearDecorations())
      .toThrow(/no longer active/)
    expect(() => controller.createOwner()).toThrow(/disposed/)
    expect(() => controller.subscribe(vi.fn())).toThrow(/disposed/)
    expect(() => staleAfterController.dispose()).not.toThrow()
  })

  it('prunes deleted and newly out-of-bounds source without resurrecting it', () => {
    const { controller, visible } = createController()
    const owner = controller.createOwner()
    const listener = vi.fn()
    controller.subscribe(listener)
    owner.replaceDecorations([
      { path: MAIN, line: 12, kind: 'current' },
      { path: HELPER, line: 9, kind: 'historical' },
    ])

    visible.delete(MAIN)
    controller.pruneInvalid()
    expect(controller.getSnapshot().decorations).toEqual([
      { path: HELPER, line: 9, kind: 'historical' },
    ])

    visible.set(MAIN, Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'))
    controller.pruneInvalid()
    expect(controller.getSnapshot().decorations).toEqual([
      { path: HELPER, line: 9, kind: 'historical' },
    ])

    visible.set(HELPER, 'only one line')
    controller.pruneInvalid()
    expect(controller.getSnapshot().decorations).toEqual([])
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

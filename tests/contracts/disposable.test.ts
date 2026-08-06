import { describe, expect, it, vi } from 'vitest'

import { DisposableStore, toDisposable } from '../../src/web-ide/core/disposable'

describe('toDisposable', () => {
  it('normalizes a callback and invokes it at most once', () => {
    const cleanup = vi.fn()
    const disposable = toDisposable(cleanup)

    disposable.dispose()
    disposable.dispose()

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('normalizes a disposable object while preserving its receiver', () => {
    const resource = {
      disposed: false,
      dispose() {
        this.disposed = true
      },
    }
    const disposable = toDisposable(resource)

    disposable.dispose()
    disposable.dispose()

    expect(resource.disposed).toBe(true)
  })

  it('provides an idempotent no-op for an empty value', () => {
    const disposable = toDisposable()

    expect(() => {
      disposable.dispose()
      disposable.dispose()
    }).not.toThrow()
  })
})

describe('DisposableStore', () => {
  it('disposes resources in reverse registration order', () => {
    const calls: string[] = []
    const store = new DisposableStore()
    store.add(() => calls.push('first'))
    store.add(() => calls.push('second'))
    store.add(() => calls.push('third'))

    store.dispose()

    expect(calls).toEqual(['third', 'second', 'first'])
  })

  it('immediately disposes resources added after the store is disposed', () => {
    const cleanup = vi.fn()
    const store = new DisposableStore()
    store.dispose()

    const disposable = store.add(cleanup)
    disposable.dispose()

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('is idempotent', () => {
    const cleanup = vi.fn()
    const store = new DisposableStore()
    store.add(cleanup)

    store.dispose()
    store.dispose()

    expect(store.isDisposed).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('attempts every cleanup and reports all failures as an AggregateError', () => {
    const calls: string[] = []
    const firstError = new Error('first failed')
    const thirdError = new Error('third failed')
    const store = new DisposableStore()
    store.add(() => {
      calls.push('first')
      throw firstError
    })
    store.add(() => calls.push('second'))
    store.add(() => {
      calls.push('third')
      throw thirdError
    })

    let thrown: unknown
    try {
      store.dispose()
    } catch (error) {
      thrown = error
    }

    expect(calls).toEqual(['third', 'second', 'first'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([thirdError, firstError])
    expect(() => store.dispose()).not.toThrow()
  })
})

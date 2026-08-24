import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IDEWorkspacePersistence } from '../../src/web-ide/contracts/host'
import { WorkspacePersistenceCoordinator } from '../../src/web-ide/core/workspace-persistence'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason?: unknown) => void
} {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspacePersistenceCoordinator', () => {
  it('debounces full snapshots, coalesces changes, and retains its own copy', async () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const onPendingChange = vi.fn()
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'course/assignment',
      persistence: { save },
      debounceMs: 40,
      onPendingChange,
    })
    const firstFiles = { '/main.cpp': 'first' }

    coordinator.scheduleSave(firstFiles)
    firstFiles['/main.cpp'] = 'mutated after scheduling'
    coordinator.scheduleSave({
      '/main.cpp': 'latest',
      '/README.md': 'complete snapshot',
    })

    expect(coordinator.isPending).toBe(true)
    expect(coordinator.revision).toBe(0)
    expect(onPendingChange).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(39)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      {
        '/main.cpp': 'latest',
        '/README.md': 'complete snapshot',
      },
      {
        workspaceId: 'course/assignment',
        revision: 1,
        reason: 'change',
      },
    )
    expect(coordinator.revision).toBe(1)
    expect(coordinator.isPending).toBe(false)
    expect(onPendingChange.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
    ])
  })

  it('serializes async saves and eventually persists the latest snapshot', async () => {
    vi.useFakeTimers()
    const firstSave = deferred()
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined)
    const onPendingChange = vi.fn()
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save },
      debounceMs: 10,
      onPendingChange,
    })

    coordinator.scheduleSave({ '/main.cpp': 'first' })
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(1)

    coordinator.scheduleSave({ '/main.cpp': 'superseded' })
    coordinator.scheduleSave({ '/main.cpp': 'latest' })
    await vi.advanceTimersByTimeAsync(10)

    // The second adapter call cannot start until the first promise settles.
    expect(save).toHaveBeenCalledTimes(1)
    const flushed = coordinator.flush()
    firstSave.resolve()
    await flushed

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.map(([files]) => files)).toEqual([
      { '/main.cpp': 'first' },
      { '/main.cpp': 'latest' },
    ])
    expect(save.mock.calls.map(([, context]) => context)).toEqual([
      { workspaceId: 'workspace', revision: 1, reason: 'change' },
      { workspaceId: 'workspace', revision: 2, reason: 'change' },
    ])
    expect(onPendingChange.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
    ])
  })

  it('flushes a debouncing snapshot immediately before the host adapter', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const save = vi.fn(() => {
      calls.push('save')
    })
    const flush = vi.fn(async () => {
      await Promise.resolve()
      calls.push('flush')
    })
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush },
      debounceMs: 10_000,
    })

    coordinator.scheduleSave({ '/main.cpp': 'flush now' })
    await coordinator.flush()

    expect(calls).toEqual(['save', 'flush'])
    expect(save).toHaveBeenCalledWith(
      { '/main.cpp': 'flush now' },
      { workspaceId: 'workspace', revision: 1, reason: 'flush' },
    )
    expect(coordinator.isPending).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('contains sync and async save failures, reports them on flush, and recovers', async () => {
    vi.useFakeTimers()
    const syncError = new Error('sync save failed')
    const asyncError = new Error('async save failed')
    const save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw syncError
      })
      .mockRejectedValueOnce(asyncError)
      .mockResolvedValueOnce(undefined)
    const flush = vi.fn()
    const persistence: IDEWorkspacePersistence = { save, flush }
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence,
      debounceMs: 1,
    })

    coordinator.scheduleSave({ '/main.cpp': 'sync failure' })
    await vi.advanceTimersByTimeAsync(1)
    // A failed full snapshot remains pending until a newer snapshot succeeds
    // or an explicit retry persists it.
    expect(coordinator.isPending).toBe(true)

    coordinator.scheduleSave({ '/main.cpp': 'async failure' })
    let thrown: unknown
    try {
      await coordinator.flush()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([syncError, asyncError])
    expect(flush).toHaveBeenCalledTimes(1)

    coordinator.scheduleSave({ '/main.cpp': 'recovered' })
    await expect(coordinator.flush()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls.map(([, context]) => context.revision)).toEqual([
      1,
      2,
      3,
    ])
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('disposes once after saving and flushing, even when called repeatedly', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const finalSave = deferred()
    const save = vi.fn(() => {
      calls.push('save')
      return finalSave.promise
    })
    const flush = vi.fn(() => {
      calls.push('flush')
    })
    const dispose = vi.fn(() => {
      calls.push('dispose')
    })
    const onPendingChange = vi.fn()
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush, dispose },
      debounceMs: 10_000,
      onPendingChange,
    })

    coordinator.scheduleSave({ '/main.cpp': 'final' })
    const firstDisposal = coordinator.dispose()
    const secondDisposal = coordinator.dispose()

    expect(firstDisposal).toBe(secondDisposal)
    expect(coordinator.isDisposed).toBe(true)
    expect(() =>
      coordinator.scheduleSave({ '/main.cpp': 'too late' }),
    ).toThrow(/after disposal/)

    await Promise.resolve()
    expect(calls).toEqual(['save'])
    finalSave.resolve()
    await firstDisposal

    expect(calls).toEqual(['save', 'flush', 'dispose'])
    expect(save).toHaveBeenCalledWith(
      { '/main.cpp': 'final' },
      { workspaceId: 'workspace', revision: 1, reason: 'flush' },
    )
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(coordinator.isPending).toBe(false)
    expect(onPendingChange.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
    ])

    await coordinator.dispose()
    await coordinator.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('closes safely, serializes concurrent callers, and retries an exact failed save', async () => {
    vi.useFakeTimers()
    const saveError = new Error('save failed')
    const calls: string[] = []
    const save = vi
      .fn()
      .mockImplementationOnce(() => {
        calls.push('save:failed')
        throw saveError
      })
      .mockImplementationOnce(() => {
        calls.push('save:retried')
      })
    const flush = vi.fn(() => {
      calls.push('flush')
    })
    const dispose = vi.fn(() => {
      calls.push('dispose')
    })
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush, dispose },
      debounceMs: 10_000,
    })
    const finalFiles = { '/workspace/main.cpp': 'retain this exact snapshot' }

    coordinator.scheduleSave(finalFiles)
    const firstClose = coordinator.close()
    expect(coordinator.close()).toBe(firstClose)
    await expect(firstClose).rejects.toBe(saveError)

    expect(calls).toEqual(['save:failed'])
    expect(flush).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(coordinator.isDisposed).toBe(false)
    expect(coordinator.isPending).toBe(true)

    await expect(coordinator.close()).resolves.toBeUndefined()

    expect(calls).toEqual(['save:failed', 'save:retried', 'flush', 'dispose'])
    expect(save.mock.calls.map(([files]) => files)).toEqual([
      finalFiles,
      finalFiles,
    ])
    expect(save.mock.calls.map(([, context]) => context)).toEqual([
      { workspaceId: 'workspace', revision: 1, reason: 'flush' },
      { workspaceId: 'workspace', revision: 2, reason: 'flush' },
    ])
    expect(coordinator.isDisposed).toBe(true)
    expect(coordinator.isPending).toBe(false)
  })

  it('does not dispose after a safe flush failure and retries the close', async () => {
    const flushError = new Error('flush failed')
    const calls: string[] = []
    const save = vi.fn(() => {
      calls.push('save')
    })
    const flush = vi
      .fn()
      .mockImplementationOnce(() => {
        calls.push('flush:failed')
        throw flushError
      })
      .mockImplementationOnce(() => {
        calls.push('flush:retried')
      })
    const dispose = vi.fn(() => {
      calls.push('dispose')
    })
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush, dispose },
    })

    await expect(
      coordinator.close({ '/workspace/main.cpp': 'saved before flush' }),
    ).rejects.toBe(flushError)
    expect(calls).toEqual(['save', 'flush:failed'])
    expect(dispose).not.toHaveBeenCalled()
    expect(coordinator.isDisposed).toBe(false)

    await expect(coordinator.close()).resolves.toBeUndefined()
    expect(calls).toEqual([
      'save',
      'flush:failed',
      'flush:retried',
      'dispose',
    ])
  })

  it('retries only adapter disposal after save and flush have succeeded', async () => {
    const disposeError = new Error('dispose failed')
    const save = vi.fn()
    const flush = vi.fn()
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(disposeError)
      .mockResolvedValueOnce(undefined)
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush, dispose },
    })

    await expect(
      coordinator.close({ '/workspace/main.cpp': 'final' }),
    ).rejects.toBe(disposeError)
    expect(save).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(coordinator.isDisposed).toBe(true)
    expect(() => coordinator.scheduleSave({ '/workspace/main.cpp': 'late' }))
      .toThrow(/after disposal/)

    await expect(coordinator.close()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('attempts adapter disposal after flush failure and reports both errors', async () => {
    const flushError = new Error('flush failed')
    const disposeError = new Error('dispose failed')
    const calls: string[] = []
    const flush = vi.fn(async () => {
      calls.push('flush')
      throw flushError
    })
    const dispose = vi.fn(() => {
      calls.push('dispose')
      throw disposeError
    })
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save: vi.fn(), flush, dispose },
    })

    const firstDisposal = coordinator.dispose()
    let thrown: unknown
    try {
      await firstDisposal
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([
      flushError,
      disposeError,
    ])
    expect(calls).toEqual(['flush', 'dispose'])
    expect(coordinator.dispose()).toBe(firstDisposal)
    await expect(coordinator.dispose()).rejects.toBe(thrown)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('releases forced-unmount pending state after attempting final cleanup', async () => {
    const saveError = new Error('final save failed')
    const calls: string[] = []
    const save = vi.fn(() => {
      calls.push('save')
      throw saveError
    })
    const flush = vi.fn(() => {
      calls.push('flush')
    })
    const dispose = vi.fn(() => {
      calls.push('dispose')
    })
    const onPendingChange = vi.fn()
    const coordinator = new WorkspacePersistenceCoordinator({
      workspaceId: 'workspace',
      persistence: { save, flush, dispose },
      debounceMs: 10_000,
      onPendingChange,
    })

    coordinator.scheduleSave({ '/workspace/main.cpp': 'final' })
    await expect(coordinator.dispose()).rejects.toBe(saveError)

    expect(calls).toEqual(['save', 'flush', 'dispose'])
    expect(coordinator.isPending).toBe(false)
    expect(onPendingChange.mock.calls.map(([pending]) => pending)).toEqual([
      true,
      false,
    ])
  })

  it('validates the debounce interval', () => {
    expect(
      () =>
        new WorkspacePersistenceCoordinator({
          workspaceId: 'workspace',
          persistence: { save: vi.fn() },
          debounceMs: Number.NaN,
        }),
    ).toThrow(RangeError)
  })
})

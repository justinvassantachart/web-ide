export interface Disposable {
  dispose(): void
}

export type DisposableLike = Disposable | (() => void) | void

/**
 * Normalizes a cleanup callback, disposable object, or empty value into an
 * idempotent disposable.
 */
export function toDisposable(value?: DisposableLike): Disposable {
  let disposed = false

  return {
    dispose() {
      if (disposed) return
      disposed = true

      if (typeof value === 'function') {
        value()
      } else {
        value?.dispose()
      }
    },
  }
}

/** Owns a group of resources and releases them in reverse registration order. */
export class DisposableStore implements Disposable {
  private readonly disposables: Disposable[] = []
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  add(value?: DisposableLike): Disposable {
    const disposable = toDisposable(value)

    if (this.disposed) {
      disposable.dispose()
    } else {
      this.disposables.push(disposable)
    }

    return disposable
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const errors: unknown[] = []
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop()
      try {
        disposable?.dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to dispose one or more resources')
    }
  }
}

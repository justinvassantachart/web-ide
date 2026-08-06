import { toDisposable, type Disposable } from './disposable'

export interface Contribution {
  readonly id: string
  readonly order?: number
}

interface RegisteredContribution<T> {
  readonly contribution: T
  readonly registrationOrder: number
}

interface Subscription {
  readonly listener: () => void
}

function contributionOrder(order: number | undefined): number {
  return order === undefined || Number.isNaN(order) ? 0 : order
}

/**
 * A framework-independent collection used by hosts and plugins to contribute
 * ordered IDE capabilities at runtime.
 */
export class ContributionRegistry<T extends { id: string; order?: number }>
  implements Disposable
{
  private readonly contributions = new Map<string, RegisteredContribution<T>>()
  private readonly subscriptions = new Set<Subscription>()
  private snapshot: readonly T[] = Object.freeze([])
  private nextRegistrationOrder = 0
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  /** A bound getter so consumers can safely pass it to useSyncExternalStore. */
  readonly getSnapshot = (): readonly T[] => this.snapshot

  get(id: string): T | undefined {
    return this.contributions.get(id)?.contribution
  }

  has(id: string): boolean {
    return this.contributions.has(id)
  }

  register(contribution: T): Disposable {
    if (this.disposed) {
      throw new Error('Cannot register a contribution after the registry is disposed')
    }
    if (this.contributions.has(contribution.id)) {
      throw new Error(`A contribution with id "${contribution.id}" is already registered`)
    }

    const registered: RegisteredContribution<T> = {
      contribution,
      registrationOrder: this.nextRegistrationOrder,
    }
    this.nextRegistrationOrder += 1
    this.contributions.set(contribution.id, registered)
    this.rebuildSnapshot()
    this.notifySubscribers()

    return toDisposable(() => {
      if (this.contributions.get(contribution.id) !== registered) return

      this.contributions.delete(contribution.id)
      this.rebuildSnapshot()
      this.notifySubscribers()
    })
  }

  /** A bound subscriber so consumers can adapt it without binding the registry. */
  readonly subscribe = (listener: () => void): Disposable => {
    if (this.disposed) return toDisposable()

    const subscription = { listener }
    this.subscriptions.add(subscription)
    return toDisposable(() => this.subscriptions.delete(subscription))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.contributions.clear()
    this.rebuildSnapshot()

    try {
      this.notifySubscribers()
    } finally {
      this.subscriptions.clear()
    }
  }

  private rebuildSnapshot(): void {
    const ordered = [...this.contributions.values()]
      .sort((left, right) => {
        const orderDifference =
          contributionOrder(left.contribution.order) -
          contributionOrder(right.contribution.order)
        return orderDifference || left.registrationOrder - right.registrationOrder
      })
      .map(({ contribution }) => contribution)

    this.snapshot = Object.freeze(ordered)
  }

  private notifySubscribers(): void {
    for (const { listener } of [...this.subscriptions]) listener()
  }
}

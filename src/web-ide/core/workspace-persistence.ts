import type {
  IDEWorkspacePersistence,
  WorkspaceFiles,
  WorkspaceSaveContext,
} from '../contracts/host'

export const DEFAULT_WORKSPACE_SAVE_DEBOUNCE_MS = 300

export interface WorkspacePersistenceCoordinatorOptions {
  /** Stable identity supplied by the host for this mounted workspace. */
  workspaceId: string
  persistence: IDEWorkspacePersistence
  debounceMs?: number
  /** Called only when the aggregate pending state changes. */
  onPendingChange?: (pending: boolean) => void
}

type PersistenceAction = () => void | Promise<void>

function throwPersistenceErrors(
  errors: readonly unknown[],
  message: string,
): void {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]

  throw new AggregateError([...errors], message)
}

/**
 * Coordinates host-owned persistence without depending on a UI framework or
 * application store. Each scheduled value is a complete workspace snapshot.
 */
export class WorkspacePersistenceCoordinator {
  private readonly workspaceId: string
  private readonly persistence: IDEWorkspacePersistence
  private readonly debounceMs: number
  private readonly onPendingChange?: (pending: boolean) => void

  private pendingSnapshot: WorkspaceFiles | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private operationQueue: Promise<readonly unknown[]> = Promise.resolve([])
  private queuedOperationCount = 0
  private currentRevision = 0
  private pending = false
  private disposalStarted = false
  private disposalPromise: Promise<void> | undefined

  constructor(options: WorkspacePersistenceCoordinatorOptions) {
    const debounceMs =
      options.debounceMs ?? DEFAULT_WORKSPACE_SAVE_DEBOUNCE_MS
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new RangeError('debounceMs must be a finite, non-negative number')
    }

    this.workspaceId = options.workspaceId
    this.persistence = options.persistence
    this.debounceMs = debounceMs
    this.onPendingChange = options.onPendingChange
  }

  /** True while a snapshot is debouncing or persistence work is queued. */
  get isPending(): boolean {
    return this.pending
  }

  /** The most recent revision assigned to an actual save operation. */
  get revision(): number {
    return this.currentRevision
  }

  /** True as soon as disposal begins; no further snapshots are accepted. */
  get isDisposed(): boolean {
    return this.disposalStarted
  }

  /**
   * Schedules a full workspace snapshot. Repeated calls inside the debounce
   * window coalesce to the latest snapshot.
   */
  scheduleSave(files: WorkspaceFiles): void {
    if (this.disposalStarted) {
      throw new Error('Cannot schedule a workspace save after disposal has started')
    }

    // Hosts commonly reuse mutable file maps, so retain our own point-in-time
    // snapshot instead of observing later mutations.
    this.pendingSnapshot = { ...files }
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      this.queuePendingSnapshot('change')
      this.refreshPendingState()
    }, this.debounceMs)
    this.refreshPendingState()
  }

  /**
   * Bypasses the debounce delay, waits for all saves known at call time, and
   * then asks the host persistence adapter to flush.
   */
  flush(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise

    this.clearDebounceTimer()
    this.queuePendingSnapshot('flush')
    this.refreshPendingState()

    return this.performFlush()
  }

  /**
   * Idempotently saves the final snapshot, flushes the host adapter, and then
   * disposes it. Flush and dispose are both attempted even if an earlier step
   * fails.
   */
  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise

    this.disposalStarted = true
    this.clearDebounceTimer()
    this.queuePendingSnapshot('flush')
    this.refreshPendingState()
    this.disposalPromise = this.performDispose()
    return this.disposalPromise
  }

  private async performFlush(): Promise<void> {
    const errors = await this.enqueueActions(
      [() => this.persistence.flush?.()],
      true,
    )
    throwPersistenceErrors(errors, 'Failed to flush workspace persistence')
  }

  private async performDispose(): Promise<void> {
    const errors = await this.enqueueActions(
      [
        () => this.persistence.flush?.(),
        () => this.persistence.dispose?.(),
      ],
      true,
    )
    throwPersistenceErrors(errors, 'Failed to dispose workspace persistence')
  }

  private queuePendingSnapshot(reason: WorkspaceSaveContext['reason']): void {
    const files = this.pendingSnapshot
    if (files === undefined) return

    this.pendingSnapshot = undefined
    this.currentRevision += 1
    const context: WorkspaceSaveContext = {
      workspaceId: this.workspaceId,
      revision: this.currentRevision,
      reason,
    }

    void this.enqueueActions(
      [() => this.persistence.save(files, context)],
      false,
    )
  }

  /**
   * Keeps every adapter call serialized. The queue carries unreported errors
   * forward until an explicit flush or disposal can surface them to its caller.
   */
  private enqueueActions(
    actions: readonly PersistenceAction[],
    consumeErrors: boolean,
  ): Promise<readonly unknown[]> {
    this.queuedOperationCount += 1
    this.refreshPendingState()

    const operation = this.operationQueue.then(async (previousErrors) => {
      const errors = [...previousErrors]
      for (const action of actions) {
        try {
          await action()
        } catch (error) {
          errors.push(error)
        }
      }
      return errors
    })

    const trackedOperation = operation.then((errors) => {
      this.queuedOperationCount -= 1
      this.refreshPendingState()
      return errors
    })

    // A flush reports everything through its position in the queue. Later
    // operations start with a clean error collection and are reported by the
    // next flush or disposal.
    this.operationQueue = consumeErrors
      ? trackedOperation.then(() => [])
      : trackedOperation

    return trackedOperation
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === undefined) return
    clearTimeout(this.debounceTimer)
    this.debounceTimer = undefined
  }

  private refreshPendingState(): void {
    const nextPending =
      this.pendingSnapshot !== undefined ||
      this.debounceTimer !== undefined ||
      this.queuedOperationCount > 0
    if (nextPending === this.pending) return

    this.pending = nextPending
    try {
      this.onPendingChange?.(nextPending)
    } catch {
      // An observer must not be able to interrupt persistence or queue cleanup.
    }
  }
}

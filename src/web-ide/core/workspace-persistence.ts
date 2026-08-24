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

interface PendingWorkspaceSnapshot {
  files: WorkspaceFiles
  sourceRevision: number
}

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

  private pendingSnapshot: PendingWorkspaceSnapshot | undefined
  private retrySnapshot: PendingWorkspaceSnapshot | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private operationQueue: Promise<readonly unknown[]> = Promise.resolve([])
  private queuedOperationCount = 0
  private nextSourceRevision = 0
  private persistedSourceRevision = 0
  private currentRevision = 0
  private pending = false
  private forcedDisposalStarted = false
  private adapterDisposalStarted = false
  private closed = false
  private closePromise: Promise<void> | undefined
  private forcedDisposalPromise: Promise<void> | undefined

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

  /** True as soon as adapter or forced disposal begins. */
  get isDisposed(): boolean {
    return this.closed || this.forcedDisposalStarted || this.adapterDisposalStarted
  }

  /**
   * Schedules a full workspace snapshot. Repeated calls inside the debounce
   * window coalesce to the latest snapshot.
   */
  scheduleSave(files: WorkspaceFiles): void {
    if (this.closed || this.forcedDisposalStarted || this.adapterDisposalStarted) {
      throw new Error('Cannot schedule a workspace save after disposal has started')
    }

    // Hosts commonly reuse mutable file maps, so retain our own point-in-time
    // snapshot instead of observing later mutations.
    this.pendingSnapshot = {
      files: { ...files },
      sourceRevision: ++this.nextSourceRevision,
    }
    this.clearDebounceTimer()
    // A close attempt drains snapshots itself. Keeping later changes pending
    // lets it save and flush them before the adapter is disposed.
    if (!this.closePromise) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined
        this.queuePendingSnapshot('change')
        this.refreshPendingState()
      }, this.debounceMs)
    }
    this.refreshPendingState()
  }

  /**
   * Bypasses the debounce delay, waits for all saves known at call time, and
   * then asks the host persistence adapter to flush.
   */
  flush(files?: WorkspaceFiles): Promise<void> {
    if (this.closed && this.closePromise) return this.closePromise
    if (this.forcedDisposalPromise) return this.forcedDisposalPromise
    if (this.closePromise) return this.closePromise
    if (this.adapterDisposalStarted) {
      return Promise.reject(
        new Error('Cannot flush workspace persistence after adapter disposal has started'),
      )
    }
    if (files) this.scheduleSave(files)

    this.clearDebounceTimer()
    this.queuePendingSnapshot('flush')
    this.refreshPendingState()

    return this.performFlush()
  }

  /**
   * Saves and flushes before adapter disposal. Concurrent calls share one
   * attempt. A save/flush failure leaves the adapter live and the exact failed
   * snapshot available for a later retry.
   */
  close(files?: WorkspaceFiles): Promise<void> {
    if (this.closed && this.closePromise) return this.closePromise
    if (this.forcedDisposalPromise) return this.forcedDisposalPromise
    if (this.closePromise) return this.closePromise
    if (files && !this.adapterDisposalStarted) this.scheduleSave(files)

    this.clearDebounceTimer()
    this.refreshPendingState()
    const attempt = this.performClose()
    this.closePromise = attempt
    void attempt.then(
      () => {
        this.closed = true
      },
      () => {
        if (this.closePromise === attempt) this.closePromise = undefined
      },
    )
    return attempt
  }

  /**
   * Forced unmount cleanup. Unlike explicit close, this retains the 0.1
   * best-effort behavior of attempting adapter disposal after persistence
   * failure so listeners and transport resources are not leaked.
   */
  dispose(): Promise<void> {
    if (this.closed && this.closePromise) return this.closePromise
    if (this.forcedDisposalPromise) return this.forcedDisposalPromise

    this.forcedDisposalStarted = true
    this.clearDebounceTimer()
    this.refreshPendingState()
    const activeClose = this.closePromise
    const forced = activeClose
      ? activeClose.then(
          () => undefined,
          () => this.startForcedDisposal(),
        )
      : this.startForcedDisposal()
    this.forcedDisposalPromise = forced
    return forced
  }

  private async performFlush(): Promise<void> {
    const errors = await this.enqueueActions(
      [() => this.persistence.flush?.()],
      true,
    )
    throwPersistenceErrors(errors, 'Failed to flush workspace persistence')
  }

  private async performClose(): Promise<void> {
    const errors = await this.enqueueSafeClose()
    throwPersistenceErrors(errors, 'Failed to close workspace persistence')
  }

  private async performDispose(): Promise<void> {
    const errors = await this.enqueueActions(
      [
        () => this.persistence.flush?.(),
        () => {
          this.adapterDisposalStarted = true
          return this.persistence.dispose?.()
        },
      ],
      true,
    )
    this.abandonSnapshotsAfterForcedDisposal()
    throwPersistenceErrors(errors, 'Failed to dispose workspace persistence')
  }

  private startForcedDisposal(): Promise<void> {
    if (!this.adapterDisposalStarted) {
      this.clearDebounceTimer()
      this.queuePendingSnapshot('flush')
    }
    this.refreshPendingState()

    if (this.adapterDisposalStarted) {
      return this.enqueueActions(
        [() => this.persistence.dispose?.()],
        true,
      ).then((errors) => {
        this.abandonSnapshotsAfterForcedDisposal()
        throwPersistenceErrors(errors, 'Failed to dispose workspace persistence')
      })
    }
    return this.performDispose()
  }

  private abandonSnapshotsAfterForcedDisposal(): void {
    this.clearDebounceTimer()
    this.pendingSnapshot = undefined
    this.retrySnapshot = undefined
    this.refreshPendingState()
  }

  private queuePendingSnapshot(reason: WorkspaceSaveContext['reason']): void {
    const snapshot = this.takeNextSnapshot()
    if (snapshot === undefined) return

    void this.enqueueActions(
      [() => this.saveSnapshot(snapshot, reason)],
      false,
    )
  }

  private takeNextSnapshot(): PendingWorkspaceSnapshot | undefined {
    const pending = this.pendingSnapshot
    const retry = this.retrySnapshot
    const snapshot =
      pending && retry
        ? pending.sourceRevision >= retry.sourceRevision ? pending : retry
        : pending ?? retry
    if (!snapshot) return undefined

    if (pending === snapshot) this.pendingSnapshot = undefined
    if (retry && retry.sourceRevision <= snapshot.sourceRevision) {
      this.retrySnapshot = undefined
    }
    return snapshot
  }

  private async saveSnapshot(
    snapshot: PendingWorkspaceSnapshot,
    reason: WorkspaceSaveContext['reason'],
  ): Promise<void> {
    const context: WorkspaceSaveContext = {
      workspaceId: this.workspaceId,
      revision: ++this.currentRevision,
      reason,
    }
    try {
      await this.persistence.save(snapshot.files, context)
      this.persistedSourceRevision = Math.max(
        this.persistedSourceRevision,
        snapshot.sourceRevision,
      )
      if (
        this.retrySnapshot
        && this.retrySnapshot.sourceRevision <= this.persistedSourceRevision
      ) {
        this.retrySnapshot = undefined
      }
    } catch (error) {
      const newerSnapshot = this.pendingSnapshot
      if (
        snapshot.sourceRevision > this.persistedSourceRevision
        && (!newerSnapshot || newerSnapshot.sourceRevision < snapshot.sourceRevision)
        && (!this.retrySnapshot
          || this.retrySnapshot.sourceRevision <= snapshot.sourceRevision)
      ) {
        this.retrySnapshot = snapshot
      }
      throw error
    } finally {
      this.refreshPendingState()
    }
  }

  /** Runs one explicit close at the serialized persistence boundary. */
  private enqueueSafeClose(): Promise<readonly unknown[]> {
    this.queuedOperationCount += 1
    this.refreshPendingState()

    const operation = this.operationQueue.then(async (previousErrors) => {
      const errors = [...previousErrors]
      if (errors.length > 0) return errors

      if (this.adapterDisposalStarted) {
        try {
          await this.persistence.dispose?.()
        } catch (error) {
          errors.push(error)
        }
        return errors
      }

      while (errors.length === 0) {
        this.clearDebounceTimer()
        const snapshot = this.takeNextSnapshot()
        if (snapshot) {
          try {
            await this.saveSnapshot(snapshot, 'flush')
          } catch (error) {
            errors.push(error)
          }
          continue
        }

        try {
          await this.persistence.flush?.()
        } catch (error) {
          errors.push(error)
          break
        }

        // A workspace change can arrive while the asynchronous host flush is
        // settling. Save it and flush once more before committing to dispose.
        this.clearDebounceTimer()
        if (this.pendingSnapshot || this.retrySnapshot) continue

        this.adapterDisposalStarted = true
        try {
          await this.persistence.dispose?.()
        } catch (error) {
          errors.push(error)
        }
        break
      }
      return errors
    })

    const trackedOperation = operation.then((errors) => {
      this.queuedOperationCount -= 1
      this.refreshPendingState()
      return errors
    })
    this.operationQueue = trackedOperation.then(() => [])
    return trackedOperation
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
      this.retrySnapshot !== undefined ||
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

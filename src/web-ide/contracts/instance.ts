import type { MemorySnapshot, RuntimeWarmupResult, StackFrame } from './runtime'
import type { WorkspaceFiles } from './host'
import type {
  IDEWorkspaceExternalApplication,
  IDEWorkspaceFeed,
  IDEWorkspacePersistenceStatusFeed,
} from './workspace'

export type IDEInstanceDebugMode = 'idle' | 'compiling' | 'running' | 'paused'

export interface IDEInstanceTestCase {
  name: string
  status: 'running' | 'pass' | 'fail'
}

/** Immutable, host-facing snapshot of observable workbench state. */
export interface IDEInstanceSnapshot {
  workspace: WorkspaceFiles
  editor: {
    activeFile: string | null
    openFiles: readonly string[]
  }
  debug: {
    debugMode: IDEInstanceDebugMode
    currentLine: number | null
    currentFile: string | null
    currentFunc: string | null
    breakpoints: Readonly<Record<string, readonly number[]>>
    callStack: readonly StackFrame[]
    memorySnapshot: MemorySnapshot | null
  }
  rightPanel: string
  tests: readonly IDEInstanceTestCase[]
}

export interface IDEInstanceResetOptions {
  /** Clear breakpoints for these paths before resetting runtime/test state. */
  breakpointFiles?: readonly string[]
}

/**
 * Narrow imperative surface for an embedding host. It exposes snapshots and
 * intent-level actions, never Zustand stores or mutable implementation state.
 */
export interface WebIDEInstanceHandle {
  /** Instance-scoped canonical workspace feed and narrow external apply facade. */
  readonly workspace: IDEWorkspaceFeed & IDEWorkspaceExternalApplication
  /** Host persistence state; collaboration connection/presence is intentionally separate. */
  readonly persistence: IDEWorkspacePersistenceStatusFeed
  snapshot(): IDEInstanceSnapshot
  subscribe(listener: () => void): () => void
  /**
   * Returns a point-in-time copy of the user workspace plane. Execution-only
   * resources are never included in this host-persistence projection.
   */
  persistedFiles(): WorkspaceFiles
  /**
   * Saves the current persisted-file projection and awaits the host adapter.
   * With a memory local cache, that host adapter is the durability authority.
   */
  flushWorkspace(): Promise<void>
  /**
   * Saves and flushes before disposing host persistence. A failed close is
   * retryable and never disposes the adapter before persistence succeeds.
   */
  close(): Promise<void>
  /** Permanently fences runtime dispatch and drains owned resources; persistence is separate. */
  shutdownRuntime(): Promise<void>
  /** Reversibly fences and drains execution for a persisted page suspension. */
  suspendRuntime(): Promise<void>
  /** Waits for suspension cleanup and enables the next explicit execution lazily. */
  resumeRuntime(): Promise<void>
  /** Releases idle compiler resources, without initializing an absent runtime. */
  releaseCompilerResources(options?: { signal?: AbortSignal }): Promise<'released' | 'cancelled'>
  /** One host-requested compile-only attempt from the current owned execution snapshot. */
  warmup?(): Promise<RuntimeWarmupResult>
  /** Cancels and drains background compilation without starting foreground execution. */
  cancelWarmup?(): Promise<void>
  /** Owned, backend-specific foreground/warmup compilation statistics when supported. */
  compilationStatistics?(): unknown
  /** Opens every existing path and focuses `primaryPath` last. */
  ensureFilesOpen(paths: readonly string[], primaryPath?: string): boolean
  reset(options?: IDEInstanceResetOptions): void
}

import type { MemorySnapshot, StackFrame } from './runtime'
import type { WorkspaceFiles } from './host'

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
  /** Opens every existing path and focuses `primaryPath` last. */
  ensureFilesOpen(paths: readonly string[], primaryPath?: string): boolean
  reset(options?: IDEInstanceResetOptions): void
}

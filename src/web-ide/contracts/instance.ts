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
  /** Opens every existing path and focuses `primaryPath` last. */
  ensureFilesOpen(paths: readonly string[], primaryPath?: string): boolean
  reset(options?: IDEInstanceResetOptions): void
}

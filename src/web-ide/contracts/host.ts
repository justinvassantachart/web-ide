import type { IDEEventSink } from './events'

export type WorkspaceFiles = Record<string, string>

export interface WorkspaceSaveContext {
  /** Stable, host-owned identity for the mounted workspace. */
  workspaceId: string
  /** Monotonically increasing revision within this Web IDE mount. */
  revision: number
  reason: 'change' | 'flush'
}

/** Host-owned persistence. The workbench never assumes a database or SDK. */
export interface IDEWorkspacePersistence {
  save(files: WorkspaceFiles, context: WorkspaceSaveContext): void | Promise<void>
  flush?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface IDEWorkspace {
  /**
   * Used to isolate browser-local state. Nova composes assignment/submission
   * identifiers here; the reusable workbench does not know LMS vocabulary.
   */
  id: string
  initialFiles?: WorkspaceFiles
  /** `memory` skips OPFS and always re-seeds from initialFiles. */
  localCache?: 'opfs' | 'memory'
  readOnly?: boolean
  persistence?: IDEWorkspacePersistence
}

export interface IDEChrome {
  sidebar?: boolean
  brand?: boolean
  statusBar?: boolean
}

export interface IDEHostEvents {
  emit: IDEEventSink
  /** Opt in to terminal, process-exit, and debugger-pause events. */
  includeRuntime?: boolean
}

/**
 * Stable embedding contract implemented by Nova (or any future host).
 * Public consumers receive facades and callbacks only—never internal stores.
 */
export interface WebIDEHost {
  workspace?: IDEWorkspace
  chrome?: IDEChrome
  events?: IDEHostEvents
}

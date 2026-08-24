import type { ComponentType } from 'react'
import type { WorkspaceFiles } from './host'
import type {
  RuntimeCapabilities,
  RuntimeExecutionMode,
  RuntimeSession,
} from './runtime'
import type { IDESourcePresentationOwner } from './source-presentation'

export type IDEWorkbenchRunState = 'idle' | 'running' | 'paused'
export type IDEExecutionMode = RuntimeExecutionMode | 'test'

/** Read-only UI state passed to contribution predicates, not a store. */
export interface IDEWorkbenchSnapshot {
  runState: IDEWorkbenchRunState
  isCompiling: boolean
  runtimeReady: boolean
  runtimeCapabilities: Readonly<RuntimeCapabilities>
  testingAvailable: boolean
}

export interface IDEExecutionController {
  start(mode: IDEExecutionMode): Promise<void>
  /** Existing synchronous implementations remain valid; callers may await cleanup. */
  stop(): void | Promise<void>
  restart(mode: RuntimeExecutionMode): Promise<void>
}

export interface IDECommandContext {
  readonly execution: IDEExecutionController
  readonly workspace: {
    snapshot(): WorkspaceFiles
  }
  readonly panels: {
    reveal(id: string): void
  }
}

export type IDECommandTone = 'default' | 'success' | 'danger'

export interface IDECommandContribution {
  id: string
  title: string
  icon?: string
  order?: number
  group?: string
  /** Currently rendered when set to `toolbar`; more surfaces require consumers. */
  surface?: 'toolbar'
  tone?: IDECommandTone
  when?(snapshot: IDEWorkbenchSnapshot): boolean
  enabled?(snapshot: IDEWorkbenchSnapshot): boolean
  disabledReason?(snapshot: IDEWorkbenchSnapshot): string | undefined
  execute(context: IDECommandContext): void | Promise<void>
}

export interface IDEPanelServices {
  readonly runtime: RuntimeSession
  /** Uses the same instance-scoped prepare/start/stop pipeline as commands. */
  readonly execution: IDEExecutionController
  /** Owner-bound navigation/decorations facade; the host revokes it on unmount. */
  readonly source: IDESourcePresentationOwner
  readonly workspace: {
    snapshot(): WorkspaceFiles
  }
  readonly panels: {
    reveal(id: string): void
  }
}

/** A panel receives only instance-scoped public facades, never store handles. */
export interface IDEPanelContribution {
  id: string
  title: string
  component: ComponentType<IDEPanelServices>
  order?: number
  /** Controls visibility from an immutable workbench snapshot. */
  when?(snapshot: IDEWorkbenchSnapshot): boolean
}

/**
 * A view shown in the workbench activity bar and sidebar. Applications may
 * contribute arbitrary activities; Web IDE does not own a closed catalog.
 */
export interface IDEActivityContribution {
  id: string
  title: string
  icon: string
  component: ComponentType<IDEPanelServices>
  order?: number
}

/**
 * Files supplied by any host-created plugin. Workspace-scoped resources seed
 * the VFS, where host initial files win collisions and an existing local cache
 * may already own the path. Execution-only resources bypass the VFS and are
 * added to runtime plans instead.
 */
export interface IDEWorkspaceResourceContribution {
  id: string
  /** Omitted retains the existing editable and persisted workspace behavior. */
  scope?: 'workspace' | 'execution-only'
  /**
   * A callback is valid only with `scope: 'execution-only'` and is evaluated
   * exactly once per prepared run. Workspace-scoped callbacks are rejected.
   */
  files: WorkspaceFiles | (() => WorkspaceFiles)
  order?: number
}

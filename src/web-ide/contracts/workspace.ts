import type { WorkspaceFiles } from './host'

export type WorkspaceOperationV1 =
  | { readonly op: 'write'; readonly path: string; readonly text: string; readonly expectedSha256?: string }
  | { readonly op: 'create'; readonly path: string; readonly text: string }
  | { readonly op: 'delete'; readonly path: string; readonly expectedSha256?: string }
  | { readonly op: 'rename'; readonly from: string; readonly to: string; readonly expectedSha256?: string }
  | { readonly op: 'replace'; readonly files: Readonly<WorkspaceFiles> }

export interface WorkspaceOriginV1 {
  readonly kind: 'local-user' | 'external-authority' | 'bootstrap' | 'restore' | 'provider'
  readonly source: string
  readonly echoToken?: string
}

export interface WorkspaceApplyTransactionV1 {
  readonly version: 1
  readonly kind: 'apply'
  readonly transactionId: string
  readonly expectedRevision: number
  readonly origin: WorkspaceOriginV1
  readonly operations: readonly WorkspaceOperationV1[]
}

export interface WorkspaceChangeV1 {
  readonly version: 1
  readonly kind: 'change'
  readonly revision: number
  readonly transactionId: string
  readonly origin: WorkspaceOriginV1
  readonly operations: readonly WorkspaceOperationV1[]
}

export interface IDEWorkspaceFeed {
  snapshot(): WorkspaceFiles
  revision(): number
  subscribe(listener: (change: WorkspaceChangeV1) => void): () => void
}

/**
 * The authority-bearing mutation seam intentionally accepts only external
 * origins. Local UI, bootstrap, restore, and provider lifecycles have separate
 * instance-owned controller methods.
 */
export interface IDEWorkspaceExternalApplication {
  apply(transaction: WorkspaceApplyTransactionV1 & {
    readonly origin: WorkspaceOriginV1 & { readonly kind: 'external-authority' }
  }): Promise<WorkspaceChangeV1>
}

export type WorkspacePersistenceStatus =
  | { readonly state: 'saved' }
  | { readonly state: 'saving' }
  | { readonly state: 'retrying'; readonly message?: string }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: string; readonly [detail: string]: unknown }

export interface IDEWorkspacePersistenceStatusFeed {
  snapshot(): WorkspacePersistenceStatus
  subscribe(listener: (status: WorkspacePersistenceStatus) => void): () => void
}

export type WorkspaceMutationKind = 'write' | 'create' | 'delete' | 'rename'

export interface WorkspaceMutationRequest {
  readonly kind: WorkspaceMutationKind
  readonly path: string
  readonly to?: string
}

/** Optional host policy for local user mutations. `readOnly` remains the coarse switch. */
export type WorkspaceMutationPolicy = (
  request: WorkspaceMutationRequest,
) => boolean

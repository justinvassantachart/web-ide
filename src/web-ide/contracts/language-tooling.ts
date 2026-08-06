import type { ComponentType } from 'react'
import type { WorkspaceFiles } from './host'

export type LanguageToolingStatus =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'starting'; loaded?: number; total?: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }
  | { state: 'disposed' }

/** Optional provider-owned preference rendered by the generic settings menu. */
export interface LanguageToolingSetting {
  /** Settings section heading. Defaults to `Language Tooling`. */
  section?: string
  /** User-facing checkbox label. */
  label: string
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  /** Reload the page after changing the preference. */
  reloadOnChange?: boolean
}

/** Editor-facing service published by the selected provider component. */
export interface LanguageToolingService {
  readonly providerId: string | null
  readonly status: LanguageToolingStatus
  /**
   * Called when a user engages with a workspace file. Providers ignore paths
   * they do not support and may lazily start their backend on the first call.
   */
  arm(path: string): void
  readonly setting?: LanguageToolingSetting
}

export interface LanguageToolingProviderComponentProps {
  /** Host policy such as a read-only workspace can disable backend startup. */
  disabled?: boolean
  /** Ephemeral declarations supplied by another selected provider. */
  supplementalFiles?: WorkspaceFiles
  /**
   * Publishes the current service to the workbench. Call from an effect and
   * publish `null` during cleanup; no internal React context is required.
   */
  publishService(service: LanguageToolingService | null): void
}

/** Optional language tooling backend contributed by an IDE plugin. */
export interface LanguageToolingProvider {
  id: string
  label: string
  /** Monaco language IDs served by this provider. */
  languageIds: readonly string[]
  component: ComponentType<LanguageToolingProviderComponentProps>
  order?: number
}

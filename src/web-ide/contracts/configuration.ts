import type { IDEPlugin } from './plugin'

/** Initial workbench presentation chosen by the embedding host. */
export interface WebIDEInitialLayout {
  /** Exact ID of an installed activity contribution to show on first mount. */
  selectedActivityId?: string
  /** Exact ID of an installed panel contribution to show on first mount. */
  selectedPanelId?: string
  /** Initial width of the contributed-panel column, as a percentage. */
  panelColumnPercent?: number
  /** Initial height of panel content above the terminal, as a percentage. */
  panelContentPercent?: number
}

export interface WebIDEConfiguration {
  /** ID of a runtime provider contributed by one of `plugins`. */
  runtimeProvider: string
  /**
   * Optional language tooling provider contributed by one of `plugins`.
   * Omit it for a workbench with Monaco's built-in language support only.
   */
  languageToolingProvider?: string
  /**
   * Optional explicit test provider. When omitted, exactly one provider whose
   * language IDs overlap the selected runtime is selected automatically.
   */
  testProvider?: string
  /** Host-controlled wordmark. Defaults to `WEB·IDE`; set false to hide it. */
  brand?: string | false
  /** Label printed when a terminal session mounts. Defaults to `Web IDE Terminal`. */
  terminalName?: string
  /**
   * Preserve a host SPA's hard-navigation recovery when it owns COOP/COEP.
   * Generic embeds should leave this false and configure headers themselves.
   */
  reloadWhenNotIsolated?: boolean
  /**
   * Optional per-mount presentation. Omitted fields retain the workbench's
   * established defaults; user changes after mount are not persisted.
   */
  initialLayout?: WebIDEInitialLayout
  plugins: readonly IDEPlugin[]
}

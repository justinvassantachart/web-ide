import type { IDEPlugin } from './plugin'

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
  plugins: readonly IDEPlugin[]
}

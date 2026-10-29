import type {
  IDEActivityContribution,
  IDECommandContribution,
  IDEPanelContribution,
  IDEWorkspaceResourceContribution,
} from './contributions'
import type { RuntimeProvider, RuntimeSession } from './runtime'
import type { TestProviderContribution } from './testing'
import type { LanguageToolingProvider } from './language-tooling'
import type { Disposable, DisposableLike } from '../core/disposable'
import type { DebugValueFormatter } from './debug-presentation'

export interface IDEContributionRegistrar<T> {
  register(contribution: T): Disposable
}

export interface IDEPluginContributions {
  activities?: readonly IDEActivityContribution[]
  commands?: readonly IDECommandContribution[]
  panels?: readonly IDEPanelContribution[]
  resources?: readonly IDEWorkspaceResourceContribution[]
  runtimeProviders?: readonly RuntimeProvider[]
  testProviders?: readonly TestProviderContribution[]
  languageToolingProviders?: readonly LanguageToolingProvider[]
  debugFormatters?: readonly DebugValueFormatter[]
}

export interface IDEPluginActivationServices {
  /** The instance-scoped session selected by the consuming host. */
  runtime?: RuntimeSession
}

export interface IDEPluginContext {
  readonly activities: IDEContributionRegistrar<IDEActivityContribution>
  readonly commands: IDEContributionRegistrar<IDECommandContribution>
  readonly panels: IDEContributionRegistrar<IDEPanelContribution>
  readonly resources: IDEContributionRegistrar<IDEWorkspaceResourceContribution>
  readonly runtimeProviders: IDEContributionRegistrar<RuntimeProvider>
  readonly testProviders: IDEContributionRegistrar<TestProviderContribution>
  readonly languageToolingProviders: IDEContributionRegistrar<LanguageToolingProvider>
  readonly debugFormatters: IDEContributionRegistrar<DebugValueFormatter>
  /** Available when activated by <WebIDE>; optional for headless tooling. */
  readonly runtime?: RuntimeSession
  /** Registers timers/listeners/resources for automatic plugin deactivation. */
  register(disposable: DisposableLike): Disposable
}

export interface IDEPlugin {
  id: string
  contributes?: IDEPluginContributions
  activate?(context: IDEPluginContext): DisposableLike
}

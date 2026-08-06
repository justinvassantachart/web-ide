import type {
  IDEActivityContribution,
  IDECommandContribution,
  IDEPanelContribution,
  IDEWorkspaceResourceContribution,
} from './contributions'
import type { RuntimeProvider, RuntimeSession } from './runtime'
import type { TestProvider } from './testing'
import type { LanguageToolingProvider } from './language-tooling'
import type { Disposable, DisposableLike } from '../core/disposable'

export interface IDEContributionRegistrar<T> {
  register(contribution: T): Disposable
}

export interface IDEPluginContributions {
  activities?: readonly IDEActivityContribution[]
  commands?: readonly IDECommandContribution[]
  panels?: readonly IDEPanelContribution[]
  resources?: readonly IDEWorkspaceResourceContribution[]
  runtimeProviders?: readonly RuntimeProvider[]
  testProviders?: readonly TestProvider[]
  languageToolingProviders?: readonly LanguageToolingProvider[]
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
  readonly testProviders: IDEContributionRegistrar<TestProvider>
  readonly languageToolingProviders: IDEContributionRegistrar<LanguageToolingProvider>
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

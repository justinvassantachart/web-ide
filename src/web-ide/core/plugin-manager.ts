import type {
  IDEActivityContribution,
  IDECommandContribution,
  IDEPanelContribution,
  IDEWorkspaceResourceContribution,
} from '../contracts/contributions'
import type {
  IDEContributionRegistrar,
  IDEPlugin,
  IDEPluginActivationServices,
  IDEPluginContext,
} from '../contracts/plugin'
import type { RuntimeProvider } from '../contracts/runtime'
import type { TestProvider } from '../contracts/testing'
import type { LanguageToolingProvider } from '../contracts/language-tooling'
import { ContributionRegistry } from './contribution-registry'
import {
  DisposableStore,
  toDisposable,
  type Disposable,
  type DisposableLike,
} from './disposable'

function duplicatePluginError(id: string): Error {
  return new Error(`A plugin with id "${id}" is already registered`)
}

/**
 * Owns the declarative contributions and activation lifecycles for one Web IDE
 * instance. Plugin activation is deliberately framework-independent so the
 * same manager can be mounted, unmounted, and mounted again by any host.
 */
export class IDEPluginManager implements Disposable {
  readonly activities = new ContributionRegistry<IDEActivityContribution>()
  readonly commands = new ContributionRegistry<IDECommandContribution>()
  readonly panels = new ContributionRegistry<IDEPanelContribution>()
  readonly resources = new ContributionRegistry<IDEWorkspaceResourceContribution>()
  readonly runtimeProviders = new ContributionRegistry<RuntimeProvider>()
  readonly testProviders = new ContributionRegistry<TestProvider>()
  readonly languageToolingProviders = new ContributionRegistry<LanguageToolingProvider>()

  private readonly plugins: readonly IDEPlugin[]
  private readonly staticRegistrations = new DisposableStore()
  private readonly activeActivations = new Set<Disposable>()
  private disposed = false

  constructor(plugins: readonly IDEPlugin[]) {
    this.plugins = Object.freeze([...plugins])
    this.assertUniquePluginIds()

    try {
      for (const plugin of this.plugins) {
        this.registerStaticContributions(plugin)
      }
    } catch (error) {
      // The manager never escapes its constructor on this path, but rolling
      // everything back keeps registration atomic even for observable values.
      this.disposeAfterConstructionFailure()
      throw error
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Activates every plugin in declaration order. Each call is an independent
   * lifecycle, allowing hosts such as React StrictMode to activate, deactivate,
   * and activate the same manager again without retaining prior resources.
   */
  activate(services: IDEPluginActivationServices = {}): Disposable {
    if (this.disposed) {
      throw new Error('Cannot activate a disposed plugin manager')
    }

    const activationScope = new DisposableStore()
    const activation = toDisposable(() => {
      this.activeActivations.delete(activation)
      activationScope.dispose()
    })
    this.activeActivations.add(activation)

    try {
      for (const plugin of this.plugins) {
        const pluginScope = new DisposableStore()
        activationScope.add(pluginScope)

        if (plugin.activate) {
          pluginScope.add(plugin.activate(this.createPluginContext(pluginScope, services)))
        }
      }
    } catch (error) {
      try {
        activation.dispose()
      } catch {
        // An activation error is the actionable failure. Disposal still tries
        // every registered cleanup, and must not replace that original error.
      }
      throw error
    }

    return activation
  }

  /** Permanently releases this manager, including any still-active cycles. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const errors: unknown[] = []
    const disposeSafely = (disposable: Disposable): void => {
      try {
        disposable.dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    for (const activation of [...this.activeActivations].reverse()) {
      disposeSafely(activation)
    }
    this.activeActivations.clear()

    disposeSafely(this.staticRegistrations)
    disposeSafely(this.testProviders)
    disposeSafely(this.languageToolingProviders)
    disposeSafely(this.runtimeProviders)
    disposeSafely(this.resources)
    disposeSafely(this.panels)
    disposeSafely(this.commands)
    disposeSafely(this.activities)

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to dispose the plugin manager')
    }
  }

  private assertUniquePluginIds(): void {
    const ids = new Set<string>()

    for (const plugin of this.plugins) {
      if (ids.has(plugin.id)) throw duplicatePluginError(plugin.id)
      ids.add(plugin.id)
    }
  }

  private registerStaticContributions(plugin: IDEPlugin): void {
    for (const activity of plugin.contributes?.activities ?? []) {
      this.staticRegistrations.add(this.activities.register(activity))
    }
    for (const command of plugin.contributes?.commands ?? []) {
      this.staticRegistrations.add(this.commands.register(command))
    }
    for (const panel of plugin.contributes?.panels ?? []) {
      this.staticRegistrations.add(this.panels.register(panel))
    }
    for (const resource of plugin.contributes?.resources ?? []) {
      this.staticRegistrations.add(this.resources.register(resource))
    }
    for (const provider of plugin.contributes?.runtimeProviders ?? []) {
      this.staticRegistrations.add(this.runtimeProviders.register(provider))
    }
    for (const provider of plugin.contributes?.testProviders ?? []) {
      this.staticRegistrations.add(this.testProviders.register(provider))
    }
    for (const provider of plugin.contributes?.languageToolingProviders ?? []) {
      this.staticRegistrations.add(this.languageToolingProviders.register(provider))
    }
  }

  private createPluginContext(
    scope: DisposableStore,
    services: IDEPluginActivationServices,
  ): IDEPluginContext {
    return {
      activities: this.createRegistrar(this.activities, scope),
      commands: this.createRegistrar(this.commands, scope),
      panels: this.createRegistrar(this.panels, scope),
      resources: this.createRegistrar(this.resources, scope),
      runtimeProviders: this.createRegistrar(this.runtimeProviders, scope),
      testProviders: this.createRegistrar(this.testProviders, scope),
      languageToolingProviders: this.createRegistrar(
        this.languageToolingProviders,
        scope,
      ),
      runtime: services.runtime,
      register: (disposable) => scope.add(disposable),
    }
  }

  private createRegistrar<T extends { id: string; order?: number }>(
    registry: ContributionRegistry<T>,
    scope: DisposableStore,
  ): IDEContributionRegistrar<T> {
    return {
      register: (contribution) => scope.add(registry.register(contribution)),
    }
  }

  private disposeAfterConstructionFailure(): void {
    const resources: readonly DisposableLike[] = [
      this.staticRegistrations,
      this.testProviders,
      this.languageToolingProviders,
      this.runtimeProviders,
      this.resources,
      this.panels,
      this.commands,
      this.activities,
    ]

    for (const resource of resources) {
      try {
        toDisposable(resource).dispose()
      } catch {
        // Preserve the registration failure that made construction abort.
      }
    }
  }
}

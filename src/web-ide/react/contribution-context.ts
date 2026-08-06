import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  IDEActivityContribution,
  IDECommandContribution,
  IDEPanelContribution,
  IDEWorkspaceResourceContribution,
} from '../contracts/contributions'
import type { RuntimeProvider } from '../contracts/runtime'
import type { TestProvider } from '../contracts/testing'
import type { LanguageToolingProvider } from '../contracts/language-tooling'
import type { ContributionRegistry } from '../core/contribution-registry'

export interface IDEContributionServices {
  activities: ContributionRegistry<IDEActivityContribution>
  commands: ContributionRegistry<IDECommandContribution>
  panels: ContributionRegistry<IDEPanelContribution>
  resources: ContributionRegistry<IDEWorkspaceResourceContribution>
  runtimeProviders: ContributionRegistry<RuntimeProvider>
  testProviders: ContributionRegistry<TestProvider>
  languageToolingProviders: ContributionRegistry<LanguageToolingProvider>
}

export const IDEContributionContext = createContext<IDEContributionServices | null>(null)

export function useIDEContributions(): IDEContributionServices {
  const services = useContext(IDEContributionContext)
  if (!services) throw new Error('Web IDE contribution APIs require <WebIDE>')
  return services
}

function useRegistry<T extends { id: string; order?: number }>(
  registry: ContributionRegistry<T>,
): readonly T[] {
  return useSyncExternalStore(
    (listener) => {
      const subscription = registry.subscribe(listener)
      return () => subscription.dispose()
    },
    registry.getSnapshot,
    registry.getSnapshot,
  )
}

export function useIDECommands(): readonly IDECommandContribution[] {
  return useRegistry(useIDEContributions().commands)
}

export function useIDEActivities(): readonly IDEActivityContribution[] {
  return useRegistry(useIDEContributions().activities)
}

export function useIDEPanels(): readonly IDEPanelContribution[] {
  return useRegistry(useIDEContributions().panels)
}

export function useIDEWorkspaceResources(): readonly IDEWorkspaceResourceContribution[] {
  return useRegistry(useIDEContributions().resources)
}

export function useIDETestProviders(): readonly TestProvider[] {
  return useRegistry(useIDEContributions().testProviders)
}

export function useIDELanguageToolingProviders(): readonly LanguageToolingProvider[] {
  return useRegistry(useIDEContributions().languageToolingProviders)
}

import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import type {
  RuntimeExecutionMode,
  RuntimeExecutionPlan,
  RuntimeSession,
} from '@/web-ide/contracts/runtime'
import type {
  TestProviderContribution,
  TestProviderV2,
} from '@/web-ide/contracts/testing'

export function isTestProviderV2(
  provider: TestProviderContribution,
): provider is TestProviderV2 {
  return 'apiVersion' in provider && provider.apiVersion === 2
}

export function resolveTestProvider(
  providers: readonly TestProviderContribution[],
  runtime: Pick<RuntimeSession, 'languageIds'>,
  requestedId?: string,
): TestProviderContribution | undefined {
  const supportsRuntime = (provider: TestProviderContribution) =>
    provider.languageIds.some((languageId) => runtime.languageIds.includes(languageId))

  if (requestedId) {
    const selected = providers.find(({ id }) => id === requestedId)
    if (!selected) {
      throw new Error(`No test provider contributed with id "${requestedId}"`)
    }
    if (!supportsRuntime(selected)) {
      throw new Error(
        `Test provider "${requestedId}" does not support the selected runtime languages`,
      )
    }
    return selected
  }

  const matches = providers.filter(supportsRuntime)
  return matches.length === 1 ? matches[0] : undefined
}

export interface PrepareWorkbenchExecutionRequest {
  files: WorkspaceFiles
  mode: RuntimeExecutionMode
  executeTests: boolean
  testProvider?: TestProviderContribution
}
export async function prepareWorkbenchExecution({ files, mode, executeTests, testProvider }: PrepareWorkbenchExecutionRequest): Promise<RuntimeExecutionPlan> {
  if (executeTests) throw new Error('Tests require the Testing V2 controller')
  return testProvider?.prepareExecution?.({ files, mode }) ?? { files, mode }
}

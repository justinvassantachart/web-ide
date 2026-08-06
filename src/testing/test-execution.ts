import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import type {
  RuntimeExecutionMode,
  RuntimeExecutionPlan,
  RuntimeSession,
  RuntimeStreamInterceptor,
} from '@/web-ide/contracts/runtime'
import type {
  TestEvent,
  TestOutputParser,
  TestProvider,
} from '@/web-ide/contracts/testing'

export function resolveTestProvider(
  providers: readonly TestProvider[],
  runtime: Pick<RuntimeSession, 'languageIds'>,
  requestedId?: string,
): TestProvider | undefined {
  const supportsRuntime = (provider: TestProvider) =>
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

export function createTestStreamInterceptor(
  parser: TestOutputParser,
  onEvent: (event: TestEvent) => void,
): RuntimeStreamInterceptor {
  const dispatch = (events: readonly TestEvent[]) => {
    for (const event of events) onEvent(event)
  }

  return {
    push(stream, chunk) {
      const frame = parser.push(stream, chunk)
      dispatch(frame.events)
      return frame.output
    },
    finish() {
      const frame = parser.finish()
      dispatch(frame.events)
      return frame.output
    },
  }
}

export interface PrepareWorkbenchExecutionRequest {
  files: WorkspaceFiles
  mode: RuntimeExecutionMode
  executeTests: boolean
  testProvider?: TestProvider
  onTestEvent(event: TestEvent): void
}

export async function prepareWorkbenchExecution({
  files,
  mode,
  executeTests,
  testProvider,
  onTestEvent,
}: PrepareWorkbenchExecutionRequest): Promise<RuntimeExecutionPlan> {
  if (!testProvider) {
    if (executeTests) {
      throw new Error('No unambiguous test provider is available for this runtime')
    }
    return { files, mode }
  }

  const prepared = await testProvider.prepare({
    files,
    mode,
    executeTests,
  })

  if (!executeTests) return prepared.execution
  if (!prepared.parser) {
    throw new Error(`Test provider "${testProvider.id}" did not create an output parser`)
  }

  return {
    ...prepared.execution,
    mode: 'run',
    streamInterceptor: createTestStreamInterceptor(prepared.parser, onTestEvent),
  }
}

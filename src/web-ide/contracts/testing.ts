import type { WorkspaceFiles } from './host'
import type { RuntimeExecutionMode, RuntimeExecutionPlan } from './runtime'

export type TestCaseStatus = 'running' | 'pass' | 'fail' | 'skip' | 'error'

export interface TestLocation {
  file: string
  line?: number
  column?: number
}

export interface TestValue {
  expression?: string
  value: string
}

export interface TestAssertion {
  status: 'pass' | 'fail'
  location?: TestLocation
  actual?: TestValue
  expected?: TestValue
  message?: string
}

export interface TestDiagnostic {
  message: string
  location?: TestLocation
  details?: string
}

/**
 * Framework-neutral events consumed by the optional testing workbench UI.
 * Providers translate their own wire protocol into this closed vocabulary.
 */
export type TestEvent =
  | { type: 'run-start'; total?: number }
  | { type: 'test-start'; testId: string; name: string; location?: TestLocation }
  | { type: 'test-assertion'; testId: string; assertion: TestAssertion }
  | { type: 'test-diagnostic'; testId: string; diagnostic: TestDiagnostic }
  | {
      type: 'test-end'
      testId: string
      status: Exclude<TestCaseStatus, 'running'>
      durationMs?: number
    }
  | { type: 'run-end' }

export type TestOutputStream = 'stdout' | 'stderr'

export interface TestOutputFrame {
  /** Non-protocol output that should remain visible to terminal/host consumers. */
  output: string
  events: readonly TestEvent[]
}

/** A new parser is created for every execution; parser state is never shared. */
export interface TestOutputParser {
  push(stream: TestOutputStream, chunk: string): TestOutputFrame
  finish(): TestOutputFrame
}

export interface TestProviderHelpExample {
  prefix?: string
  code: string
}

export interface TestProviderHelp {
  message: string
  examples?: readonly TestProviderHelpExample[]
}

export interface TestProviderPrepareRequest {
  files: WorkspaceFiles
  mode: RuntimeExecutionMode
  /** False for ordinary Run/Debug, true only for the Tests workflow. */
  executeTests: boolean
}

export interface PreparedTestExecution {
  execution: RuntimeExecutionPlan
  /** Required when executeTests is true; absent for an ordinary execution. */
  parser?: TestOutputParser
}

/**
 * Language/framework-specific test preparation. Implementations own all
 * ephemeral support files, source transforms, entrypoint selection, and wire
 * protocol parsing. Runtime sessions only receive the returned execution plan.
 */
export interface TestProvider {
  id: string
  label: string
  languageIds: readonly string[]
  help?: TestProviderHelp
  /**
   * Ephemeral framework declarations language tooling may index for editor
   * completion/diagnostics. These files never enter the workspace or cache.
   */
  editorSupportFiles?: WorkspaceFiles
  order?: number
  prepare(
    request: TestProviderPrepareRequest,
  ): PreparedTestExecution | Promise<PreparedTestExecution>
}

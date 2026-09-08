import type { WorkspaceFiles } from './host'
import type { RuntimeExecutionMode, RuntimeExecutionPlan } from './runtime'
import type { CppCompileProfileV1 } from './cpp'

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

export interface TestDescriptorV2 {
  readonly id: string
  readonly name: string
  readonly group?: string
  readonly origin: 'student' | 'provided' | 'external'
  readonly location?: { readonly path: string; readonly line: number; readonly column?: number }
}

export interface TestCatalogV2 {
  readonly apiVersion: 2
  readonly kind: 'catalog'
  readonly workspaceDigest: string
  readonly catalogDigest: string
  readonly tests: readonly TestDescriptorV2[]
}

export type TestSelectionV2 =
  | { readonly kind: 'all' }
  | { readonly kind: 'tests'; readonly testIds: readonly string[] }

export interface TestRunRequestV2 {
  readonly mode: 'run' | 'debug'
  readonly selection: TestSelectionV2
}

export type TestReportEventPayloadV2 =
  | { readonly type: 'run_started'; readonly message?: string }
  | { readonly type: 'test_started'; readonly testId: string; readonly message?: string; readonly path?: string; readonly line?: number; readonly column?: number }
  | { readonly type: 'test_passed' | 'test_failed' | 'test_skipped' | 'test_errored'; readonly testId: string; readonly durationMs?: number; readonly message?: string; readonly path?: string; readonly line?: number; readonly column?: number }
  | { readonly type: 'output'; readonly message?: string; readonly testId?: string }
  | { readonly type: 'run_finished'; readonly reason?: 'completed'; readonly durationMs?: number; readonly message?: string }
  | { readonly type: 'run_terminated'; readonly reason: 'stopped' | 'timeout' | 'output_limit' | 'memory_limit' | 'protocol_violation' | 'runtime_crash' | 'build_failed' | 'selection_stale'; readonly message?: string }

export interface TestReportEventV2 {
  readonly apiVersion: 2
  readonly kind: 'report_event'
  readonly runId: string
  readonly sequence: number
  readonly event: TestReportEventPayloadV2
}

export interface TestDecoderFrameV2<T> {
  readonly output: string
  readonly messages: readonly T[]
}

export interface TestCatalogDecoderV2 {
  push(stream: TestOutputStream, chunk: string): TestDecoderFrameV2<TestCatalogV2>
  finish(): TestDecoderFrameV2<TestCatalogV2>
}

export interface TestReportDecoderV2 {
  push(stream: TestOutputStream, chunk: string): TestDecoderFrameV2<TestReportEventV2>
  finish(): TestDecoderFrameV2<TestReportEventV2>
}

export interface TestProviderV2 {
  readonly apiVersion: 2
  readonly id: string
  readonly label: string
  readonly languageIds: readonly string[]
  readonly editorSupportFiles?: WorkspaceFiles
  readonly order?: number
  prepareDiscovery(request: {
    readonly files: WorkspaceFiles
    readonly workspaceDigest: string
    readonly profile?: CppCompileProfileV1
  }): Promise<{ readonly execution: RuntimeExecutionPlan; readonly decoder: TestCatalogDecoderV2 }>
  prepareRun(request: {
    readonly files: WorkspaceFiles
    readonly workspaceDigest: string
    readonly catalogDigest: string
    readonly mode: 'run' | 'debug'
    readonly selection: TestSelectionV2
  }): Promise<{ readonly execution: RuntimeExecutionPlan; readonly decoder: TestReportDecoderV2 }>
}

export type TestProviderContribution = TestProvider | TestProviderV2

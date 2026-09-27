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

export type TestOutputStream = 'stdout' | 'stderr'

export interface TestProviderHelpExample {
  prefix?: string
  code: string
}

export interface TestProviderHelp {
  message: string
  examples?: readonly TestProviderHelpExample[]
}

export interface TestDescriptorV2 {
  readonly id: string
  readonly name: string
  readonly group?: string
  readonly origin: 'student' | 'provided' | 'external'
  /** Infrastructure failures, such as unittest class/module fixtures. */
  readonly kind?: 'fixture'
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

/** Mount-local UI intent. The controller binds it to one discovered catalog. */
export interface TestRunIntentV2 {
  readonly mode: 'run' | 'debug'
  readonly selection: TestSelectionV2
}

/** Exact frozen Testing V2 run-request envelope passed to providers. */
export interface TestRunRequestV2 {
  readonly apiVersion: 2
  readonly kind: 'run_request'
  readonly mode: 'run' | 'debug'
  readonly workspaceDigest: string
  readonly catalogDigest: string
  readonly selection: TestSelectionV2
}

export type TestReportEventPayloadV2 =
  | { readonly type: 'run_started'; readonly message?: string }
  | { readonly type: 'test_discovered'; readonly descriptor: TestDescriptorV2 }
  | { readonly type: 'discovery_finished' }
  | { readonly type: 'test_started'; readonly testId: string; readonly message?: string; readonly path?: string; readonly line?: number; readonly column?: number }
  | { readonly type: 'test_passed' | 'test_failed' | 'test_skipped' | 'test_errored'; readonly testId: string; readonly durationMs?: number; readonly message?: string; readonly path?: string; readonly line?: number; readonly column?: number; readonly actual?: TestValue; readonly expected?: TestValue; readonly details?: string }
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

export interface TestReportDecoderV2 {
  push(stream: TestOutputStream, chunk: string): TestDecoderFrameV2<TestReportEventV2>
  finish(): TestDecoderFrameV2<TestReportEventV2>
}

export interface TestProviderV2 {
  readonly help?: TestProviderHelp
  readonly apiVersion: 2
  readonly id: string
  readonly label: string
  readonly languageIds: readonly string[]
  readonly editorSupportFiles?: WorkspaceFiles
  readonly order?: number
  /** Static, side-effect-free discovery. Never compiles or executes workspace code. */
  discover(request: {
    readonly files: WorkspaceFiles
    readonly workspaceDigest: string
    readonly profile?: CppCompileProfileV1
  }): Promise<TestCatalogV2>
  /** Optional ephemeral framework support for ordinary Run/Debug. */
  prepareExecution?(request: { files: WorkspaceFiles; mode: RuntimeExecutionMode }): RuntimeExecutionPlan | Promise<RuntimeExecutionPlan>
  prepareRun(request: TestRunRequestV2, context: {
    readonly files: WorkspaceFiles
    readonly resources?: WorkspaceFiles
    readonly runId: string
  }): Promise<{ readonly execution: RuntimeExecutionPlan; readonly decoder: TestReportDecoderV2 }>
}

export type TestProviderContribution = TestProviderV2

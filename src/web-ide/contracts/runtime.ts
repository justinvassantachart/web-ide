import type { EventSource } from './events'
import type { WorkspaceFiles } from './host'
import type { Disposable } from '../core/disposable'
import type { CppBuildPlanV1 } from './cpp'

export interface RuntimePreparationResult {
  success: boolean
  errors: string[]
}

export interface VariableNode {
  name: string
  type: string
  value: string | number
  /** Numeric representation supplied by native runtimes, when meaningful. */
  rawValue?: number
  /** Address in the runtime's native address space, when available. */
  address?: number
  /** Native storage size in bytes, when available. */
  size?: number
  /** Whether this value represents a native pointer. */
  isPointer?: boolean
  pointsTo?: number
  pointeeType?: string
  isStruct?: boolean
  members?: VariableNode[]
}

export interface HeapAllocation {
  ptr: number
  size: number
  typeName: string
  label: string
  members: VariableNode[]
}

export interface StackFrame {
  id: string
  funcName: string
  /** Workspace source path for this frame, when reported by the runtime. */
  file?: string
  line: number
  /** Native stack pointer, when reported by the runtime. */
  sp?: number
  variables: VariableNode[]
  isActive: boolean
}

export interface MemorySnapshot {
  frames: StackFrame[]
  heapAllocations: HeapAllocation[]
}

export interface DebugPauseState {
  line: number | null
  func: string | null
  file: string | null
  callStack: StackFrame[]
  memorySnapshot: MemorySnapshot | null
  nextKnownTypes?: Record<number, string>
}

export type DrawCommand =
  | { type: 'CLEAR' }
  | { type: 'CIRCLE'; x: number; y: number; r: number; color: string }
  | { type: 'RECT'; x: number; y: number; w: number; h: number; color: string }

export type RuntimeExecutionMode = 'run' | 'debug'

/**
 * Optional execution-scoped stream transform. Workbench workflows can remove
 * framed control messages while leaving runtime sessions protocol-agnostic.
 */
export interface RuntimeStreamInterceptor {
  push(stream: 'stdout' | 'stderr', chunk: string): string
  /** Flushes buffered stdout immediately before the exit event is published. */
  finish(): string
}

export interface RuntimeExecutionPlan {
  /**
   * Execution-scoped text files. Legacy relative spellings are accepted by the
   * built-in runtime, then canonicalized under `/workspace`; explicit
   * `/sysroot` files retain that scope. Canonical paths are NFC, traversal-free,
   * and at most 1,024 Unicode code points including the scope prefix.
   */
  files: WorkspaceFiles
  mode: RuntimeExecutionMode
  /**
   * Workspace path to execute when the runtime needs an explicit entrypoint.
   * Providers with a fixed engine entrypoint may reject a collision during
   * `prepare`; a TestProvider can stage colliding user files under ephemeral
   * paths in its execution plan.
   */
  entrypoint?: string
  streamInterceptor?: RuntimeStreamInterceptor
  /** Ephemeral staged source path → original editor source path. */
  sourceAliases?: Readonly<Record<string, string>>
  /** Optional validated structured build; omission preserves legacy compilation. */
  cppBuildPlan?: CppBuildPlanV1
  /** Binary inputs stay separate from editor/persistence text files. */
  binaryFiles?: Readonly<Record<string, Uint8Array>>
  /** Optional precompiled C++ inputs; paths use the same scopes as files. */
  cppArtifacts?: {
    readonly sources?: readonly string[]
    readonly archives?: readonly string[]
    readonly precompiledHeader?: string
  }
}

export interface RuntimeHostRequestV1 {
  readonly requestId: number
  readonly opcode: number
  readonly payload: Uint8Array
}

export interface RuntimeHostChannelV1 {
  readonly runId: number
  readonly capability: string
  readonly version: number
  readonly signal: AbortSignal
  onRequest(listener: (request: RuntimeHostRequestV1) => void | Promise<void>): Disposable
  respond(requestId: number, opcode: number, payload?: Uint8Array): Promise<void>
  fail(requestId: number, code: number, message: string): Promise<void>
  sendEvent(opcode: number, payload?: Uint8Array): Promise<void>
  close(code?: number, reason?: string): void
}

export interface RuntimeHostChannelLimitsV1 {
  readonly maxFrameBytes: number
  readonly maxPendingSends: number
  readonly maxInFlightRequests: number
}

export interface RuntimeHostServiceV1 {
  readonly capability: string
  readonly version: number
  readonly limits?: Partial<RuntimeHostChannelLimitsV1>
  open(channel: RuntimeHostChannelV1): Disposable
}

export interface RuntimeStartRequest {
  mode: RuntimeExecutionMode
}

/**
 * Breakpoints contributed for one transient runtime workflow. Keys are
 * workspace source paths and values are one-based source lines. Built-in
 * sessions apply the same canonical 1,024-code-point workspace-path bound.
 */
export type RuntimeBreakpointMap = Readonly<Record<string, readonly number[]>>

/** The terminal result of one runtime start request. */
export type RuntimeOutcome =
  | { type: 'completed'; exitCode: number }
  | { type: 'stopped' }
  | { type: 'error'; error: { type: string; message: string } }

export interface RuntimeCapabilities {
  debug: boolean
  breakpoints: boolean
  stdin: boolean
  graphics: boolean
  /**
   * The runtime publishes address-aware stack/heap snapshots that can drive
   * Web IDE's native-memory Graph panel. Existing providers that omit this
   * retain the legacy Graph behavior; debuggers without meaningful addresses
   * should explicitly set it false.
   */
  memoryVisualization?: boolean
  /** Optional generic duplex guest/host services. */
  hostChannels?: boolean
}

export interface RuntimeDiagnostic {
  message: string
  severity: 'error' | 'warning'
  phase: 'preparation' | 'execution'
  mode: RuntimeExecutionMode
}

export interface RuntimeEventChannels {
  stdout: EventSource<string>
  stderr: EventSource<string>
  terminalClear: EventSource<void>
  graphicsDraw: EventSource<DrawCommand[]>
  debugPaused: EventSource<DebugPauseState>
  debugResumed: EventSource<void>
  exit: EventSource<number>
  diagnostic: EventSource<RuntimeDiagnostic>
  breakpointsValidated: EventSource<{ file: string; lines: number[] }>
}

/** A per-run byte device. Framing and interpretation belong to the host adapter. */
export interface RuntimeHostDevice {
  readonly signal: AbortSignal
  onData(listener: (chunk: Uint8Array) => void): () => void
  /** Await each write before writing again. The engine copies the bytes. */
  write(chunk: Uint8Array): Promise<void>
}

/** The engine calls the returned cleanup once when this run closes. */
export type RuntimeHostDeviceOpener = (device: RuntimeHostDevice) => void | (() => void)

/** A long-lived runtime instance owned by exactly one Web IDE mount. */
export interface RuntimeSession {
  readonly id: string
  readonly languageIds: readonly string[]
  readonly capabilities: Readonly<RuntimeCapabilities>
  readonly events: RuntimeEventChannels

  prepare(plan: RuntimeExecutionPlan): Promise<RuntimePreparationResult>
  start(request: RuntimeStartRequest): Promise<void>
  stop(): void
  /** Waits for the latest start request without changing its state. */
  waitForSettlement?(): Promise<RuntimeOutcome>
  /** Requests a stop and resolves after that start request has fully settled. */
  stopAndWait?(): Promise<RuntimeOutcome>

  setBreakpoints(file: string, lines: number[]): Promise<void>
  /**
   * Atomically replaces one owner's transient breakpoint contribution.
   * Owners are compared by object identity and are scoped to this session.
   */
  replaceBreakpointOverlay?(
    owner: object,
    breakpoints: RuntimeBreakpointMap,
  ): Promise<void>
  /** Removes only the matching owner's transient breakpoint contribution. */
  clearBreakpointOverlay?(owner: object): Promise<void>
  stepInto(): Promise<void>
  stepOver(): Promise<void>
  stepOut(): Promise<void>
  continueExecution(): Promise<void>
  writeStdin?(data: string): void
  /** Registers one instance-scoped service; absent means unsupported. */
  registerHostService?(service: RuntimeHostServiceV1): Disposable
  /**
   * Registers one instance-scoped byte-device opener while idle. Built-in C/C++ only;
   * an engine lacking the device fails explicitly when it is loaded. Disposal removes
   * future registration; an active run retains its captured opener until run cleanup.
   */
  registerHostDevice?(opener: RuntimeHostDeviceOpener): Disposable
  dispose?(): void
  /** Disposes the session and resolves after any initialization/run cleanup. */
  disposeAndWait?(): Promise<RuntimeOutcome>
}

/** Declarative runtime contribution; sessions are lazy and instance-scoped. */
export interface RuntimeProvider {
  id: string
  label: string
  languageIds: readonly string[]
  capabilities: Readonly<RuntimeCapabilities>
  createSession(): RuntimeSession
  order?: number
}

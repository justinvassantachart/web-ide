import type { IDEExecutionController } from '@/web-ide/contracts/contributions'
import type { CppCompileProfileV1 } from '@/web-ide/contracts/cpp'
import type { IDEWorkspaceFeed } from '@/web-ide/contracts/workspace'
import type {
  TestCatalogV2,
  TestDescriptorV2,
  TestProviderV2,
  TestReportEventV2,
  TestReportEventPayloadV2,
  TestRunIntentV2,
  TestRunRequestV2,
  TestSelectionV2,
} from '@/web-ide/contracts/testing'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import { assertNoFlattenedRuntimePathCollisions, normalizeRuntimeFiles } from '@/web-ide/core/workspace-path'
import type { RuntimeStreamInterceptor } from '@/web-ide/contracts/runtime'
import {
  canonicalStringifyV1,
  normalizeWorkspacePathV1,
  workspaceDigestV1,
  sha256Hex,
} from '@/web-ide/public/canonical-contract'

const SHA256 = /^[a-f0-9]{64}$/
const TEST_ID = /^[A-Za-z0-9._:/@+-]{1,512}$/
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/
const REPORT_EVENT_TYPES = new Set([
  'run_started',
  'test_discovered',
  'discovery_finished',
  'test_started',
  'test_passed',
  'test_failed',
  'test_skipped',
  'test_errored',
  'output',
  'run_finished',
  'run_terminated',
])
const TERMINATION_REASONS = new Set([
  'completed',
  'stopped',
  'timeout',
  'output_limit',
  'memory_limit',
  'protocol_violation',
  'runtime_crash',
  'build_failed',
  'selection_stale',
])

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new TypeError(`${label} contains unsupported property ${JSON.stringify(unexpected)}`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new TypeError(`${label} is missing property ${JSON.stringify(missing)}`)
}

function exceedsCodePointLimit(value: string, limit: number): boolean {
  return [...value].length > limit
}

export type TestingV2State = 'idle' | 'discovering' | 'ready' | 'running' | 'error' | 'disposed'

export interface IDETestingSnapshotV2 {
  readonly state: TestingV2State
  readonly workspaceDigest?: string
  readonly catalogDigest?: string
  readonly tests: readonly TestDescriptorV2[]
  readonly liveTests?: readonly TestDescriptorV2[]
  readonly events: readonly TestReportEventV2[]
  readonly error?: string
  readonly stale?: boolean
  readonly runId?: string
  /** Original frozen source used for accurate stale-result and debugger navigation. */
  readonly sourceFiles?: Readonly<WorkspaceFiles>
}

export interface IDETestingControllerV2 {
  snapshot(): IDETestingSnapshotV2
  subscribe(listener: () => void): () => void
  discover(): Promise<void>
  run(intent: TestRunIntentV2): Promise<void>
  stop(): void | Promise<void>
  restart(): Promise<void>
  clearResults(): Promise<void>
  dispose(): void | Promise<void>
}

export interface CreateTestingControllerV2Options {
  readonly provider: TestProviderV2
  readonly workspace: IDEWorkspaceFeed
  readonly execution: IDEExecutionController
  readonly profile?: CppCompileProfileV1
  readonly timeoutMs?: number
  /** Resolves execution-only callbacks exactly once for each operation. */
  readonly resolveResources?: () => WorkspaceFiles | undefined
  /** Static resources only; discovery must never invoke per-run callbacks. */
  readonly resolveDiscoveryResources?: () => WorkspaceFiles | undefined
}

function freezeSnapshot(snapshot: IDETestingSnapshotV2): IDETestingSnapshotV2 {
  return Object.freeze({
    ...snapshot,
    tests: Object.freeze([...snapshot.tests]),
    ...(snapshot.liveTests ? { liveTests: Object.freeze([...snapshot.liveTests]) } : {}),
    events: Object.freeze([...snapshot.events]),
  })
}

function validateDescriptor(value: TestDescriptorV2): TestDescriptorV2 {
  assertObject(value, 'Testing V2 descriptor')
  assertKeys(value, ['id', 'name', 'origin'], ['group', 'location', 'kind'], 'Testing V2 descriptor')
  if (
    typeof value.id !== 'string'
    || !TEST_ID.test(value.id)
    || typeof value.name !== 'string'
    || value.name.length < 1
    || exceedsCodePointLimit(value.name, 1024)
  ) {
    throw new TypeError('Testing V2 descriptor is invalid')
  }
  if (!['student', 'provided', 'external'].includes(value.origin)) throw new TypeError('Testing V2 descriptor origin is invalid')
  if (value.kind !== undefined && value.kind !== 'fixture') throw new TypeError('Testing V2 descriptor kind is invalid')
  if (value.group !== undefined && (typeof value.group !== 'string' || exceedsCodePointLimit(value.group, 512))) {
    throw new TypeError('Testing V2 descriptor group is invalid')
  }
  if (value.location) {
    assertObject(value.location, 'Testing V2 descriptor location')
    assertKeys(value.location, ['path', 'line'], ['column'], 'Testing V2 descriptor location')
    if (
      typeof value.location.path !== 'string'
      || normalizeWorkspacePathV1(value.location.path) !== value.location.path
      || !Number.isSafeInteger(value.location.line)
      || value.location.line < 1
    ) {
      throw new TypeError('Testing V2 descriptor location is invalid')
    }
    if (value.location.column !== undefined && (!Number.isSafeInteger(value.location.column) || value.location.column < 1)) {
      throw new TypeError('Testing V2 descriptor column is invalid')
    }
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    ...(value.group === undefined ? {} : { group: value.group }),
    origin: value.origin,
    ...(value.kind === 'fixture' ? { kind: 'fixture' as const } : {}),
    ...(value.location === undefined ? {} : { location: Object.freeze({ ...value.location }) }),
  })
}

function validateCatalog(catalog: TestCatalogV2, expectedWorkspaceDigest: string): TestCatalogV2 {
  canonicalStringifyV1(catalog)
  assertObject(catalog, 'Testing V2 catalog')
  assertKeys(
    catalog,
    ['apiVersion', 'kind', 'workspaceDigest', 'catalogDigest', 'tests'],
    [],
    'Testing V2 catalog',
  )
  if (catalog.apiVersion !== 2 || catalog.kind !== 'catalog') throw new TypeError('Testing V2 catalog envelope is invalid')
  if (catalog.workspaceDigest !== expectedWorkspaceDigest) throw new TestingSelectionStaleError('catalog workspace digest is stale')
  if (
    typeof catalog.workspaceDigest !== 'string'
    || !SHA256.test(catalog.workspaceDigest)
    || typeof catalog.catalogDigest !== 'string'
    || !SHA256.test(catalog.catalogDigest)
    || !Array.isArray(catalog.tests)
    || catalog.tests.length > 10_000
  ) {
    throw new TypeError('Testing V2 catalog digest or test list is invalid')
  }
  const tests = catalog.tests.map(validateDescriptor)
  if (new Set(tests.map(({ id }) => id)).size !== tests.length) throw new TypeError('Testing V2 catalog contains duplicate test ids')
  return Object.freeze({ ...catalog, tests: Object.freeze(tests) })
}

function validateReportEvent(value: TestReportEventV2): TestReportEventV2 {
  canonicalStringifyV1(value)
  assertObject(value, 'Testing V2 report')
  assertKeys(value, ['apiVersion', 'kind', 'runId', 'sequence', 'event'], [], 'Testing V2 report')
  if (
    value.apiVersion !== 2
    || value.kind !== 'report_event'
    || typeof value.runId !== 'string'
    || !RUN_ID.test(value.runId)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || value.sequence > 0xffff_ffff
  ) throw new TypeError('Testing V2 report envelope is invalid')
  const event = value.event
  assertObject(event, 'Testing V2 report event')
  assertKeys(
    event,
    ['type'],
    ['testId', 'durationMs', 'message', 'path', 'line', 'column', 'reason', 'descriptor', 'actual', 'expected', 'details'],
    'Testing V2 report event',
  )
  if (typeof event.type !== 'string' || !REPORT_EVENT_TYPES.has(event.type)) {
    throw new TypeError('Testing V2 report event type is invalid')
  }
  const optionalByType: Record<string, readonly string[]> = {
    run_started: ['message'], test_discovered: ['descriptor'], discovery_finished: [],
    test_started: ['testId', 'message', 'path', 'line', 'column'],
    output: ['message', 'testId'], run_finished: ['reason', 'durationMs', 'message'],
    run_terminated: ['reason', 'message'],
  }
  assertKeys(event, ['type'], optionalByType[event.type] ?? ['testId', 'durationMs', 'message', 'path', 'line', 'column', 'actual', 'expected', 'details'], 'Testing V2 report event')
  if (event.type === 'test_discovered') validateDescriptor(event.descriptor)
  for (const key of ['actual', 'expected'] as const) {
    if (!(key in event)) continue
    const value = (event as unknown as Record<string, unknown>)[key]
    assertObject(value, 'Testing V2 value')
    assertKeys(value, ['value'], ['expression'], 'Testing V2 value')
    if (typeof value.value !== 'string' || value.value.length > 8192 || (value.expression !== undefined && (typeof value.expression !== 'string' || value.expression.length > 8192))) throw new TypeError('Testing V2 value is invalid')
  }
  if ('details' in event && (typeof event.details !== 'string' || event.details.length > 32768)) throw new TypeError('Testing V2 details are invalid')
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) throw new TypeError('Testing V2 report exceeds frame limit')
  const testEvent = ['test_started', 'test_passed', 'test_failed', 'test_skipped', 'test_errored'].includes(event.type)
  const eventTestId = 'testId' in event ? event.testId : undefined
  if (eventTestId !== undefined && (typeof eventTestId !== 'string' || !TEST_ID.test(eventTestId))) {
    throw new TypeError('Testing V2 report test id is invalid')
  }
  if (testEvent && (typeof eventTestId !== 'string' || !TEST_ID.test(eventTestId))) {
    throw new TypeError('Testing V2 per-test event requires a valid test id')
  }
  if (
    'durationMs' in event
    && event.durationMs !== undefined
    && (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs) || event.durationMs < 0)
  ) throw new TypeError('Testing V2 report duration is invalid')
  if (
    'message' in event
    && event.message !== undefined
    && (typeof event.message !== 'string' || exceedsCodePointLimit(event.message, 65_536))
  ) throw new TypeError('Testing V2 report message is invalid')
  if (
    'path' in event
    && event.path !== undefined
    && (typeof event.path !== 'string' || normalizeWorkspacePathV1(event.path) !== event.path)
  ) {
    throw new TypeError('Testing V2 report path is invalid')
  }
  if ('line' in event && event.line !== undefined && (!Number.isSafeInteger(event.line) || event.line < 1)) {
    throw new TypeError('Testing V2 report line is invalid')
  }
  if ('column' in event && event.column !== undefined && (!Number.isSafeInteger(event.column) || event.column < 1)) {
    throw new TypeError('Testing V2 report column is invalid')
  }
  const reason = 'reason' in event ? event.reason : undefined
  if (reason !== undefined && (typeof reason !== 'string' || !TERMINATION_REASONS.has(reason))) {
    throw new TypeError('Testing V2 report reason is invalid')
  }
  if (event.type === 'run_terminated' && (reason === undefined || reason === 'completed')) {
    throw new TypeError('Testing V2 terminated report requires a terminal reason')
  }
  if (event.type === 'run_finished' && reason !== undefined && reason !== 'completed') {
    throw new TypeError('Testing V2 finished report reason is invalid')
  }
  return Object.freeze({ ...value, event: Object.freeze({ ...event,
    ...(event.type === 'test_discovered' ? { descriptor: validateDescriptor(event.descriptor) } : {}),
    ...('actual' in event && event.actual ? { actual: Object.freeze({ ...event.actual }) } : {}),
    ...('expected' in event && event.expected ? { expected: Object.freeze({ ...event.expected }) } : {}),
  }) })
}

export class TestingSelectionStaleError extends Error {
  readonly code = 'selection_stale'

  constructor(message = 'Testing V2 selection is stale') {
    super(message)
    this.name = 'TestingSelectionStaleError'
  }
}

export function createTestingControllerV2(options: CreateTestingControllerV2Options): IDETestingControllerV2 {
  if (options.provider.apiVersion !== 2) throw new TypeError('Testing requires an apiVersion 2 provider')
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new TypeError('Testing timeout must be between 1 and 3600000 milliseconds')
  let current = freezeSnapshot({ state: 'idle', tests: [], events: [] })
  let runtimeInputs: string | undefined
  let resultInputs: string | undefined
  let runtimeTests: readonly TestDescriptorV2[] = []
  let lastIntent: TestRunIntentV2 | undefined
  let lastResources: Readonly<WorkspaceFiles> | undefined
  let disposed = false
  let discoveryGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  type ActiveOperation = { stopReason?: 'stopped' | 'timeout' | 'protocol_violation'; executing: boolean; done?: Promise<void> }
  let active: ActiveOperation | undefined
  const listeners = new Set<() => void>()
  const publish = (next: IDETestingSnapshotV2) => {
    if (disposed) return
    current = freezeSnapshot(next)
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('[web-ide] Testing observer failed', error) }
    }
  }
  const assertLive = () => { if (disposed) throw new Error('Testing controller is disposed') }
  const capture = (execute = false) => {
    const workspace = Object.freeze({ ...options.workspace.snapshot() })
    const resources = Object.freeze({ ...(execute ? options.resolveResources?.() ?? {} : lastResources ?? options.resolveDiscoveryResources?.() ?? {}) })
    if (execute) lastResources = resources
    const files = normalizeRuntimeFiles(workspace)
    for (const [path, content] of Object.entries(normalizeRuntimeFiles(resources))) {
      if (Object.hasOwn(files, path)) throw new TypeError(`Testing resource collides with workspace: ${path}`)
      files[path] = content
    }
    assertNoFlattenedRuntimePathCollisions(files)
    return { workspace, resources, files: Object.freeze(files), inputs: canonicalStringifyV1(files) }
  }
  const discoverSnapshot = async (captured: ReturnType<typeof capture>) => {
    const workspaceDigest = await workspaceDigestV1(captured.workspace)
    const discovered = validateCatalog(await options.provider.discover({ files: captured.files, workspaceDigest, profile: options.profile }), workspaceDigest)
    // Resource bytes participate even if a provider only hashes the editable plane.
    return Object.freeze({ ...discovered, catalogDigest: await sha256Hex(canonicalStringifyV1({ inputs: captured.inputs, catalogDigest: discovered.catalogDigest })) })
  }
  const discover = async () => {
    assertLive()
    const generation = ++discoveryGeneration
    const revision = options.workspace.revision()
    publish({ ...current, state: active ? 'running' : 'discovering', error: undefined })
    try {
      const captured = capture()
      const discovered = await discoverSnapshot(captured)
      if (disposed || generation !== discoveryGeneration || revision !== options.workspace.revision()) return
      const stale = current.stale || (current.events.length > 0 && resultInputs !== undefined && resultInputs !== discovered.catalogDigest)
      if (active) { publish({ ...current, stale, liveTests: discovered.tests }); return }
      // A refresh must not relabel frozen results or reintroduce provisional
      // rows eliminated by authoritative runtime discovery. Live candidates
      // remain separate until the next run replaces the result snapshot.
      publish(current.events.length
        ? { ...current, state: 'ready', stale, liveTests: stale ? discovered.tests : undefined }
        : { ...current, state: 'ready', stale, tests: discovered.tests, workspaceDigest: discovered.workspaceDigest, catalogDigest: discovered.catalogDigest })
    } catch (error) {
      if (!disposed && !active && generation === discoveryGeneration) publish({ ...current, state: 'error', error: String(error instanceof Error ? error.message : error) })
    }
  }
  const scheduleDiscovery = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; if (!disposed) void discover() }, 180)
  }
  const unsubscribeWorkspace = options.workspace.subscribe(() => {
    discoveryGeneration += 1
    publish({ ...current, stale: current.events.length > 0 || !!active })
    scheduleDiscovery()
  })
  const controller: IDETestingControllerV2 = {
    snapshot: () => current,
    subscribe(listener) { assertLive(); listeners.add(listener); return () => listeners.delete(listener) },
    discover,
    async run(intent) {
      assertLive()
      validateRunIntent(intent)
      if (active) throw new Error('A test run is already active')
      lastIntent = { mode: intent.mode, selection: intent.selection.kind === 'all' ? { kind: 'all' } : { kind: 'tests', testIds: [...intent.selection.testIds] } }
      if (timer) clearTimeout(timer)
      discoveryGeneration += 1
      const operation: ActiveOperation = { executing: false }
      active = operation
      const revision = options.workspace.revision()
      const runId = crypto.randomUUID().replaceAll('-', '')
      const events: TestReportEventV2[] = []
      let nextSequence = 0
      let started = false
      let discoveryFinished = false
      let terminal = false
      let activeTest: string | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      let protocolError: string | undefined
      let reportBytes = 0
      let reportTimer: ReturnType<typeof setTimeout> | undefined
      const descriptors = new Map<string, TestDescriptorV2>()
      const completed = new Set<string>()
      const append = (event: TestReportEventPayloadV2) => {
        events.push(Object.freeze({ apiVersion: 2, kind: 'report_event', runId, sequence: nextSequence++, event }))
        reportTimer ??= setTimeout(() => {
          reportTimer = undefined
          if (active === operation && !disposed) publish({ ...current, state: 'running', events })
        }, 16)
      }
      const terminate = (reason: Extract<TestReportEventPayloadV2, { type: 'run_terminated' }>['reason'], message?: string) => {
        if (terminal) return
        if (events.at(-1)?.event.type === 'run_finished' || events.at(-1)?.event.type === 'run_terminated') { events.pop(); nextSequence-- }
        terminal = true
        append({ type: 'run_terminated', reason, ...(message ? { message } : {}) })
      }
      const requestStop = (reason: NonNullable<typeof operation.stopReason>) => {
        operation.stopReason ??= reason
        if (operation.executing) void Promise.resolve(options.execution.stop()).catch(error => { protocolError ??= String(error) })
      }
      publish({ ...current, state: 'running', liveTests: undefined, events, stale: false, runId, error: undefined })
      operation.done = (async () => {
        try {
          const captured = capture(true)
          const selectedCatalog = await discoverSnapshot(captured)
          resultInputs = selectedCatalog.catalogDigest
          publish({ ...current, sourceFiles: captured.files })
          if (operation.stopReason || disposed) { terminate(operation.stopReason ?? 'stopped'); return }
          // Resources may change without a workspace revision. Never reuse a prior
          // runtime-only selection against a different set of inputs.
          const known = runtimeInputs === selectedCatalog.catalogDigest ? [...selectedCatalog.tests, ...runtimeTests] : selectedCatalog.tests
          validateSelection(intent.selection, known)
          publish({ ...current, tests: selectedCatalog.tests, workspaceDigest: selectedCatalog.workspaceDigest, catalogDigest: selectedCatalog.catalogDigest })
          const request: TestRunRequestV2 = Object.freeze({ apiVersion: 2, kind: 'run_request', mode: intent.mode, workspaceDigest: selectedCatalog.workspaceDigest, catalogDigest: selectedCatalog.catalogDigest,
            selection: intent.selection.kind === 'all' ? Object.freeze({ kind: 'all' }) : Object.freeze({ kind: 'tests', testIds: Object.freeze([...intent.selection.testIds]) }) })
          const prepared = await options.provider.prepareRun(request, { files: captured.files, resources: captured.resources, runId })
          if (operation.stopReason || disposed) { terminate(operation.stopReason ?? 'stopped'); return }
          const consume = (message: TestReportEventV2) => {
            if (disposed || protocolError) return
            try {
              const report = validateReportEvent(message)
              reportBytes += new TextEncoder().encode(JSON.stringify(report)).byteLength
              if (reportBytes > 16 * 1024 * 1024) throw new TypeError('Test report exceeds the 16 MiB run limit')
              const event = report.event
              if (report.runId !== runId || report.sequence !== nextSequence || terminal || events.length >= 100_000) throw new TypeError('Invalid test report sequence, run, or lifecycle')
              if (!started && event.type !== 'run_started') throw new TypeError('Test report must start with run_started')
              if (event.type === 'run_started') {
                if (started) throw new TypeError('Duplicate run_started')
                started = true
                if (intent.mode !== 'debug') deadline = setTimeout(() => requestStop('timeout'), timeoutMs)
              } else if (event.type === 'test_discovered') {
                const descriptor = validateDescriptor(event.descriptor)
                if (descriptors.has(descriptor.id) || descriptors.size >= 10_000) throw new TypeError('Duplicate or excessive runtime test descriptors')
                descriptors.set(descriptor.id, descriptor)
                if (discoveryFinished) { runtimeTests = [...descriptors.values()]; publish({ ...current, tests: runtimeTests }) }
              } else if (event.type === 'discovery_finished') {
                if (discoveryFinished) throw new TypeError('Duplicate discovery_finished')
                discoveryFinished = true
                runtimeInputs = selectedCatalog.catalogDigest
                runtimeTests = [...descriptors.values()]
                publish({ ...current, tests: runtimeTests })
              } else if (event.type === 'test_started') {
                if (!discoveryFinished || activeTest || !descriptors.has(event.testId) || completed.has(event.testId)) throw new TypeError('Invalid test start')
                if (intent.selection.kind === 'tests' && !intent.selection.testIds.includes(event.testId) && descriptors.get(event.testId)?.kind !== 'fixture') throw new TypeError('An unselected test was started')
                activeTest = event.testId
              } else if (['test_passed', 'test_failed', 'test_errored', 'test_skipped'].includes(event.type)) {
                if (!('testId' in event) || event.testId !== activeTest) throw new TypeError('Test completion has no matching start')
                completed.add(activeTest!)
                activeTest = undefined
              } else if (event.type === 'run_finished') {
                if (!discoveryFinished || activeTest) throw new TypeError('Run finished with an incomplete test')
                const expected = intent.selection.kind === 'all' ? [...descriptors.keys()] : intent.selection.testIds
                if (expected.some(id => !completed.has(id))) throw new TypeError('Run finished before all selected tests completed')
                terminal = true
              } else if (event.type === 'run_terminated') terminal = true
              append(event)
            } catch (error) {
              protocolError = error instanceof Error ? error.message : String(error)
              requestStop('protocol_violation')
            }
          }
          const interceptor: RuntimeStreamInterceptor = {
            push(stream, chunk) {
              try { const frame = prepared.decoder.push(stream, chunk); frame.messages.forEach(consume); return frame.output }
              catch (error) { protocolError = String(error); requestStop('protocol_violation'); return chunk }
            },
            finish() {
              try { const frame = prepared.decoder.finish(); frame.messages.forEach(consume); return frame.output }
              catch (error) { protocolError = String(error); requestStop('protocol_violation'); return '' }
            },
          }
          if (!options.execution.executePrepared) throw new Error('Workbench does not provide prepared execution')
          operation.executing = true
          const outcome = await options.execution.executePrepared({ plan: { ...prepared.execution, mode: intent.mode, streamInterceptor: interceptor }, workflow: 'test', resourcesResolved: true })
          operation.executing = false
          // A runtime exit cannot substitute for the protocol's terminal event.
          if (protocolError) { terminal = false; terminate('protocol_violation', protocolError) }
          else if (operation.stopReason) { terminal = false; terminate(operation.stopReason) }
          else if (outcome?.type === 'build_failed') terminate('build_failed', outcome.message)
          else if (outcome?.type === 'busy') terminate('runtime_crash', 'Another execution is active. Stop it before running tests.')
          else if (outcome?.type === 'stopped') { terminal = false; terminate('stopped') }
          else if (outcome?.type === 'error') { terminal = false; terminate('runtime_crash', outcome.error.message) }
          else if (!terminal) terminate(started ? 'runtime_crash' : 'build_failed', started ? 'The runtime exited before the test suite finished.' : 'The test runner did not start. Check compiler output.')
          else if (outcome?.type === 'completed' && outcome.exitCode !== 0 && (outcome.exitCode !== 1 || !events.some(({ event }) => event.type === 'test_failed' || event.type === 'test_errored' || event.type === 'run_terminated'))) {
            terminal = false; terminate('runtime_crash', `Runtime exited with status ${outcome.exitCode}`)
          }
        } catch (error) {
          terminate(error instanceof TestingSelectionStaleError ? 'selection_stale' : 'build_failed', error instanceof Error ? error.message : String(error))
        } finally {
          if (deadline) clearTimeout(deadline)
          if (reportTimer) clearTimeout(reportTimer)
          operation.executing = false
          active = undefined
          publish({ ...current, state: 'ready', events, stale: current.stale || revision !== options.workspace.revision(), error: protocolError })
          if (!disposed && revision !== options.workspace.revision()) scheduleDiscovery()
        }
      })()
      await operation.done
    },
    async stop() {
      assertLive()
      const operation = active
      if (!operation) return
      operation.stopReason ??= 'stopped'
      if (operation.executing) await options.execution.stop()
      await operation.done
    },
    async restart() {
      assertLive()
      const intent = lastIntent
      if (!intent) return
      await controller.stop()
      await controller.run(intent)
    },
    async clearResults() {
      assertLive()
      await controller.stop()
      runtimeInputs = undefined; resultInputs = undefined; runtimeTests = []; lastIntent = undefined
      publish({ state: 'idle', tests: [], events: [] })
      await discover()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribeWorkspace()
      if (timer) clearTimeout(timer)
      if (active) { active.stopReason = 'stopped'; if (active.executing) await options.execution.stop() }
      discoveryGeneration += 1
      current = freezeSnapshot({ state: 'disposed', tests: [], events: [] })
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
  return controller
}

function validateSelection(selection: TestSelectionV2, tests: readonly TestDescriptorV2[]): void {
  canonicalStringifyV1(selection)
  assertObject(selection, 'Testing selection')
  if (selection.kind === 'all') { assertKeys(selection, ['kind'], [], 'Testing selection'); return }
  assertKeys(selection, ['kind', 'testIds'], [], 'Testing selection')
  if (selection.kind !== 'tests' || !Array.isArray(selection.testIds) || selection.testIds.length < 1 || selection.testIds.length > 10_000) throw new TypeError('Testing selection is empty or invalid')
  if (new Set(selection.testIds).size !== selection.testIds.length) throw new TypeError('Testing selection contains duplicate ids')
  const available = new Set(tests.map(({ id }) => id))
  if (selection.testIds.some(id => !TEST_ID.test(id) || !available.has(id))) throw new TestingSelectionStaleError()
}
function validateRunIntent(intent: TestRunIntentV2): void {
  canonicalStringifyV1(intent)
  assertObject(intent, 'Testing run intent')
  assertKeys(intent, ['mode', 'selection'], [], 'Testing run intent')
  if (intent.mode !== 'run' && intent.mode !== 'debug') throw new TypeError('Testing run mode is invalid')
}

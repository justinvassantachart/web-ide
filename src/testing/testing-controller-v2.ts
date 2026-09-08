import type { IDEExecutionController } from '@/web-ide/contracts/contributions'
import type { CppCompileProfileV1 } from '@/web-ide/contracts/cpp'
import type { IDEWorkspaceFeed } from '@/web-ide/contracts/workspace'
import type {
  TestCatalogDecoderV2,
  TestCatalogV2,
  TestDescriptorV2,
  TestProviderV2,
  TestReportDecoderV2,
  TestReportEventV2,
  TestRunRequestV2,
  TestSelectionV2,
} from '@/web-ide/contracts/testing'
import type { RuntimeStreamInterceptor } from '@/web-ide/contracts/runtime'
import {
  canonicalStringifyV1,
  normalizeWorkspacePathV1,
  workspaceDigestV1,
} from '@/web-ide/public/canonical-contract'

const SHA256 = /^[a-f0-9]{64}$/
const TEST_ID = /^[A-Za-z0-9._:/@+-]{1,512}$/
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/
const REPORT_EVENT_TYPES = new Set([
  'run_started',
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
  readonly events: readonly TestReportEventV2[]
  readonly error?: string
}

export interface IDETestingControllerV2 {
  snapshot(): IDETestingSnapshotV2
  subscribe(listener: () => void): () => void
  discover(): Promise<void>
  run(request: TestRunRequestV2): Promise<void>
  stop(): void | Promise<void>
  dispose(): void
}

export interface CreateTestingControllerV2Options {
  readonly provider: TestProviderV2
  readonly workspace: IDEWorkspaceFeed
  readonly execution: IDEExecutionController
  readonly profile?: CppCompileProfileV1
}

function freezeSnapshot(snapshot: IDETestingSnapshotV2): IDETestingSnapshotV2 {
  return Object.freeze({
    ...snapshot,
    tests: Object.freeze([...snapshot.tests]),
    events: Object.freeze([...snapshot.events]),
  })
}

function validateDescriptor(value: TestDescriptorV2): TestDescriptorV2 {
  assertObject(value, 'Testing V2 descriptor')
  assertKeys(value, ['id', 'name', 'origin'], ['group', 'location'], 'Testing V2 descriptor')
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
    ['testId', 'durationMs', 'message', 'path', 'line', 'column', 'reason'],
    'Testing V2 report event',
  )
  if (typeof event.type !== 'string' || !REPORT_EVENT_TYPES.has(event.type)) {
    throw new TypeError('Testing V2 report event type is invalid')
  }
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
  return Object.freeze({ ...value, event: Object.freeze({ ...event }) })
}

function createDecoderInterceptor<T>(
  decoder: {
    push: TestCatalogDecoderV2['push'] | TestReportDecoderV2['push']
    finish: TestCatalogDecoderV2['finish'] | TestReportDecoderV2['finish']
  },
  consume: (message: T) => void,
): RuntimeStreamInterceptor {
  const consumeFrame = (frame: { output: string; messages: readonly unknown[] }) => {
    for (const message of frame.messages) consume(message as T)
    return frame.output
  }
  return {
    push: (stream, chunk) => consumeFrame(decoder.push(stream, chunk)),
    finish: () => consumeFrame(decoder.finish()),
  }
}

export class TestingSelectionStaleError extends Error {
  readonly code = 'selection_stale'

  constructor(message = 'Testing V2 selection is stale') {
    super(message)
    this.name = 'TestingSelectionStaleError'
  }
}

export function createTestingControllerV2(
  options: CreateTestingControllerV2Options,
): IDETestingControllerV2 {
  if (options.provider.apiVersion !== 2) throw new TypeError('Testing V2 controller requires an apiVersion 2 provider')
  let current = freezeSnapshot({ state: 'idle', tests: [], events: [] })
  let catalog: TestCatalogV2 | undefined
  let disposed = false
  let operationGeneration = 0
  const listeners = new Set<() => void>()

  const publish = (next: IDETestingSnapshotV2) => {
    current = freezeSnapshot(next)
    for (const listener of [...listeners]) listener()
  }
  const assertLive = () => {
    if (disposed) throw new Error('Testing V2 controller is disposed')
  }
  const execute = async (plan: Parameters<NonNullable<IDEExecutionController['executePrepared']>>[0]['plan']) => {
    if (!options.execution.executePrepared) throw new Error('The selected workbench does not provide prepared execution')
    await options.execution.executePrepared({ plan, workflow: 'test' })
  }
  const invalidate = () => {
    operationGeneration += 1
    catalog = undefined
    if (!disposed) publish({ state: 'idle', tests: [], events: [] })
  }
  const unsubscribeWorkspace = options.workspace.subscribe(invalidate)

  const controller: IDETestingControllerV2 = {
    snapshot: () => current,
    subscribe(listener) {
      assertLive()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async discover() {
      assertLive()
      const generation = ++operationGeneration
      publish({ state: 'discovering', tests: [], events: [] })
      try {
        const files = options.workspace.snapshot()
        const workspaceDigest = await workspaceDigestV1(files)
        const prepared = await options.provider.prepareDiscovery({ files, workspaceDigest, profile: options.profile })
        let received: TestCatalogV2 | undefined
        const interceptor = createDecoderInterceptor<TestCatalogV2>(prepared.decoder, (message) => {
          if (received) throw new TypeError('Testing V2 discovery emitted more than one catalog')
          received = validateCatalog(message, workspaceDigest)
        })
        await execute({ ...prepared.execution, streamInterceptor: interceptor })
        if (disposed || generation !== operationGeneration) return
        if (!received) throw new TypeError('Testing V2 discovery did not emit a catalog')
        catalog = received
        publish({
          state: 'ready',
          workspaceDigest: received.workspaceDigest,
          catalogDigest: received.catalogDigest,
          tests: received.tests,
          events: [],
        })
      } catch (error) {
        if (!disposed && generation === operationGeneration) {
          publish({ state: 'error', tests: [], events: [], error: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
    },
    async run(request) {
      assertLive()
      validateRunRequest(request)
      if (!catalog) await controller.discover()
      assertLive()
      const selectedCatalog = catalog
      if (!selectedCatalog) throw new TestingSelectionStaleError()
      const currentDigest = await workspaceDigestV1(options.workspace.snapshot())
      if (currentDigest !== selectedCatalog.workspaceDigest) {
        invalidate()
        await controller.discover()
        throw new TestingSelectionStaleError()
      }
      validateSelection(request.selection, selectedCatalog.tests)
      const generation = ++operationGeneration
      const events: TestReportEventV2[] = []
      publish({ ...current, state: 'running', events })
      try {
        const files = options.workspace.snapshot()
        const prepared = await options.provider.prepareRun({
          files,
          workspaceDigest: selectedCatalog.workspaceDigest,
          catalogDigest: selectedCatalog.catalogDigest,
          mode: request.mode,
          selection: request.selection,
        })
        let runId: string | undefined
        let nextSequence = 0
        const interceptor = createDecoderInterceptor<TestReportEventV2>(prepared.decoder, (message) => {
          const validated = validateReportEvent(message)
          runId ??= validated.runId
          if (validated.runId !== runId || validated.sequence !== nextSequence) {
            throw new TypeError('Testing V2 report run or sequence is invalid')
          }
          nextSequence += 1
          events.push(validated)
          if (!disposed && generation === operationGeneration) publish({ ...current, state: 'running', events })
          if (validated.event.type === 'run_terminated' && validated.event.reason === 'selection_stale') catalog = undefined
        })
        await execute({ ...prepared.execution, mode: request.mode, streamInterceptor: interceptor })
        if (disposed || generation !== operationGeneration) return
        publish({ ...current, state: catalog ? 'ready' : 'idle', events })
      } catch (error) {
        if (!disposed && generation === operationGeneration) {
          publish({ ...current, state: 'error', events, error: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
    },
    stop: () => options.execution.stop(),
    dispose() {
      if (disposed) return
      disposed = true
      operationGeneration += 1
      unsubscribeWorkspace()
      listeners.clear()
      current = freezeSnapshot({ state: 'disposed', tests: [], events: [] })
    },
  }
  return controller
}

function validateSelection(selection: TestSelectionV2, tests: readonly TestDescriptorV2[]): void {
  canonicalStringifyV1(selection)
  assertObject(selection, 'Testing V2 selection')
  if (selection.kind === 'all') {
    assertKeys(selection, ['kind'], [], 'Testing V2 selection')
    return
  }
  assertKeys(selection, ['kind', 'testIds'], [], 'Testing V2 selection')
  if (selection.kind !== 'tests' || !Array.isArray(selection.testIds) || selection.testIds.length < 1 || selection.testIds.length > 10_000) {
    throw new TypeError('Testing V2 selection is invalid')
  }
  if (new Set(selection.testIds).size !== selection.testIds.length) throw new TypeError('Testing V2 selection contains duplicate ids')
  const available = new Set(tests.map(({ id }) => id))
  if (selection.testIds.some((id) => !TEST_ID.test(id) || !available.has(id))) {
    throw new TestingSelectionStaleError()
  }
}

function validateRunRequest(request: TestRunRequestV2): void {
  canonicalStringifyV1(request)
  assertObject(request, 'Testing V2 run request')
  assertKeys(request, ['mode', 'selection'], [], 'Testing V2 run request')
  if (request.mode !== 'run' && request.mode !== 'debug') {
    throw new TypeError('Testing V2 run mode is invalid')
  }
}

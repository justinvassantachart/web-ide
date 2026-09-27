import { describe, expect, it, vi } from 'vitest'
import { createTestingControllerV2 } from '../../src/testing/testing-controller-v2'
import type { IDEExecutionController } from '../../src/web-ide/contracts/contributions'
import type { TestProviderV2, TestReportEventPayloadV2, TestDescriptorV2 } from '../../src/web-ide/contracts/testing'
import type { WorkspaceChangeV1 } from '../../src/web-ide/contracts/workspace'
const tests: TestDescriptorV2[] = [{ id: 'alpha', name: 'Alpha', origin: 'student', location: { path: '/workspace/main.cpp', line: 2 } }, { id: 'beta', name: 'Beta', origin: 'provided' }]
const complete: TestReportEventPayloadV2[] = [{ type: 'run_started' }, ...tests.map(descriptor => ({ type: 'test_discovered' as const, descriptor })), { type: 'discovery_finished' }, ...tests.flatMap(test => [{ type: 'test_started' as const, testId: test.id }, { type: 'test_passed' as const, testId: test.id }]), { type: 'run_finished' }]
function fixture(options: { timeoutMs?: number; resolveResources?: () => Record<string,string> } = {}) {
  let files = { '/workspace/main.cpp': 'original' }, revision = 0
  const subscribers = new Set<(change: WorkspaceChangeV1) => void>()
  const workspace = { snapshot: () => ({ ...files }), revision: () => revision, subscribe: (listener: (change: WorkspaceChangeV1) => void) => { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const edit = () => { files = { '/workspace/main.cpp': 'edited' }; revision++; for (const listener of subscribers) listener({} as WorkspaceChangeV1) }
  let reports = complete, release: (() => void) | undefined, hold = false
  const execution: IDEExecutionController = {
    start: vi.fn(async () => undefined), restart: vi.fn(async () => undefined), stop: vi.fn(async () => { release?.() }),
    executePrepared: vi.fn<NonNullable<IDEExecutionController['executePrepared']>>(async ({ plan }) => { plan.streamInterceptor?.push('stdout', 'frames'); if (hold) await new Promise<void>(resolve => { release = resolve }); plan.streamInterceptor?.finish(); return { type: 'completed', exitCode: 0 } }),
  }
  const provider: TestProviderV2 = {
    apiVersion: 2, id: 'fixture', label: 'Tests', languageIds: ['cpp'],
    discover: vi.fn<TestProviderV2['discover']>(async ({ workspaceDigest }) => ({ apiVersion: 2, kind: 'catalog', workspaceDigest, catalogDigest: 'a'.repeat(64), tests })),
    prepareRun: vi.fn(async (request, context) => {
      let sent = false
      return { execution: { files: context.files, mode: request.mode }, decoder: { push: () => ({ output: '', messages: sent ? [] : (sent = true, reports.map((event, sequence) => ({ apiVersion: 2 as const, kind: 'report_event' as const, runId: context.runId, sequence, event }))) }), finish: () => ({ output: '', messages: [] }) } }
    }),
  }
  const controller = createTestingControllerV2({ provider, workspace, execution, ...options })
  return { controller, provider, execution, edit, setReports: (next: TestReportEventPayloadV2[]) => { reports = next }, hold: () => { hold = true }, release: () => release?.() }
}
const run = { mode: 'run' as const, selection: { kind: 'all' as const } }
describe('Testing V2 controller', () => {
  it('discovers without executing and binds run/debug to immutable snapshots', async () => {
    const f = fixture(); await f.controller.discover()
    expect(f.execution.executePrepared).not.toHaveBeenCalled()
    expect(f.controller.snapshot().tests).toEqual(tests)
    await f.controller.run(run)
    expect(f.controller.snapshot().events.at(-1)?.event.type).toBe('run_finished')
    const context = vi.mocked(f.provider.prepareRun).mock.calls[0][1]
    expect(context.files).toEqual({ '/workspace/main.cpp': 'original' })
    expect(Object.isFrozen(context.files)).toBe(true)
    expect(context.runId).toMatch(/^[a-f0-9]{32}$/)
    expect(f.execution.executePrepared).toHaveBeenCalledWith(expect.objectContaining({ resourcesResolved: true }))
    await f.controller.dispose()
  })
  it('resolves dynamic resources once for each run and preserves the merged snapshot', async () => {
    const resolveResources = vi.fn(() => ({ '/sysroot/library.h': 'one' }))
    const f = fixture({ resolveResources }); f.hold()
    const running = f.controller.run(run)
    await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledOnce())
    expect(resolveResources).toHaveBeenCalledOnce()
    expect(vi.mocked(f.provider.prepareRun).mock.calls[0][1].files['/sysroot/library.h']).toBe('one')
    f.release(); await running; await f.controller.dispose()
  })
  it('keeps frozen runs active through edits and preserves stale completed results', async () => {
    const f = fixture(); f.hold(); const running = f.controller.run(run)
    await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledOnce())
    f.edit(); expect(f.execution.stop).not.toHaveBeenCalled()
    expect(f.controller.snapshot().sourceFiles?.['/workspace/main.cpp']).toBe('original')
    expect(Object.isFrozen(f.controller.snapshot().sourceFiles)).toBe(true)
    expect(f.controller.snapshot()).toMatchObject({ state: 'running', stale: true })
    f.release(); await running
    expect(f.controller.snapshot()).toMatchObject({ state: 'ready', stale: true })
    expect(f.controller.snapshot().events.at(-1)?.event.type).toBe('run_finished')
    await f.controller.discover()
    expect(f.controller.snapshot().events).toHaveLength(complete.length)
    await f.controller.dispose()
  })
  it('ends stop and timeout with explicit terminal outcomes and disables timeout in debug', async () => {
    const f = fixture({ timeoutMs: 20 }); f.hold(); f.setReports(complete.slice(0,5))
    await f.controller.run(run)
    expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason: 'timeout' })
    expect(f.execution.stop).toHaveBeenCalledOnce()
    const debugging = f.controller.run({ ...run, mode: 'debug' })
    await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(f.execution.stop).toHaveBeenCalledOnce()
    await f.controller.stop(); await debugging
    expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason: 'stopped' })
    await f.controller.dispose()
  })
  it.each([
    [complete.slice(0,5), 'runtime_crash'],
    [[{ type: 'run_started' }, { type: 'discovery_finished' }, { type: 'test_passed', testId: 'alpha' }], 'protocol_violation'],
    [[{ type: 'run_started' }, { type: 'test_discovered', descriptor: tests[0] }, { type: 'discovery_finished' }, { type: 'run_finished' }], 'protocol_violation'],
    [[{ type: 'run_started' }, { type: 'run_started' }], 'protocol_violation'],
    [[], 'build_failed'],
  ] as const)('does not turn incomplete or malformed reports into success', async (events, reason) => {
    const f = fixture(); f.setReports([...events] as TestReportEventPayloadV2[]); await f.controller.run(run)
    expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason })
    await f.controller.dispose()
  })
  it('surfaces build rejection/busy and rejects empty or stale selected IDs without running', async () => {
    const f = fixture()
    await f.controller.run({ mode: 'debug', selection: { kind: 'tests', testIds: [] } })
    expect(f.execution.executePrepared).not.toHaveBeenCalled()
    await f.controller.run({ mode: 'run', selection: { kind: 'tests', testIds: ['missing'] } })
    expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ reason: 'selection_stale' })
    vi.mocked(f.execution.executePrepared!).mockResolvedValueOnce({ type: 'build_failed', message: 'Compiler error' })
    await f.controller.run(run)
    expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ reason: 'build_failed', message: 'Compiler error' })
    await f.controller.dispose()
  })
  it('accepts runtime-only descriptors and later selected reruns for the same inputs', async () => {
    const f = fixture(); const runtime = { id: 'runtime-only', name: 'Macro test', origin: 'student' as const }
    f.setReports([{ type: 'run_started' }, { type: 'test_discovered', descriptor: runtime }, { type: 'discovery_finished' }, { type: 'test_started', testId: runtime.id }, { type: 'test_passed', testId: runtime.id }, { type: 'run_finished' }])
    await f.controller.run(run)
    await f.controller.run({ mode: 'run', selection: { kind: 'tests', testIds: [runtime.id] } })
    expect(f.execution.executePrepared).toHaveBeenCalledTimes(2)
    expect(f.controller.snapshot().events.at(-1)?.event.type).toBe('run_finished')
    await f.controller.dispose()
  })
})

it('rejects unselected cases while allowing selected-run fixture failures', async () => {
  const f = fixture()
  const fixtureRow: TestDescriptorV2 = { id: 'setup', name: 'setUpClass', origin: 'student', kind: 'fixture' }
  f.setReports([{ type: 'run_started' }, { type: 'test_discovered', descriptor: tests[0] }, { type: 'discovery_finished' }, { type: 'test_discovered', descriptor: fixtureRow }, { type: 'test_started', testId: 'setup' }, { type: 'test_errored', testId: 'setup' }, { type: 'test_started', testId: 'alpha' }, { type: 'test_skipped', testId: 'alpha' }, { type: 'run_finished' }])
  await f.controller.run({ mode: 'run', selection: { kind: 'tests', testIds: ['alpha'] } })
  expect(f.controller.snapshot().events.at(-1)?.event.type).toBe('run_finished')
  f.setReports(complete)
  await f.controller.run({ mode: 'run', selection: { kind: 'tests', testIds: ['alpha'] } })
  expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason: 'protocol_violation' })
  await f.controller.dispose()
})

it('refreshes live discovery during a frozen run without mutating its result identity', async () => {
  const f = fixture(); f.hold()
  const running = f.controller.run(run)
  await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledOnce())
  const digest = f.controller.snapshot().workspaceDigest
  f.edit(); await f.controller.discover()
  expect(f.controller.snapshot()).toMatchObject({ state: 'running', stale: true, workspaceDigest: digest, liveTests: tests })
  expect(f.execution.stop).not.toHaveBeenCalled()
  f.release(); await running; await f.controller.dispose()
})

it('includes changed resource bytes in catalog validity and marks old results stale', async () => {
  let resource = 'first'
  const f = fixture({ resolveResources: () => ({ '/sysroot/support.h': resource }) })
  await f.controller.run(run)
  const digest = f.controller.snapshot().catalogDigest
  resource = 'second'; await f.controller.discover()
  expect(f.controller.snapshot().catalogDigest).toBe(digest)
  expect(f.controller.snapshot().stale).toBe(false)
  await f.controller.run(run)
  expect(f.controller.snapshot().catalogDigest).not.toBe(digest)
  await f.controller.dispose()
})

it('restarts the selected testing workflow with a fresh report identity', async () => {
  const f = fixture(); f.hold(); f.setReports(complete.slice(0, 5))
  const first = f.controller.run({ mode: 'debug', selection: { kind: 'tests', testIds: ['alpha'] } })
  await vi.waitFor(() => expect(f.provider.prepareRun).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledOnce())
  const restarting = f.controller.restart()
  await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(f.provider.prepareRun).mock.calls
  expect(calls[1][0]).toMatchObject({ mode: 'debug', selection: { kind: 'tests', testIds: ['alpha'] } })
  expect(calls[1][1].runId).not.toBe(calls[0][1].runId)
  await f.controller.stop(); await first; await restarting; await f.controller.dispose()
})


it('keeps authoritative result descriptors frozen across refreshes and live name edits', async () => {
  const f = fixture()
  f.setReports([{ type: 'run_started' }, { type: 'test_discovered', descriptor: tests[0] }, { type: 'discovery_finished' }, { type: 'test_started', testId: 'alpha' }, { type: 'test_passed', testId: 'alpha' }, { type: 'run_finished' }])
  await f.controller.run(run)
  await f.controller.discover()
  expect(f.controller.snapshot().tests).toEqual([tests[0]])
  vi.mocked(f.provider.discover).mockImplementation(async ({ workspaceDigest }) => ({ apiVersion: 2, kind: 'catalog', workspaceDigest, catalogDigest: 'b'.repeat(64), tests: [{ ...tests[0], name: 'New name on the same line' }] }))
  f.edit(); await f.controller.discover()
  expect(f.controller.snapshot().tests).toEqual([tests[0]])
  expect(f.controller.snapshot().liveTests?.[0].name).toBe('New name on the same line')
  await f.controller.dispose()
})


it('bounds accumulated report memory independently of the per-frame cap', async () => {
  const f = fixture()
  const message = 'x'.repeat(60_000)
  f.setReports([{ type: 'run_started' }, ...Array.from({ length: 300 }, () => ({ type: 'output' as const, message }))])
  await f.controller.run(run)
  expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason: 'protocol_violation', message: expect.stringContaining('16 MiB') })
  expect(f.controller.snapshot().events.length).toBeLessThan(300)
  await f.controller.dispose()
})


it('lets a runtime crash after suite completion override the earlier terminal report', async () => {
  const f = fixture()
  vi.mocked(f.execution.executePrepared!).mockImplementation(async ({ plan }) => {
    plan.streamInterceptor!.push('stdout', 'frames')
    return { type: 'error', error: { type: 'RuntimeError', message: 'A global destructor crashed' } }
  })
  await f.controller.run(run)
  expect(f.controller.snapshot().events.at(-1)?.event).toMatchObject({ type: 'run_terminated', reason: 'runtime_crash', message: 'A global destructor crashed' })
  expect(f.controller.snapshot().events.filter(({ event }) => event.type === 'run_finished' || event.type === 'run_terminated')).toHaveLength(1)
  await f.controller.dispose()
})


it('never invokes dynamic resource callbacks for discovery and clears retained results on reset', async () => {
  const resolveResources = vi.fn(() => ({ '/sysroot/generated.h': 'one' }))
  const f = fixture({ resolveResources })
  await f.controller.discover(); await f.controller.discover()
  expect(resolveResources).not.toHaveBeenCalled()
  await f.controller.run(run)
  expect(resolveResources).toHaveBeenCalledOnce()
  await f.controller.discover(); expect(resolveResources).toHaveBeenCalledOnce()
  await f.controller.clearResults(); f.edit(); await f.controller.discover()
  expect(f.controller.snapshot().events).toEqual([])
  expect(f.controller.snapshot().sourceFiles).toBeUndefined()
  expect(resolveResources).toHaveBeenCalledOnce()
  await f.controller.dispose()
})

it('does not schedule discovery after disposal races an edited active run', async () => {
  const f = fixture(); f.hold()
  const running = f.controller.run(run)
  await vi.waitFor(() => expect(f.execution.executePrepared).toHaveBeenCalledOnce())
  f.edit(); await f.controller.dispose(); await running
  const discoveries = vi.mocked(f.provider.discover).mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 210))
  expect(f.controller.snapshot().state).toBe('disposed')
  expect(f.provider.discover).toHaveBeenCalledTimes(discoveries)
})

import { describe, expect, it, vi } from 'vitest'
import type { IDEExecutionController } from '../../src/web-ide/contracts/contributions'
import type {
  TestCatalogV2,
  TestDecoderFrameV2,
  TestProviderV2,
  TestReportEventV2,
} from '../../src/web-ide/contracts/testing'
import { createWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { createTestingControllerV2 } from '../../src/testing/testing-controller-v2'

const DIGEST = 'a'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function oneMessageDecoder<T>(message: () => T) {
  let sent = false
  const frame = (): TestDecoderFrameV2<T> => {
    if (sent) return { output: '', messages: [] }
    sent = true
    return { output: '', messages: [message()] }
  }
  return { push: frame, finish: () => ({ output: '', messages: [] }) }
}

async function fixture() {
  const instance = createWorkbenchInstance()
  await instance.workspace.initialize({
    projectId: 'testing-v2',
    initialFiles: { '/workspace/main.cpp': 'int main() {}\n' },
    ephemeral: true,
  })
  const workspace = {
    snapshot: () => instance.workspace.snapshot(),
    revision: () => instance.workspace.revision,
    subscribe: (listener: Parameters<typeof instance.workspace.subscribe>[0]) =>
      instance.workspace.subscribe(listener),
  }
  const executed: Array<{ mode: string; workflow?: string }> = []
  const execution: IDEExecutionController = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    restart: vi.fn(async () => undefined),
    executePrepared: vi.fn(async ({ plan, workflow }) => {
      executed.push({ mode: plan.mode, workflow })
      plan.streamInterceptor?.push('stdout', 'frame')
      plan.streamInterceptor?.finish()
    }),
  }
  let reportRun = 0
  const prepareDiscovery = vi.fn<TestProviderV2['prepareDiscovery']>(async ({ files, workspaceDigest }) => {
    const catalog: TestCatalogV2 = {
      apiVersion: 2,
      kind: 'catalog',
      workspaceDigest,
      catalogDigest: DIGEST,
      tests: [
        { id: 'test:v1:alpha', name: 'alpha', origin: 'student', location: { path: '/workspace/main.cpp', line: 1 } },
        { id: 'test:v1:beta', name: 'beta', origin: 'provided' },
      ],
    }
    return {
      execution: { files, mode: 'run' },
      decoder: oneMessageDecoder(() => catalog),
    }
  })
  const prepareRun = vi.fn<TestProviderV2['prepareRun']>(async (request, context) => {
    const runId = `run-${++reportRun}`
    const events: TestReportEventV2[] = [
      { apiVersion: 2, kind: 'report_event', runId, sequence: 0, event: { type: 'run_started' } },
      { apiVersion: 2, kind: 'report_event', runId, sequence: 1, event: { type: 'run_finished', reason: 'completed' } },
    ]
    let index = 0
    return {
      execution: { files: context.files, mode: request.mode },
      decoder: {
        push: () => ({ output: '', messages: events.slice(index, index = events.length) }),
        finish: () => ({ output: '', messages: [] }),
      },
    }
  })
  const provider: TestProviderV2 = {
    apiVersion: 2,
    id: 'synthetic.testing.v2',
    label: 'Synthetic tests',
    languageIds: ['cpp'],
    prepareDiscovery,
    prepareRun,
  }
  const controller = createTestingControllerV2({ provider, workspace, execution })
  return { controller, executed, execution, instance, prepareDiscovery, prepareRun }
}

describe('Testing V2 controller', () => {
  it('discovers and supports run-all, selected-run, and selected-debug', async () => {
    const { controller, executed, prepareRun } = await fixture()

    await controller.discover()
    expect(controller.snapshot()).toMatchObject({
      state: 'ready',
      catalogDigest: DIGEST,
      tests: [{ id: 'test:v1:alpha' }, { id: 'test:v1:beta' }],
    })

    await controller.run({ mode: 'run', selection: { kind: 'all' } })
    await controller.run({ mode: 'run', selection: { kind: 'tests', testIds: ['test:v1:alpha'] } })
    await controller.run({ mode: 'debug', selection: { kind: 'tests', testIds: ['test:v1:beta'] } })

    expect(prepareRun.mock.calls.map(([request]) => request)).toEqual([
      { apiVersion: 2, kind: 'run_request', mode: 'run', workspaceDigest: expect.any(String), catalogDigest: DIGEST, selection: { kind: 'all' } },
      { apiVersion: 2, kind: 'run_request', mode: 'run', workspaceDigest: expect.any(String), catalogDigest: DIGEST, selection: { kind: 'tests', testIds: ['test:v1:alpha'] } },
      { apiVersion: 2, kind: 'run_request', mode: 'debug', workspaceDigest: expect.any(String), catalogDigest: DIGEST, selection: { kind: 'tests', testIds: ['test:v1:beta'] } },
    ])
    for (const [request, context] of prepareRun.mock.calls) {
      expect(Object.keys(request)).toEqual([
        'apiVersion',
        'kind',
        'mode',
        'workspaceDigest',
        'catalogDigest',
        'selection',
      ])
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.selection)).toBe(true)
      expect(context).toEqual({ files: { '/workspace/main.cpp': 'int main() {}\n' } })
    }
    expect(executed).toEqual([
      { mode: 'run', workflow: 'test' },
      { mode: 'run', workflow: 'test' },
      { mode: 'run', workflow: 'test' },
      { mode: 'debug', workflow: 'test' },
    ])
  })

  it('invalidates discovery through the public workspace feed after external application', async () => {
    const { controller, instance, prepareDiscovery } = await fixture()
    await controller.discover()
    expect(controller.snapshot().state).toBe('ready')

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-test-edit',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-test' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'int main() { return 1; }\n' }],
    })

    expect(controller.snapshot()).toMatchObject({ state: 'idle', tests: [] })
    await controller.run({ mode: 'run', selection: { kind: 'all' } })
    expect(prepareDiscovery).toHaveBeenCalledTimes(2)
  })

  it('rejects a selected id outside the digest-bound catalog', async () => {
    const { controller } = await fixture()
    await controller.discover()
    await expect(controller.run({
      mode: 'debug',
      selection: { kind: 'tests', testIds: ['test:v1:missing'] },
    })).rejects.toMatchObject({ code: 'selection_stale' })
  })

  it('rejects a per-test terminal event without the frozen required test id', async () => {
    const { controller, prepareRun } = await fixture()
    await controller.discover()
    prepareRun.mockResolvedValueOnce({
      execution: { files: { '/workspace/main.cpp': 'int main() {}\n' }, mode: 'run' },
      decoder: oneMessageDecoder(() => ({
        apiVersion: 2,
        kind: 'report_event',
        runId: 'run-invalid-terminal',
        sequence: 0,
        event: { type: 'test_failed', message: 'missing id' },
      } as TestReportEventV2)),
    })

    await expect(controller.run({ mode: 'run', selection: { kind: 'all' } }))
      .rejects.toThrow(/requires a valid test id/)
    expect(controller.snapshot().state).toBe('error')
  })

  it('cancels obsolete discovery after a deferred provider await without executing it', async () => {
    const { controller, execution, instance, prepareDiscovery } = await fixture()
    type PreparedDiscovery = Awaited<ReturnType<TestProviderV2['prepareDiscovery']>>
    const gate = deferred<PreparedDiscovery>()
    let requestedDigest = ''
    prepareDiscovery.mockImplementationOnce(async (request) => {
      requestedDigest = request.workspaceDigest
      return gate.promise
    })

    const discovering = controller.discover()
    await vi.waitFor(() => expect(prepareDiscovery).toHaveBeenCalledTimes(1))
    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'invalidate-deferred-discovery',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-test' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'changed\n' }],
    })
    gate.resolve({
      execution: { files: { '/workspace/main.cpp': 'stale\n' }, mode: 'run' },
      decoder: oneMessageDecoder(() => ({
        apiVersion: 2,
        kind: 'catalog',
        workspaceDigest: requestedDigest,
        catalogDigest: DIGEST,
        tests: [],
      })),
    })
    await discovering

    expect(execution.executePrepared).not.toHaveBeenCalled()
    expect(controller.snapshot()).toMatchObject({ state: 'idle', tests: [] })
  })

  it('cancels deferred run preparation on a newer feed revision', async () => {
    const { controller, executed, instance, prepareRun } = await fixture()
    await controller.discover()
    type PreparedRun = Awaited<ReturnType<TestProviderV2['prepareRun']>>
    const gate = deferred<PreparedRun>()
    prepareRun.mockImplementationOnce(async () => gate.promise)

    const running = controller.run({ mode: 'run', selection: { kind: 'all' } })
    await vi.waitFor(() => expect(prepareRun).toHaveBeenCalledTimes(1))
    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'invalidate-deferred-run',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-test' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'changed\n' }],
    })
    gate.resolve({
      execution: { files: { '/workspace/main.cpp': 'stale\n' }, mode: 'run' },
      decoder: oneMessageDecoder<TestReportEventV2>(() => ({
        apiVersion: 2,
        kind: 'report_event',
        runId: 'stale-run',
        sequence: 0,
        event: { type: 'run_started' },
      })),
    })
    await running

    expect(executed).toHaveLength(1)
    expect(controller.snapshot().state).toBe('idle')
  })

  it('stops an executing obsolete run once and never publishes its late result', async () => {
    const { controller, execution, instance } = await fixture()
    await controller.discover()
    const gate = deferred<void>()
    vi.mocked(execution.executePrepared!).mockImplementationOnce(async () => gate.promise)

    const running = controller.run({ mode: 'run', selection: { kind: 'all' } })
    await vi.waitFor(() => expect(controller.snapshot().state).toBe('running'))
    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'invalidate-active-run',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-test' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'changed\n' }],
    })
    expect(execution.stop).toHaveBeenCalledTimes(1)
    gate.resolve()
    await running

    expect(controller.snapshot()).toMatchObject({ state: 'idle', events: [] })
  })

  it('stops and disposes once while execution is deferred', async () => {
    const { controller, execution } = await fixture()
    const gate = deferred<void>()
    vi.mocked(execution.executePrepared!).mockImplementationOnce(async () => gate.promise)
    const discovering = controller.discover()
    await vi.waitFor(() => expect(execution.executePrepared).toHaveBeenCalledTimes(1))

    const disposed = controller.dispose()
    await disposed
    expect(execution.stop).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().state).toBe('disposed')
    gate.resolve()
    await discovering
    await controller.dispose()
    expect(execution.stop).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().state).toBe('disposed')
  })
})

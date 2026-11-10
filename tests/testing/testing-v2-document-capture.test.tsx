// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentV2 } from '../../src/assets/contracts'
import type { IDETestingControllerV2 } from '../../src/testing/testing-controller-v2'
import type { TestProviderV2 } from '../../src/web-ide/contracts/testing'
import type { IDEExecutionController } from '../../src/web-ide/contracts/contributions'
import { TestingV2Mount } from '../../src/testing/TestingV2Mount'

const context = vi.hoisted(() => ({
  configuration: {}, resources: [],
  instance: {} as Record<string, unknown>,
  pipeline: {} as Record<string, unknown>,
  coordinator: {
    acquireActivity: () => () => {},
    getGeneration: () => 1,
    isCurrent: (generation: number) => generation === 1,
  },
}))
vi.mock('../../src/components/layout/use-run-pipeline', () => ({ useRunPipeline: () => context.pipeline }))
vi.mock('../../src/components/layout/run-pipeline-context', () => ({ useRunPipelineCoordinator: () => context.coordinator }))
vi.mock('../../src/web-ide/react/contribution-context', () => ({ useIDEWorkspaceResources: () => context.resources }))
vi.mock('../../src/web-ide/react/configuration-context', () => ({ useWebIDEConfiguration: () => context.configuration }))
vi.mock('../../src/web-ide/react/workbench-instance-context', () => ({ useWorkbenchInstance: () => context.instance }))

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined })

function documentVersion(version: string): WorkspaceDocumentV2 {
  return Object.freeze({ schemaVersion: 2, files: Object.freeze([{ path: '/workspace/main.py', content: `load('${version}.png')` }]),
    assets: Object.freeze([{ path: `/workspace/${version}.png`, blobId: version, sha256: 'a'.repeat(64), byteLength: 10, mediaType: 'image/png' as const }]) })
}

it('captures matching text and image refs once per fresh test run and restart despite edits during discovery', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let live = documentVersion('first'), revision = 0
  let controller: IDETestingControllerV2 | undefined
  let editDuringDiscovery: (() => void) | undefined
  const snapshot = vi.fn(() => Object.fromEntries(live.files.map(file => [file.path, file.content])))
  const documentSnapshot = vi.fn(() => live)
  const executed: { text: string; asset: string }[] = []
  const executePreparedWithinActivity = vi.fn(async (
    request: Parameters<NonNullable<IDEExecutionController['executePrepared']>>[0],
    document: WorkspaceDocumentV2,
  ) => {
    executed.push({ text: request.plan.files['/workspace/main.py'], asset: document.assets[0].path })
    return { type: 'stopped' as const }
  })
  context.pipeline = { execution: { stop: async () => {} }, executePreparedWithinActivity }
  context.instance = {
    workspace: { snapshot, documentSnapshot, get revision() { return revision }, subscribe: () => () => {} },
    testingV2: { attach: (value: IDETestingControllerV2) => { controller = value; return () => {} } },
    testStore: { getState: () => ({ update: () => {} }) },
  }
  const provider: TestProviderV2 = {
    apiVersion: 2, id: 'image-capture', label: 'Image tests', languageIds: ['python'],
    discover: vi.fn<TestProviderV2['discover']>(async ({ workspaceDigest }) => {
      await Promise.resolve()
      const edit = editDuringDiscovery; editDuringDiscovery = undefined; edit?.()
      return { apiVersion: 2, kind: 'catalog', workspaceDigest, catalogDigest: 'b'.repeat(64), tests: [] }
    }),
    prepareRun: async (request, captured) => ({ execution: { files: captured.files, mode: request.mode },
      decoder: { push: () => ({ output: '', messages: [] }), finish: () => ({ output: '', messages: [] }) } }),
  }
  root = createRoot(document.createElement('div'))
  await act(async () => { root?.render(<TestingV2Mount provider={provider} />) })
  await vi.waitFor(() => expect(controller).toBeDefined())
  editDuringDiscovery = () => { live = documentVersion('second'); revision++ }
  await controller!.run({ mode: 'run', selection: { kind: 'all' } })
  editDuringDiscovery = () => { live = documentVersion('third'); revision++ }
  await controller!.restart()
  await controller!.run({ mode: 'debug', selection: { kind: 'all' } })
  expect(executed, JSON.stringify(controller!.snapshot())).toEqual([
    { text: "load('first.png')", asset: '/workspace/first.png' },
    { text: "load('second.png')", asset: '/workspace/second.png' },
    { text: "load('third.png')", asset: '/workspace/third.png' },
  ])
  expect(documentSnapshot).toHaveBeenCalledTimes(3)
  expect(snapshot).not.toHaveBeenCalled()
  await controller!.discover()
  expect(snapshot).toHaveBeenCalledOnce()
  expect(vi.mocked(provider.discover).mock.calls.at(-1)?.[0].files).toEqual({ '/workspace/main.py': "load('third.png')" })
})

// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebIDEHostProvider, type WebIDEHost } from '../../src/host'
import { createWebIDEInstanceController } from '../../src/web-ide/core/instance-handle'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import { IDEContributionContext } from '../../src/web-ide/react/contribution-context'
import { WorkspaceHostBridge } from '../../src/web-ide/react/WorkspaceHostBridge'
import {
  createWorkbenchInstance,
  WorkbenchInstanceContext,
} from '../../src/web-ide/react/workbench-instance-context'

const opfs = vi.hoisted(() => ({
  readWorkspaceFromOPFS: vi.fn(async () => ({} as Record<string, string>)),
}))
vi.mock('@/vfs/opfs-sync', () => ({
  readWorkspaceFromOPFS: opfs.readWorkspaceFromOPFS,
  syncToOPFS: vi.fn(async () => undefined),
  deleteFromOPFS: vi.fn(async () => undefined),
}))

const MAIN = '/workspace/main.cpp'
const files = { [MAIN]: 'int main() {\n    return 0;\n}' }
const cleanups: (() => Promise<void>)[] = []

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value) },
  })
  opfs.readWorkspaceFromOPFS.mockResolvedValue({})
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.unstubAllGlobals()
})

async function mount(host: WebIDEHost) {
  const instance = createWorkbenchInstance()
  const controller = createWebIDEInstanceController(instance)
  const plugins = new IDEPluginManager([])
  const root = createRoot(document.createElement('div'))
  const render = async (nextHost: WebIDEHost) => {
    await act(async () => root.render(
      <StrictMode>
        <WorkbenchInstanceContext.Provider value={instance}>
          <WebIDEHostProvider host={nextHost}>
            <IDEContributionContext.Provider value={plugins}>
              <WorkspaceHostBridge instanceController={controller} />
            </IDEContributionContext.Provider>
          </WebIDEHostProvider>
        </WorkbenchInstanceContext.Provider>
      </StrictMode>,
    ))
  }
  const unmount = async () => { await act(async () => root.unmount()) }
  cleanups.push(unmount)
  await render(host)
  return { instance, controller, render }
}

describe('public host breakpoint options', () => {
  it('seeds only after fresh file hydration under StrictMode', async () => {
    const { controller } = await mount({ workspace: {
      id: 'public-breakpoint-seed', localCache: 'memory',
      initialFiles: files, initialBreakpoints: { 'main.cpp': [2] },
    } })
    expect(controller.handle.snapshot().debug.breakpoints[MAIN]).toEqual([2])
  })

  it('does not reapply removed defaults on semantically identical host rerenders', async () => {
    const host: WebIDEHost = { workspace: {
      id: 'public-breakpoint-rerender', localCache: 'memory',
      initialFiles: files, initialBreakpoints: { 'main.cpp': [2] },
    } }
    const { instance, controller, render } = await mount(host)
    instance.debugStore.getState().toggleBreakpoint(MAIN, 2)
    await render({ workspace: {
      ...host.workspace!, initialFiles: { ...files }, initialBreakpoints: { 'main.cpp': [2] },
    } })
    expect(controller.handle.snapshot().debug.breakpoints[MAIN] ?? []).toEqual([])
  })

  it('does not seed defaults into existing OPFS workspace files', async () => {
    opfs.readWorkspaceFromOPFS.mockResolvedValue({ [MAIN]: 'int main() { return 42; }' })
    const { controller } = await mount({ workspace: {
      id: 'existing-files', initialFiles: files, initialBreakpoints: { 'main.cpp': [2] },
    } })
    expect(controller.handle.snapshot().workspace[MAIN]).toContain('return 42')
    expect(controller.handle.snapshot().debug.breakpoints[MAIN] ?? []).toEqual([])
  })

  it('isolates default breakpoints across concurrent public hosts with overlapping paths', async () => {
    const first = await mount({ workspace: {
      id: 'first', localCache: 'memory', initialFiles: files,
      initialBreakpoints: { [MAIN]: [2] },
    } })
    const second = await mount({ workspace: {
      id: 'second', localCache: 'memory', initialFiles: files,
      initialBreakpoints: { [MAIN]: [3] },
    } })
    first.instance.debugStore.getState().toggleBreakpoint(MAIN, 2)
    expect(first.controller.handle.snapshot().debug.breakpoints[MAIN] ?? []).toEqual([])
    expect(second.controller.handle.snapshot().debug.breakpoints[MAIN]).toEqual([3])
  })
})

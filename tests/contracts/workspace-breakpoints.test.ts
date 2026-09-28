import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchInstance, type WorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import type { IDEWorkspace } from '../../src/web-ide/contracts/host'
import { bindWorkspaceBreakpoints } from '../../src/web-ide/core/workspace-breakpoints'

const MAIN = '/workspace/main.cpp'
const initialFiles = { [MAIN]: 'int main() {\n    return 0;\n}\n' }
const workspace: IDEWorkspace = {
  id: 'breakpoint-example', initialFiles, initialBreakpoints: { 'main.cpp': [2] },
}
let instance: WorkbenchInstance
let saved: Map<string, string>
let cleanups: (() => void)[]
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value) },
}
const bind = (options = workspace, fresh = true) => {
  const stop = bindWorkspaceBreakpoints(instance, options, fresh, storage)
  cleanups.push(stop)
  return stop
}

beforeEach(async () => {
  saved = new Map()
  cleanups = []
  instance = createWorkbenchInstance()
  await instance.workspace.initialize({ projectId: workspace.id, initialFiles, ephemeral: true })
})
afterEach(() => {
  for (const stop of cleanups) stop()
  instance.workspace.dispose()
})

describe('host-owned workspace default breakpoints', () => {
  it('seeds a fresh workspace and retains a removed default after reload', () => {
    const stop = bind()
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
    instance.debugStore.getState().toggleBreakpoint(MAIN, 2)
    stop()
    instance.debugStore.setState({ breakpoints: {} })

    bind(workspace, false)
    expect(instance.debugStore.getState().breakpoints[MAIN] ?? []).toEqual([])
  })

  it('does not impose defaults on existing workspace files without saved breakpoint state', () => {
    bind(workspace, false)
    expect(instance.debugStore.getState().breakpoints[MAIN] ?? []).toEqual([])
  })

  it('restores changed breakpoints by workspace identity without leaking between projects', () => {
    let stop = bind()
    instance.debugStore.getState().setFileBreakpoints(MAIN, [1, 3])
    stop()
    stop = bind({ ...workspace, id: 'second-example' })
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
    stop()
    bind(workspace, false)
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([1, 3])
  })

  it('ignores stale files and invalid lines when restoring stored data', () => {
    saved.set(`web-ide.workspace-breakpoints.v1:${workspace.id}`, JSON.stringify({
      [MAIN]: [0, 2, 2, 2.5, 100, '1'],
      '/workspace/deleted.cpp': [1],
      '../outside.cpp': [1],
    }))
    bind(workspace, false)
    expect(instance.debugStore.getState().breakpoints).toEqual({ [MAIN]: [2] })
  })

  it('keeps memory-only workspaces ephemeral and leaves non-opted-in hosts alone', () => {
    const stop = bind({ ...workspace, localCache: 'memory' })
    instance.debugStore.getState().toggleBreakpoint(MAIN, 2)
    expect(saved.size).toBe(0)
    stop()
    bind({ ...workspace, localCache: 'memory' })
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
    bind({ id: 'unconfigured' })
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
  })

  it('continues without persistent storage when browser storage is unavailable', () => {
    const unavailable = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('blocked') }),
    }
    cleanups.push(bindWorkspaceBreakpoints(instance, workspace, true, unavailable))
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
    expect(() => instance.debugStore.getState().toggleBreakpoint(MAIN, 2)).not.toThrow()
  })

  it('clears opted-in breakpoint state on exit without forgetting the saved choices', () => {
    const stop = bind()
    stop()
    bind({ id: 'ordinary-lesson' })
    expect(instance.debugStore.getState().breakpoints[MAIN] ?? []).toEqual([])
    bind(workspace, false)
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([2])
  })

  it('keeps simultaneous workbenches independent and saves each instance', async () => {
    const second = createWorkbenchInstance()
    await second.workspace.initialize({ projectId: 'second', initialFiles, ephemeral: true })
    const stopFirst = bind()
    const secondWorkspace = { ...workspace, id: 'second', initialBreakpoints: { [MAIN]: [3] } }
    const stopSecond = bindWorkspaceBreakpoints(second, secondWorkspace, true, storage)
    try {
      instance.debugStore.getState().setFileBreakpoints(MAIN, [1])
      second.debugStore.getState().setFileBreakpoints(MAIN, [2, 3])
      expect(JSON.parse(saved.get(`web-ide.workspace-breakpoints.v1:${workspace.id}`)!))
        .toEqual({ [MAIN]: [1] })
      expect(JSON.parse(saved.get('web-ide.workspace-breakpoints.v1:second')!))
        .toEqual({ [MAIN]: [2, 3] })
      stopFirst()
      expect(second.debugStore.getState().breakpoints[MAIN]).toEqual([2, 3])
      second.debugStore.getState().setFileBreakpoints(MAIN, [3])
      expect(JSON.parse(saved.get('web-ide.workspace-breakpoints.v1:second')!))
        .toEqual({ [MAIN]: [3] })
    } finally {
      stopSecond()
      second.workspace.dispose()
    }
  })

  it('does not let a stale cleanup clear a newer workspace binding', () => {
    const stopOld = bind()
    bind({ ...workspace, id: 'newer', initialBreakpoints: { [MAIN]: [3] } })
    stopOld()
    expect(instance.debugStore.getState().breakpoints[MAIN]).toEqual([3])
  })
})

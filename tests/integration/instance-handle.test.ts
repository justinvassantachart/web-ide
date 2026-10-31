import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebIDEInstanceHandle } from '../../src/web-ide/contracts/instance'
import { createWebIDEInstanceController } from '../../src/web-ide/core/instance-handle'
import {
  createPanelLayoutController,
  type PanelLayoutController,
} from '../../src/web-ide/core/panel-layout'
import {
  createWorkbenchInstance,
  type WorkbenchInstance,
} from '../../src/web-ide/react/workbench-instance-context'

const files = {
  '/workspace/main.cpp': 'int main() {}',
  '/workspace/helper.cpp': 'int helper() { return 1; }',
}

let webIDEInstanceHandle: WebIDEInstanceHandle
let panelLayout: PanelLayoutController
let workbench: WorkbenchInstance

beforeEach(async () => {
  panelLayout = createPanelLayoutController('variables')
  workbench = createWorkbenchInstance()
  webIDEInstanceHandle = createWebIDEInstanceController(workbench, panelLayout).handle
  await workbench.workspace.initialize({ projectId: 'instance-handle-test', initialFiles: files, ephemeral: true })
  workbench.editorStore.setState({
    activeFile: null,
    activeFileContent: '',
    openFiles: [],
    cursorLine: 1,
    cursorColumn: 1,
  })
  workbench.debugStore.getState().reset()
  workbench.debugStore.setState({ breakpoints: {} })
  workbench.testStore.getState().reset()
})

describe('public Web IDE instance facade', () => {
  it('exposes host-requested warmup and drains it before closing persistence', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const calls: string[] = []
    const cancel = vi.fn(async () => { calls.push('cancel') })
    const warmup = vi.fn(async () => ({ status: 'completed' as const, diagnostics: [], statistics: { entries: 1 } }))
    const detach = controller.attachRuntimeWarmup({ warmup, cancel })
    controller.attachWorkspaceLifecycle({ flush: async () => {}, close: async () => { calls.push('close') } })
    expect(await controller.handle.warmup!()).toMatchObject({ status: 'completed', statistics: { entries: 1 } })
    expect(warmup).toHaveBeenCalledOnce()
    await controller.handle.close()
    expect(calls).toEqual(['cancel', 'close'])
    detach()
    expect(await controller.handle.warmup!()).toMatchObject({ status: 'skipped' })
  })

  it('a stale warmup bridge detach cannot remove a replacement bridge', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const old = controller.attachRuntimeWarmup({ warmup: async () => ({ status: 'failed', diagnostics: [] }), cancel: async () => {} })
    controller.attachRuntimeWarmup({ warmup: async () => ({ status: 'completed', diagnostics: [] }), cancel: async () => {} })
    old()
    expect((await controller.handle.warmup!()).status).toBe('completed')
  })

  it('reads owned backend statistics through the active runtime bridge', () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    expect(controller.handle.compilationStatistics!()).toBeUndefined()
    const statistics = { latest: { cache: { hits: 5 }, compilerModule: { hits: 2 } } }
    const detach = controller.attachRuntimeWarmup({
      warmup: async () => ({ status: 'completed', diagnostics: [] }),
      cancel: async () => {},
      compilationStatistics: () => statistics,
    })
    const first = controller.handle.compilationStatistics!() as typeof statistics
    first.latest.cache.hits = 99
    expect(controller.handle.compilationStatistics!()).toEqual(statistics)
    detach()
    expect(controller.handle.compilationStatistics!()).toBeUndefined()
  })

  it('opens host-requested files without exposing or stealing store focus', () => {
    expect(
      webIDEInstanceHandle.ensureFilesOpen(Object.keys(files), '/workspace/main.cpp'),
    ).toBe(true)
    expect(webIDEInstanceHandle.snapshot().editor).toEqual({
      activeFile: '/workspace/main.cpp',
      openFiles: ['/workspace/helper.cpp', '/workspace/main.cpp'],
    })

    workbench.editorStore.getState().setActiveFile(
      '/workspace/helper.cpp',
      workbench.workspace.readFile('/workspace/helper.cpp'),
    )
    webIDEInstanceHandle.ensureFilesOpen(Object.keys(files), '/workspace/main.cpp')
    expect(webIDEInstanceHandle.snapshot().editor.activeFile).toBe(
      '/workspace/helper.cpp',
    )

    const snapshot = webIDEInstanceHandle.snapshot()
    expect(Object.isFrozen(snapshot.workspace)).toBe(true)
    expect(snapshot.workspace).toEqual(files)
  })

  it('canonicalizes and deduplicates host-requested editor paths', () => {
    const decomposed = '/workspace/cafe\u0301.cpp'
    const canonical = '/workspace/caf\u00e9.cpp'
    workbench.workspace.createFileLocal(decomposed, 'accented\n')
    workbench.editorStore.setState({ activeFile: null, activeFileContent: '', openFiles: [] })

    expect(webIDEInstanceHandle.ensureFilesOpen(
      [decomposed, canonical],
      decomposed,
    )).toBe(true)

    expect(webIDEInstanceHandle.snapshot().editor).toEqual({
      activeFile: canonical,
      openFiles: [canonical],
    })
    expect(webIDEInstanceHandle.snapshot().workspace).toHaveProperty(canonical, 'accented\n')
    expect(webIDEInstanceHandle.snapshot().workspace).not.toHaveProperty(decomposed)
  })

  it('combines observable changes and provides intent-level reset actions', () => {
    const listener = vi.fn()
    const unsubscribe = webIDEInstanceHandle.subscribe(listener)
    workbench.editorStore.setState({ cursorLine: 8 })
    expect(listener).toHaveBeenCalledTimes(1)

    panelLayout.selectPanel('tests')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(webIDEInstanceHandle.snapshot().rightPanel).toBe('tests')

    unsubscribe()
    workbench.editorStore.setState({ cursorLine: 9 })
    panelLayout.selectPanel('variables')
    expect(listener).toHaveBeenCalledTimes(2)

    workbench.debugStore.getState().setFileBreakpoints('/workspace/main.cpp', [2, 4])
    workbench.debugStore.setState({ debugMode: 'paused', currentLine: 4 })
    workbench.testStore.setState({
      isTesting: true,
      tests: [{
        id: 'sample',
        name: 'sample',
        status: 'running',
        assertions: [],
        diagnostics: [],
      }],
      completedCount: 0,
      totalCount: 1,
    })

    webIDEInstanceHandle.reset({ breakpointFiles: ['/workspace/main.cpp'] })
    const snapshot = webIDEInstanceHandle.snapshot()
    expect(snapshot.debug.debugMode).toBe('idle')
    expect(snapshot.debug.breakpoints['/workspace/main.cpp']).toEqual([])
    expect(snapshot.tests).toEqual([])
  })

  it('canonicalizes and deduplicates public reset breakpoint paths', () => {
    const decomposed = '/workspace/cafe\u0301.cpp'
    const canonical = '/workspace/caf\u00e9.cpp'
    workbench.workspace.createFileLocal(decomposed, 'int accented;\n')
    workbench.debugStore.getState().setFileBreakpoints(canonical, [3])
    workbench.debugStore.getState().setFileBreakpoints(decomposed, [5])

    webIDEInstanceHandle.reset({ breakpointFiles: [decomposed] })

    expect(webIDEInstanceHandle.snapshot().debug.breakpoints).toEqual({
      [canonical]: [],
    })
  })

  it('accepts 1,024-code-point reset paths and rejects 1,025 before any reset', () => {
    const fileAtLimit = `/workspace/${'r'.repeat(1024 - '/workspace/'.length)}`
    const fileOverLimit = `${fileAtLimit}r`
    workbench.debugStore.setState({
      breakpoints: { [fileAtLimit]: [7] },
      debugMode: 'paused',
      currentLine: 7,
    })

    webIDEInstanceHandle.reset({ breakpointFiles: [fileAtLimit] })
    expect(webIDEInstanceHandle.snapshot().debug.breakpoints[fileAtLimit]).toEqual([])

    workbench.debugStore.setState({
      breakpoints: { [fileAtLimit]: [8] },
      debugMode: 'paused',
      currentLine: 8,
    })
    expect(() => webIDEInstanceHandle.reset({
      breakpointFiles: [fileAtLimit, fileOverLimit],
    })).toThrow(/oversized/)
    expect(webIDEInstanceHandle.snapshot().debug).toMatchObject({
      debugMode: 'paused',
      currentLine: 8,
      breakpoints: { [fileAtLimit]: [8] },
    })
  })

  it('rejects malformed public reset paths before changing instance state', () => {
    workbench.debugStore.getState().setFileBreakpoints('/workspace/main.cpp', [2])
    workbench.debugStore.setState({ debugMode: 'paused', currentLine: 2 })
    workbench.testStore.setState({
      isTesting: true,
      tests: [{
        id: 'sample',
        name: 'sample',
        status: 'running',
        assertions: [],
        diagnostics: [],
      }],
      completedCount: 0,
      totalCount: 1,
    })

    expect(() => webIDEInstanceHandle.reset({
      breakpointFiles: ['/workspace/main.cpp', '/workspace/bad\ud800.cpp'],
    })).toThrow()

    const snapshot = webIDEInstanceHandle.snapshot()
    expect(snapshot.debug.debugMode).toBe('paused')
    expect(snapshot.debug.currentLine).toBe(2)
    expect(snapshot.debug.breakpoints['/workspace/main.cpp']).toEqual([2])
    expect(snapshot.tests).toEqual([{ name: 'sample', status: 'running' }])
  })

  it('provides isolated per-mount persistence lifecycles and immutable projections', async () => {
    const firstInstance = createWorkbenchInstance()
    const secondInstance = createWorkbenchInstance()
    await firstInstance.workspace.initialize({ projectId: 'first-handle', initialFiles: files, ephemeral: true })
    await secondInstance.workspace.initialize({ projectId: 'second-handle', initialFiles: files, ephemeral: true })
    const first = createWebIDEInstanceController(firstInstance)
    const second = createWebIDEInstanceController(secondInstance)
    const firstFlush = vi.fn().mockResolvedValue(undefined)
    const firstClose = vi.fn().mockResolvedValue(undefined)
    const secondFlush = vi.fn().mockResolvedValue(undefined)
    const secondClose = vi.fn().mockResolvedValue(undefined)

    first.attachWorkspaceLifecycle({ flush: firstFlush, close: firstClose })
    second.attachWorkspaceLifecycle({ flush: secondFlush, close: secondClose })

    expect(first.handle).not.toBe(second.handle)
    const persisted = first.handle.persistedFiles()
    expect(persisted).toEqual(files)
    expect(Object.isFrozen(persisted)).toBe(true)

    await first.handle.flushWorkspace()
    await first.handle.close()

    expect(firstFlush).toHaveBeenCalledWith(files)
    expect(firstClose).toHaveBeenCalledWith(files)
    expect(secondFlush).not.toHaveBeenCalled()
    expect(secondClose).not.toHaveBeenCalled()
  })

  it('does not let a stale mount detach its replacement lifecycle', async () => {
    const controller = createWebIDEInstanceController(workbench)
    const staleFlush = vi.fn().mockResolvedValue(undefined)
    const activeFlush = vi.fn().mockResolvedValue(undefined)
    const detachStale = controller.attachWorkspaceLifecycle({
      flush: staleFlush,
      close: vi.fn(),
    })
    controller.attachWorkspaceLifecycle({
      flush: activeFlush,
      close: vi.fn(),
    })

    detachStale()
    await controller.handle.flushWorkspace()

    expect(staleFlush).not.toHaveBeenCalled()
    expect(activeFlush).toHaveBeenCalledTimes(1)
  })
})

describe('runtime activity and lifecycle bridge', () => {
  function bridge() {
    return {
      identity: {},
      warmup: vi.fn(async () => ({ status: 'completed' as const, diagnostics: [] })),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      suspend: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      release: vi.fn(async (_options?: { signal?: AbortSignal }): Promise<'released' | 'cancelled'> => _options?.signal?.aborted ? 'cancelled' : 'released'),
    }
  }

  it('release is lazy and unsupported providers are not stopped', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    expect(await controller.handle.releaseCompilerResources()).toBe('released')
    const cancel = vi.fn(async () => {})
    controller.attachRuntimeWarmup({ warmup: async () => ({ status: 'completed', diagnostics: [] }), cancel })
    expect(await controller.handle.releaseCompilerResources()).toBe('cancelled')
    expect(cancel).not.toHaveBeenCalled()
    const abort = new AbortController()
    abort.abort()
    expect(await controller.handle.releaseCompilerResources({ signal: abort.signal })).toBe('cancelled')
  })

  it('defers hidden release across delayed outer transforms and aborts it on foreground intent', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const runtime = bridge()
    controller.attachRuntimeWarmup(runtime)
    const finishWarmup = controller.acquireRuntimeActivity(false)!
    const release = controller.handle.releaseCompilerResources()
    await Promise.resolve()
    expect(runtime.release).not.toHaveBeenCalled()
    const finishForeground = controller.acquireRuntimeActivity(true)!
    expect(await release).toBe('cancelled')
    finishWarmup()
    const second = controller.handle.releaseCompilerResources()
    await Promise.resolve()
    expect(runtime.release).not.toHaveBeenCalled()
    finishForeground()
    expect(await second).toBe('released')
    expect(runtime.release).toHaveBeenCalledOnce()
  })

  it('shutdown fences synchronously and drains idempotently independently from failed persistence', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const runtime = bridge()
    controller.attachRuntimeWarmup(runtime)
    controller.attachWorkspaceLifecycle({ flush: async () => {}, close: async () => { throw new Error('save failed') } })
    await expect(controller.handle.close()).rejects.toThrow('save failed')
    expect(runtime.shutdown).not.toHaveBeenCalled()
    const finish = controller.acquireRuntimeActivity(true)!
    const shutdown = controller.handle.shutdownRuntime()
    expect(runtime.shutdown).toHaveBeenCalledOnce()
    expect(controller.handle.shutdownRuntime()).toBe(shutdown)
    expect(controller.acquireRuntimeActivity(true)).toBeUndefined()
    let settled = false
    void shutdown.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await shutdown
    expect(await controller.handle.releaseCompilerResources()).toBe('released')
  })

  it('suspension is reversible and a stale resume cannot open permanent shutdown', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const runtime = bridge()
    controller.attachRuntimeWarmup(runtime)
    const finish = controller.acquireRuntimeActivity(true)!
    const suspension = controller.handle.suspendRuntime()
    expect(runtime.suspend).toHaveBeenCalledOnce()
    expect(controller.acquireRuntimeActivity(true)).toBeUndefined()
    const resumed = controller.handle.resumeRuntime()
    finish()
    await Promise.all([suspension, resumed])
    const activity = controller.acquireRuntimeActivity(true)
    expect(activity).toBeTypeOf('function')
    activity!()
    await controller.handle.shutdownRuntime()
    await controller.handle.resumeRuntime()
    expect(controller.acquireRuntimeActivity(true)).toBeUndefined()
    expect(runtime.resume).toHaveBeenCalledOnce()
  })

  it('a distinct StrictMode session can attach while a stale detach cannot retire it', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    const first = bridge()
    const detachFirst = controller.attachRuntimeWarmup(first)
    await controller.handle.shutdownRuntime()
    controller.attachRuntimeWarmup(first)
    expect(controller.acquireRuntimeActivity(true)).toBeUndefined()
    const second = bridge()
    controller.attachRuntimeWarmup(second)
    detachFirst()
    await vi.waitFor(() => {
      const release = controller.acquireRuntimeActivity(false)
      expect(release).toBeTypeOf('function')
      release?.()
    })
    const finish = controller.acquireRuntimeActivity(true)
    expect(finish).toBeTypeOf('function')
    finish!()
    expect(await controller.handle.warmup!()).toMatchObject({ status: 'completed' })
    expect(second.warmup).toHaveBeenCalledOnce()
  })

  it('does not reopen a handle closed before its first runtime attachment', async () => {
    const controller = createWebIDEInstanceController(workbench, panelLayout)
    await controller.handle.shutdownRuntime()
    const arriving = bridge()
    controller.attachRuntimeWarmup(arriving)
    expect(arriving.shutdown).toHaveBeenCalledOnce()
    expect(controller.acquireRuntimeActivity(true)).toBeUndefined()
    expect((await controller.handle.warmup!()).status).toBe('skipped')
    await controller.handle.shutdownRuntime()
  })

})

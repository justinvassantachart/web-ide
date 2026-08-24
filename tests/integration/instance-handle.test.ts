import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebugStore } from '../../src/store/debug-store'
import { useEditorStore } from '../../src/store/editor-store'
import { useExecutionStore } from '../../src/store/execution-store'
import { useTestStore } from '../../src/testing/test-store'
import { initVFS, readFile } from '../../src/vfs/volume'
import type { WebIDEInstanceHandle } from '../../src/web-ide/contracts/instance'
import { createWebIDEInstanceController } from '../../src/web-ide/core/instance-handle'

const files = {
  '/workspace/main.cpp': 'int main() {}',
  '/workspace/helper.cpp': 'int helper() { return 1; }',
}

let webIDEInstanceHandle: WebIDEInstanceHandle

beforeEach(async () => {
  webIDEInstanceHandle = createWebIDEInstanceController().handle
  await initVFS({ projectId: 'instance-handle-test', initialFiles: files, ephemeral: true })
  useEditorStore.setState({
    activeFile: null,
    activeFileContent: '',
    openFiles: [],
    cursorLine: 1,
    cursorColumn: 1,
  })
  useDebugStore.getState().reset()
  useDebugStore.setState({ breakpoints: {} })
  useExecutionStore.setState({ rightTab: 'variables' })
  useTestStore.getState().reset()
})

describe('public Web IDE instance facade', () => {
  it('opens host-requested files without exposing or stealing store focus', () => {
    expect(
      webIDEInstanceHandle.ensureFilesOpen(Object.keys(files), '/workspace/main.cpp'),
    ).toBe(true)
    expect(webIDEInstanceHandle.snapshot().editor).toEqual({
      activeFile: '/workspace/main.cpp',
      openFiles: ['/workspace/helper.cpp', '/workspace/main.cpp'],
    })

    useEditorStore.getState().setActiveFile(
      '/workspace/helper.cpp',
      readFile('/workspace/helper.cpp'),
    )
    webIDEInstanceHandle.ensureFilesOpen(Object.keys(files), '/workspace/main.cpp')
    expect(webIDEInstanceHandle.snapshot().editor.activeFile).toBe(
      '/workspace/helper.cpp',
    )

    const snapshot = webIDEInstanceHandle.snapshot()
    expect(Object.isFrozen(snapshot.workspace)).toBe(true)
    expect(snapshot.workspace).toEqual(files)
  })

  it('combines observable changes and provides intent-level reset actions', () => {
    const listener = vi.fn()
    const unsubscribe = webIDEInstanceHandle.subscribe(listener)
    useEditorStore.setState({ cursorLine: 8 })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    useEditorStore.setState({ cursorLine: 9 })
    expect(listener).toHaveBeenCalledTimes(1)

    useDebugStore.getState().setFileBreakpoints('/workspace/main.cpp', [2, 4])
    useDebugStore.setState({ debugMode: 'paused', currentLine: 4 })
    useTestStore.setState({
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

  it('provides isolated per-mount persistence lifecycles and immutable projections', async () => {
    const first = createWebIDEInstanceController()
    const second = createWebIDEInstanceController()
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
    const controller = createWebIDEInstanceController()
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

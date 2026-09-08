// @vitest-environment jsdom

import { StrictMode, createRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  IDEPlugin,
  RuntimeEventChannels,
  RuntimeProvider,
  RuntimeSession,
  WebIDEConfiguration,
  WebIDEHost,
  WebIDEInstanceHandle,
} from '../../src/web-ide'
import type { WorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import {
  bootstrapWorkspace as bootstrapLegacyWorkspace,
  getAllFiles as getLegacyWorkspaceFiles,
  writeFile as writeLegacyWorkspaceFile,
} from '../../src/vfs/volume'

const harness = vi.hoisted(() => ({
  instances: new Map<string, unknown>(),
}))

vi.mock('@/web-ide/react/WorkbenchLayout', async () => {
  const { useLayoutEffect } = await import('react')
  const { useWebIDEHost } = await import('@/web-ide/react/host-context')
  const { useWorkbenchInstance } = await import('@/web-ide/react/workbench-instance-context')
  return {
    WorkbenchLayout() {
      const instance = useWorkbenchInstance()
      const workspaceId = useWebIDEHost()?.workspace?.id ?? 'standalone'
      useLayoutEffect(() => {
        harness.instances.set(workspaceId, instance)
        return () => {
          if (harness.instances.get(workspaceId) === instance) {
            harness.instances.delete(workspaceId)
          }
        }
      }, [instance, workspaceId])
      return null
    },
  }
})

const eventSource = { subscribe: () => () => undefined }

function createRuntimeProvider(disposals: () => void): RuntimeProvider {
  return {
    id: 'synthetic.runtime',
    label: 'Synthetic runtime',
    languageIds: ['cpp'],
    capabilities: {
      debug: true,
      breakpoints: true,
      stdin: true,
      graphics: false,
    },
    createSession() {
      let disposed = false
      return {
        id: 'synthetic.runtime.session',
        languageIds: ['cpp'],
        capabilities: this.capabilities,
        events: {
          stdout: eventSource,
          stderr: eventSource,
          terminalClear: eventSource,
          graphicsDraw: eventSource,
          debugPaused: eventSource,
          debugResumed: eventSource,
          exit: eventSource,
          diagnostic: eventSource,
          breakpointsValidated: eventSource,
        } as RuntimeEventChannels,
        prepare: async () => ({ success: true, errors: [] }),
        start: async () => undefined,
        stop: () => undefined,
        setBreakpoints: async () => undefined,
        stepInto: async () => undefined,
        stepOver: async () => undefined,
        stepOut: async () => undefined,
        continueExecution: async () => undefined,
        dispose() {
          if (disposed) return
          disposed = true
          disposals()
        },
      } satisfies RuntimeSession
    },
  }
}

function configuration(runtime: RuntimeProvider): WebIDEConfiguration {
  const plugin: IDEPlugin = {
    id: 'synthetic.runtime.plugin',
    contributes: { runtimeProviders: [runtime] },
  }
  return {
    runtimeProvider: runtime.id,
    brand: false,
    plugins: [plugin],
  }
}

function host(
  id: string,
  text: string,
  persistence: NonNullable<NonNullable<WebIDEHost['workspace']>['persistence']>,
): WebIDEHost {
  return {
    workspace: {
      id,
      localCache: 'memory',
      initialFiles: { '/workspace/main.cpp': text },
      persistence,
    },
  }
}

let root: Root | undefined

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
      await Promise.resolve()
      await Promise.resolve()
    })
    root = undefined
  }
  harness.instances.clear()
})

describe('same-realm WebIDE instance isolation', () => {
  it('separates overlapping workspace, store, debug, model, feed, and persistence state', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const runtimeDisposals = vi.fn()
    const config = configuration(createRuntimeProvider(runtimeDisposals))
    const firstPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const secondPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const firstRef = createRef<WebIDEInstanceHandle>()
    const secondRef = createRef<WebIDEInstanceHandle>()
    const container = document.createElement('div')
    root = createRoot(container)
    bootstrapLegacyWorkspace({ '/workspace/main.cpp': 'legacy singleton\n' })

    await act(async () => {
      root?.render(
        <>
          <WebIDEHostMount
            configuration={config}
            host={host('first-workspace', 'first\n', firstPersistence)}
            instanceRef={firstRef}
          />
          <WebIDEHostMount
            configuration={config}
            host={host('second-workspace', 'second\n', secondPersistence)}
            instanceRef={secondRef}
          />
        </>,
      )
      await Promise.resolve()
    })

    await vi.waitFor(() => {
      expect(harness.instances.size).toBe(2)
      expect(firstRef.current?.workspace.snapshot()['/workspace/main.cpp']).toBe('first\n')
      expect(secondRef.current?.workspace.snapshot()['/workspace/main.cpp']).toBe('second\n')
    })
    await Promise.all([
      firstRef.current!.flushWorkspace(),
      secondRef.current!.flushWorkspace(),
    ])
    firstPersistence.save.mockClear()
    firstPersistence.flush.mockClear()
    secondPersistence.save.mockClear()
    secondPersistence.flush.mockClear()
    const first = harness.instances.get('first-workspace') as WorkbenchInstance
    const second = harness.instances.get('second-workspace') as WorkbenchInstance
    const firstFeed = vi.fn()
    const secondFeed = vi.fn()
    const unsubscribeFirst = firstRef.current!.workspace.subscribe(firstFeed)
    const unsubscribeSecond = secondRef.current!.workspace.subscribe(secondFeed)

    first.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 7)
    first.editorStore.getState().setCursor(9, 4)
    first.filesStore.getState().toggleDir('/workspace')
    first.executionStore.getState().setIsRunning(true)
    first.compilerStore.getState().setCacheState('error')
    first.testStore.getState().processEvent({ type: 'run-start', total: 1 })
    first.workspace.writeLocal('/workspace/main.cpp', 'first changed\n')

    expect(firstRef.current!.snapshot().debug.breakpoints['/workspace/main.cpp']).toEqual([7])
    expect(secondRef.current!.snapshot().debug.breakpoints).toEqual({})
    expect(first.editorStore.getState().cursorLine).toBe(9)
    expect(second.editorStore.getState().cursorLine).toBe(1)
    expect(first.filesStore.getState().expandedDirs).toContain('/workspace')
    expect(second.filesStore.getState().expandedDirs).not.toContain('/workspace')
    expect(first.executionStore.getState().isRunning).toBe(true)
    expect(second.executionStore.getState().isRunning).toBe(false)
    expect(first.compilerStore.getState().cacheState).toBe('error')
    expect(second.compilerStore.getState().cacheState).toBe('ready')
    expect(first.testStore.getState().isTesting).toBe(true)
    expect(second.testStore.getState().isTesting).toBe(false)
    expect(firstRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('first changed\n')
    expect(secondRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('second\n')
    expect(first.workspace.toMonacoUri('/workspace/main.cpp'))
      .not.toBe(second.workspace.toMonacoUri('/workspace/main.cpp'))
    expect(firstFeed).toHaveBeenCalledTimes(1)
    expect(secondFeed).not.toHaveBeenCalled()
    expect(firstRef.current!.persistence.snapshot().state).toBe('saving')
    expect(secondRef.current!.persistence.snapshot().state).toBe('saved')
    expect(getLegacyWorkspaceFiles()['/workspace/main.cpp']).toBe('legacy singleton\n')

    writeLegacyWorkspaceFile('/workspace/main.cpp', 'legacy changed\n')
    expect(firstRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('first changed\n')
    expect(secondRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('second\n')

    await firstRef.current!.flushWorkspace()
    expect(firstRef.current!.persistence.snapshot().state).toBe('saved')
    expect(firstPersistence.save).toHaveBeenCalledWith(
      { '/workspace/main.cpp': 'first changed\n' },
      expect.objectContaining({ workspaceId: 'first-workspace', reason: 'flush' }),
    )
    expect(secondPersistence.save).not.toHaveBeenCalled()
    unsubscribeFirst()
    unsubscribeSecond()
  })

  it('releases a StrictMode instance and disposes persistence exactly once', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const runtimeDisposals = vi.fn()
    const config = configuration(createRuntimeProvider(runtimeDisposals))
    const persistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const instanceRef = createRef<WebIDEInstanceHandle>()
    const container = document.createElement('div')
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <StrictMode>
          <WebIDEHostMount
            configuration={config}
            host={host('strict-workspace', 'strict\n', persistence)}
            instanceRef={instanceRef}
          />
        </StrictMode>,
      )
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(harness.instances.has('strict-workspace')).toBe(true))
    const captured = harness.instances.get('strict-workspace') as WorkbenchInstance

    await act(async () => {
      root?.unmount()
      await Promise.resolve()
      await Promise.resolve()
    })
    root = undefined

    await vi.waitFor(() => {
      expect(harness.instances.has('strict-workspace')).toBe(false)
      expect(persistence.dispose).toHaveBeenCalledTimes(1)
    })
    expect(() => captured.workspace.writeLocal('/workspace/main.cpp', 'late\n'))
      .toThrow(/disposed/)
    expect(persistence.flush).toHaveBeenCalledTimes(1)
    expect(runtimeDisposals).toHaveBeenCalledTimes(2)
  })
})

import { WebIDE, WebIDEHostProvider } from '../../src/web-ide'

function WebIDEHostMount({
  configuration,
  host: selectedHost,
  instanceRef,
}: {
  configuration: WebIDEConfiguration
  host: WebIDEHost
  instanceRef: ReturnType<typeof createRef<WebIDEInstanceHandle>>
}) {
  return (
    <WebIDEHostProvider host={selectedHost}>
      <WebIDE ref={instanceRef} configuration={configuration} />
    </WebIDEHostProvider>
  )
}

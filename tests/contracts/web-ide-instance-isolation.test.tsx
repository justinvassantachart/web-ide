// @vitest-environment jsdom

import { StrictMode, createRef, useLayoutEffect } from 'react'
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
  TestCatalogV2,
  TestDecoderFrameV2,
  TestProviderV2,
  TestReportEventV2,
} from '../../src/web-ide'
import type { WorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { useWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { useWebIDEHost } from '../../src/web-ide/react/host-context'
import { createCppClangdProvider } from '../../src/clangd/plugin'
import type { CppCompileProfileV1 } from '../../src/web-ide/contracts/cpp'
import { testingPlugin } from '../../src/web-ide/plugins/testing'
import { coreWorkbenchPlugin } from '../../src/web-ide/plugins/core-workbench'
import {
  bootstrapWorkspace as bootstrapLegacyWorkspace,
  getAllFiles as getLegacyWorkspaceFiles,
  writeFile as writeLegacyWorkspaceFile,
} from '../../src/vfs/volume'

const harness = vi.hoisted(() => ({
  instances: new Map<string, unknown>(),
  models: new Map<string, {
    uri: { authority: string; path: string; toString(): string }
    getValue(): string
    setValue(value: string): void
    isDisposed(): boolean
    changeListeners: Set<(value: string) => void>
  }>(),
  runtimeSessions: [] as RuntimeSession[],
  clangdBoots: [] as Array<{ files: Record<string, string>; client: {
    writeFiles: ReturnType<typeof vi.fn>
    deleteFile: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  } }>,
}))

const opfsHarness = vi.hoisted(() => ({
  readWorkspaceFromOPFS: vi.fn(async (projectId: string) => {
    void projectId
    return {} as Record<string, string>
  }),
  syncToOPFS: vi.fn(async (projectId: string, path: string, content: string) => {
    void [projectId, path, content]
  }),
  deleteFromOPFS: vi.fn(async (projectId: string, path: string) => {
    void [projectId, path]
  }),
}))

vi.mock('@/vfs/opfs-sync', () => ({
  readWorkspaceFromOPFS: opfsHarness.readWorkspaceFromOPFS,
  syncToOPFS: opfsHarness.syncToOPFS,
  deleteFromOPFS: opfsHarness.deleteFromOPFS,
  createFolderInOPFS: vi.fn(async () => undefined),
  renameInOPFS: vi.fn(async () => undefined),
  hydrateFromOPFS: vi.fn(async () => undefined),
  savePchToOPFS: vi.fn(async () => undefined),
  loadPchFromOPFS: vi.fn(async () => null),
}))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  const parseUri = (value: string) => {
    const parsed = new URL(value)
    return {
      authority: parsed.host,
      path: parsed.pathname,
      toString: () => value,
    }
  }
  const monaco = {
    Uri: { parse: parseUri },
    Range: class Range {
      constructor(...args: number[]) { void args }
    },
    KeyCode: { F9: 68 },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      getModels: () => [...harness.models.values()].filter((model) => !model.isDisposed()),
      getModel: (uri: { toString(): string }) => harness.models.get(uri.toString()) ?? null,
      setModelMarkers: vi.fn(),
    },
    languages: {},
  }
  const loaderPromise = Object.assign(Promise.resolve(monaco), { cancel: vi.fn() })

  return {
    loader: {
      config: vi.fn(),
      __getMonacoInstance: () => monaco,
      init: () => loaderPromise,
    },
    useMonaco: () => monaco,
    default: function MockMonacoEditor(props: {
      path: string
      defaultValue?: string
      onChange?(value: string): void
      onMount?(editor: Record<string, unknown>, monaco: Record<string, unknown>): void
    }) {
      const propsRef = React.useRef(props)
      const editorRef = React.useRef<{ focus(): void } | null>(null)
      propsRef.current = props
      const model = React.useMemo(() => {
        const existing = harness.models.get(props.path)
        if (existing) return existing
        const uri = parseUri(props.path)
        let value = props.defaultValue ?? ''
        let disposed = false
        const changeListeners = new Set<(next: string) => void>()
        const created = {
          uri,
          getValue: () => value,
          setValue(next: string) {
            value = next
            for (const listener of [...changeListeners]) listener(next)
          },
          isDisposed: () => disposed,
          changeListeners,
          dispose: () => { disposed = true },
          deltaDecorations: (_old: string[], next: unknown[]) => next.map((_, index) => `d${index}`),
          getLineCount: () => Math.max(1, value.split('\n').length),
          getLineMaxColumn: (line: number) => (value.split('\n')[line - 1]?.length ?? 0) + 1,
        }
        harness.models.set(props.path, created)
        return created
      }, [props.defaultValue, props.path])
      React.useLayoutEffect(() => {
        const focusListeners = new Set<() => void>()
        const editor = {
          getModel: () => model,
          getPosition: () => ({ lineNumber: 1, column: 1 }),
          onDidFocusEditorWidget: (listener: () => void) => { focusListeners.add(listener) },
          onKeyDown: vi.fn(),
          onMouseDown: vi.fn(),
          onMouseMove: vi.fn(),
          onMouseLeave: vi.fn(),
          onDidChangeCursorPosition: vi.fn(),
          addCommand: vi.fn(),
          revealLineInCenter: vi.fn(),
          revealPositionInCenter: vi.fn(),
          setPosition: vi.fn(),
          focus: () => { for (const listener of focusListeners) listener() },
        }
        editorRef.current = editor
        const change = (value: string) => propsRef.current.onChange?.(value)
        model.changeListeners.add(change)
        propsRef.current.onMount?.(editor, monaco)
        editor.focus()
        return () => {
          if (editorRef.current === editor) editorRef.current = null
          model.changeListeners.delete(change)
        }
      }, [model])
      return React.createElement('div', {
        'data-monaco-path': props.path,
        tabIndex: 0,
        onFocus: () => editorRef.current?.focus(),
      })
    },
  }
})

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div />,
  ResizablePanel: ({ children }: { children: import('react').ReactNode }) => <section>{children}</section>,
  ResizablePanelGroup: ({ children }: { children: import('react').ReactNode }) => <main>{children}</main>,
}))
vi.mock('@/components/terminal/Terminal', () => ({ Terminal: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: 'div',
  TooltipContent: 'div',
  TooltipTrigger: 'span',
  TooltipProvider: ({ children }: { children: unknown }) => children,
}))
vi.mock('@/clangd/cache', () => ({
  purgeOldClangdCaches: vi.fn(async () => undefined),
  requestPersistentStorage: vi.fn(async () => undefined),
}))
vi.mock('@/clangd/providers', () => ({
  clearClangdMarkers: vi.fn(),
  registerClangdProviders: vi.fn(() => ({ dispose: vi.fn() })),
}))
vi.mock('@/clangd/bootstrap', () => ({
  bootClangd: vi.fn(async (files: Record<string, string>) => {
    const client = {
      writeFiles: vi.fn(),
      deleteFile: vi.fn(),
      dispose: vi.fn(),
      onStatus: { subscribe: () => () => undefined },
      getStatus: () => ({ state: 'ready' as const }),
    }
    harness.clangdBoots.push({ files, client })
    return client
  }),
}))

const eventSource = { subscribe: () => () => undefined }

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((accept) => { resolve = accept })
  return { promise, resolve }
}

function createEventSource<Value>() {
  const listeners = new Set<(value: Value) => void>()
  return {
    subscribe(listener: (value: Value) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(value: Value) {
      for (const listener of [...listeners]) listener(value)
    },
  }
}

function CapturePanel() {
  const instance = useWorkbenchInstance()
  const workspaceId = useWebIDEHost()?.workspace?.id ?? 'standalone'
  useLayoutEffect(() => {
    harness.instances.set(workspaceId, instance)
    return () => {
      if (harness.instances.get(workspaceId) === instance) harness.instances.delete(workspaceId)
    }
  }, [instance, workspaceId])
  return <div data-instance-capture={workspaceId} />
}

function CaptureActivity() {
  return <div data-activity-capture />
}

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
      let preparedPlan: Parameters<RuntimeSession['prepare']>[0] | undefined
      const exit = createEventSource<number>()
      const session = {
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
          exit,
          diagnostic: eventSource,
          breakpointsValidated: eventSource,
        } as RuntimeEventChannels,
        prepare: vi.fn(async (plan) => {
          preparedPlan = plan
          return { success: true, errors: [] }
        }),
        start: vi.fn(async () => {
          preparedPlan?.streamInterceptor?.push('stdout', 'frame')
          preparedPlan?.streamInterceptor?.finish()
          exit.emit(0)
        }),
        stop: vi.fn(() => undefined),
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
      harness.runtimeSessions.push(session)
      return session
    },
  }
}

const clangdProfile: CppCompileProfileV1 = {
  version: 1,
  target: 'wasm32-wasip1',
  languageStandard: 'c++20',
  includeDirectories: ['/support/include'],
  defines: [],
  warningPreset: 'strict',
  toolchain: {
    compilerDigest: 'a'.repeat(64),
    sysrootDigest: 'b'.repeat(64),
    cxxAbiId: 'synthetic-libcxx-v1',
  },
}

function configuration(runtime: RuntimeProvider): WebIDEConfiguration {
  const clangd = createCppClangdProvider({
    id: 'synthetic.clangd',
    label: 'Synthetic clangd',
    profile: clangdProfile,
    supportFiles: { '/support/include/synthetic.h': '#pragma once\n' },
  })
  const plugin: IDEPlugin = {
    id: 'synthetic.workbench.plugin',
    contributes: {
      runtimeProviders: [runtime],
      languageToolingProviders: [clangd],
      activities: [{
        id: 'synthetic.activity',
        title: 'Files',
        icon: 'files',
        component: CaptureActivity,
      }],
      panels: [{
        id: 'synthetic.panel',
        title: 'Instance',
        component: CapturePanel,
      }],
      commands: [{
        id: 'synthetic.debug',
        title: 'Debug',
        surface: 'toolbar',
        when: ({ runState }) => runState === 'idle',
        execute: ({ execution }) => execution.start('debug'),
      }],
    },
  }
  return {
    runtimeProvider: runtime.id,
    languageToolingProvider: clangd.id,
    brand: false,
    initialLayout: {
      selectedActivityId: 'synthetic.activity',
      selectedPanelId: 'synthetic.panel',
    },
    plugins: [plugin],
  }
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

function mountedTestingV2Provider() {
  let run = 0
  const prepareDiscovery = vi.fn<TestProviderV2['prepareDiscovery']>(async ({ files, workspaceDigest }) => {
    const catalog: TestCatalogV2 = {
      apiVersion: 2,
      kind: 'catalog',
      workspaceDigest,
      catalogDigest: 'c'.repeat(64),
      tests: [
        { id: 'mounted:alpha', name: 'mounted alpha', origin: 'student', location: { path: '/workspace/main.cpp', line: 1 } },
        { id: 'mounted:beta', name: 'mounted beta', origin: 'provided' },
      ],
    }
    return { execution: { files, mode: 'run' }, decoder: oneMessageDecoder(() => catalog) }
  })
  const prepareRun = vi.fn<TestProviderV2['prepareRun']>(async (request, context) => {
    const runId = `mounted-${++run}`
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
    label: 'Synthetic Testing V2',
    languageIds: ['cpp'],
    prepareDiscovery,
    prepareRun,
  }
  return { prepareDiscovery, prepareRun, provider }
}

function testingConfiguration(runtime: RuntimeProvider, provider: TestProviderV2): WebIDEConfiguration {
  const base = configuration(runtime)
  return {
    ...base,
    testProvider: provider.id,
    initialLayout: { ...base.initialLayout, selectedPanelId: 'tests' },
    plugins: [
      ...base.plugins,
      { id: 'synthetic.testing.provider', contributes: { testProviders: [provider] } },
      testingPlugin,
    ],
  }
}

function host(
  id: string,
  text: string,
  persistence: NonNullable<NonNullable<WebIDEHost['workspace']>['persistence']>,
  localCache: NonNullable<WebIDEHost['workspace']>['localCache'] = 'memory',
): WebIDEHost {
  return {
    events: { emit: vi.fn() },
    workspace: {
      id,
      localCache,
      initialFiles: {
        '/workspace/main.cpp': text,
        '/workspace/z-inactive.h': `${id} inactive\n`,
      },
      persistence,
    },
  }
}

let root: Root | undefined
let mountedContainer: HTMLDivElement | undefined

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
      await Promise.resolve()
      await Promise.resolve()
    })
    root = undefined
  }
  mountedContainer?.remove()
  mountedContainer = undefined
  harness.instances.clear()
  harness.models.clear()
  harness.runtimeSessions.length = 0
  harness.clangdBoots.length = 0
  opfsHarness.readWorkspaceFromOPFS.mockReset().mockResolvedValue({})
  opfsHarness.syncToOPFS.mockReset().mockResolvedValue(undefined)
  opfsHarness.deleteFromOPFS.mockReset().mockResolvedValue(undefined)
  window.localStorage.removeItem('web-ide.clangd.enabled')
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
    const firstHost = host('first-workspace', 'first\n', firstPersistence)
    const secondHost = host('second-workspace', 'second\n', secondPersistence)
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)
    window.localStorage.setItem('web-ide.clangd.enabled', 'true')
    bootstrapLegacyWorkspace({ '/workspace/main.cpp': 'legacy singleton\n' })

    await act(async () => {
      root?.render(
        <>
          <WebIDEHostMount key="first"
            configuration={config}
            host={firstHost}
            instanceRef={firstRef}
          />
          <WebIDEHostMount key="second"
            configuration={config}
            host={secondHost}
            instanceRef={secondRef}
          />
        </>,
      )
      await Promise.resolve()
    })

    await act(async () => {
      await vi.waitFor(() => {
        expect(harness.instances.size).toBe(2)
        expect(firstRef.current?.workspace.snapshot()['/workspace/main.cpp']).toBe('first\n')
        expect(secondRef.current?.workspace.snapshot()['/workspace/main.cpp']).toBe('second\n')
      })
      await vi.waitFor(() => expect(harness.models.size).toBe(2))
      for (const editor of mountedContainer!.querySelectorAll<HTMLElement>('[data-monaco-path]')) {
        editor.focus()
      }
      await vi.waitFor(() => expect(harness.clangdBoots).toHaveLength(2))
      await Promise.all([
        firstRef.current!.flushWorkspace(),
        secondRef.current!.flushWorkspace(),
      ])
    })
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

    const firstMainUri = first.workspace.toMonacoUri('/workspace/main.cpp')
    const secondMainUri = second.workspace.toMonacoUri('/workspace/main.cpp')
    const firstHeaderUri = first.workspace.toMonacoUri('/workspace/z-inactive.h')
    const secondHeaderUri = second.workspace.toMonacoUri('/workspace/z-inactive.h')
    const firstMainModel = harness.models.get(firstMainUri)
    vi.mocked(firstHost.events!.emit).mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2_000))
    expect(firstMainModel?.changeListeners.size).toBe(1)
    await act(async () => {
      firstMainModel?.setValue('local burst one\n')
      firstMainModel?.setValue('local burst two\n')
    })
    expect(vi.mocked(firstHost.events!.emit).mock.calls.filter(([name]) => name === 'edit')).toHaveLength(1)
    await act(async () => {
      expect(firstRef.current!.ensureFilesOpen(
        ['/workspace/main.cpp', '/workspace/z-inactive.h'],
        '/workspace/z-inactive.h',
      )).toBe(true)
      await vi.waitFor(() => expect(harness.models.size).toBe(3))
      await firstRef.current!.workspace.apply({
        version: 1,
        kind: 'apply',
        transactionId: 'remote-inactive-model',
        expectedRevision: firstRef.current!.workspace.revision(),
        origin: { kind: 'external-authority', source: 'remote-provider' },
        operations: [
          { op: 'write', path: '/workspace/main.cpp', text: 'remote inactive\n' },
          { op: 'write', path: '/workspace/z-inactive.h', text: 'remote header\n' },
        ],
      })
      await vi.advanceTimersByTimeAsync(1_100)
    })
    expect(harness.models.get(firstMainUri)?.getValue()).toBe('remote inactive\n')
    expect(harness.models.get(firstHeaderUri)?.getValue()).toBe('remote header\n')
    expect(harness.models.get(secondMainUri)?.getValue()).toBe('second\n')
    expect(harness.models.get(secondHeaderUri)).toBeUndefined()
    expect(second.workspace.readFile('/workspace/z-inactive.h')).toBe('second-workspace inactive\n')
    expect(vi.mocked(firstHost.events!.emit).mock.calls.filter(([name]) => name === 'edit')).toHaveLength(1)
    expect(vi.mocked(secondHost.events!.emit).mock.calls.filter(([name]) => name === 'edit')).toHaveLength(0)
    expect(harness.clangdBoots[0]?.client.writeFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ '/workspace/main.cpp': 'remote inactive\n' }),
    )
    expect(harness.clangdBoots[1]?.client.writeFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ '/workspace/main.cpp': 'remote inactive\n' }),
    )
    await act(async () => firstRef.current!.flushWorkspace())
    firstPersistence.save.mockClear()
    firstPersistence.flush.mockClear()
    vi.useRealTimers()

    const roots = mountedContainer.querySelectorAll<HTMLElement>('.web-ide-root')
    await act(async () => {
      roots[0]?.focus()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
      await vi.waitFor(() => expect(harness.runtimeSessions[0]?.start).toHaveBeenCalledTimes(1))
    })
    expect(harness.runtimeSessions[1]?.start).not.toHaveBeenCalled()

    await act(async () => {
      first.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 7)
      first.editorStore.getState().setCursor(9, 4)
      first.filesStore.getState().toggleDir('/workspace')
      first.executionStore.getState().setIsRunning(true)
      first.compilerStore.getState().setCacheState('error')
      first.testStore.getState().processEvent({ type: 'run-start', total: 1 })
      first.workspace.writeLocal('/workspace/main.cpp', 'first changed\n')
    })

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
    expect(firstFeed).toHaveBeenCalledTimes(4)
    expect(secondFeed).not.toHaveBeenCalled()
    expect(firstRef.current!.persistence.snapshot().state).toBe('saving')
    expect(secondRef.current!.persistence.snapshot().state).toBe('saved')
    expect(getLegacyWorkspaceFiles()['/workspace/main.cpp']).toBe('legacy singleton\n')

    writeLegacyWorkspaceFile('/workspace/main.cpp', 'legacy changed\n')
    expect(firstRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('first changed\n')
    expect(secondRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('second\n')

    await act(async () => firstRef.current!.flushWorkspace())
    expect(firstRef.current!.persistence.snapshot().state).toBe('saved')
    expect(firstPersistence.save).toHaveBeenCalledWith(
      {
        '/workspace/main.cpp': 'first changed\n',
        '/workspace/z-inactive.h': 'remote header\n',
      },
      expect.objectContaining({ workspaceId: 'first-workspace', reason: 'flush' }),
    )
    expect(secondPersistence.save).not.toHaveBeenCalled()
    unsubscribeFirst()
    unsubscribeSecond()

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          key="second"
          configuration={config}
          host={secondHost}
          instanceRef={secondRef}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(harness.instances.has('first-workspace')).toBe(false))
    })
    expect(harness.instances.has('second-workspace')).toBe(true)
    expect(harness.models.get(firstMainUri)?.isDisposed()).toBe(true)
    expect(harness.models.get(secondMainUri)?.isDisposed()).toBe(false)
    expect(harness.clangdBoots[0]?.client.dispose).toHaveBeenCalledTimes(1)
    expect(harness.clangdBoots[1]?.client.dispose).not.toHaveBeenCalled()
    const retainedRoot = mountedContainer.querySelector<HTMLElement>('.web-ide-root')
    await act(async () => {
      retainedRoot?.focus()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
      await vi.waitFor(() => expect(harness.runtimeSessions[1]?.start).toHaveBeenCalledTimes(1))
    })
  })

  it('mounts the Testing V2 controller and wires discovery, run-all, selected run, and selected debug', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const runtime = createRuntimeProvider(vi.fn())
    const testing = mountedTestingV2Provider()
    const config = testingConfiguration(runtime, testing.provider)
    const persistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const instanceRef = createRef<WebIDEInstanceHandle>()
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('testing-v2-workspace', 'int main() {}\n', persistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => {
        expect(testing.prepareDiscovery).toHaveBeenCalledTimes(1)
        expect(mountedContainer?.textContent).toContain('mounted alpha')
        expect(mountedContainer?.textContent).toContain('mounted beta')
      })
    })

    const toolbarRunAll = mountedContainer.querySelector<HTMLButtonElement>(
      '[data-command-id="workbench.test"]',
    )
    expect(toolbarRunAll).not.toBeNull()
    await act(async () => {
      toolbarRunAll?.click()
      await vi.waitFor(() => expect(testing.prepareRun).toHaveBeenCalledTimes(1))
    })

    const beta = mountedContainer.querySelector<HTMLInputElement>(
      '[aria-label="Select mounted beta"]',
    )
    expect(beta?.checked).toBe(true)
    await act(async () => beta?.click())
    expect(beta?.checked).toBe(false)
    const buttons = [...mountedContainer.querySelectorAll<HTMLButtonElement>('button')]
    const runSelected = buttons.find((button) => button.textContent?.trim() === 'Run Selected')
    const debugSelected = buttons.find((button) => button.textContent?.trim() === 'Debug Selected')
    await act(async () => {
      runSelected?.click()
      await vi.waitFor(() => expect(testing.prepareRun).toHaveBeenCalledTimes(2))
    })
    await act(async () => {
      debugSelected?.click()
      await vi.waitFor(() => expect(testing.prepareRun).toHaveBeenCalledTimes(3))
    })

    expect(testing.prepareRun.mock.calls.map(([request]) => ({
      mode: request.mode,
      selection: request.selection,
      keys: Object.keys(request),
    }))).toEqual([
      {
        mode: 'run',
        selection: { kind: 'all' },
        keys: ['apiVersion', 'kind', 'mode', 'workspaceDigest', 'catalogDigest', 'selection'],
      },
      {
        mode: 'run',
        selection: { kind: 'tests', testIds: ['mounted:alpha'] },
        keys: ['apiVersion', 'kind', 'mode', 'workspaceDigest', 'catalogDigest', 'selection'],
      },
      {
        mode: 'debug',
        selection: { kind: 'tests', testIds: ['mounted:alpha'] },
        keys: ['apiVersion', 'kind', 'mode', 'workspaceDigest', 'catalogDigest', 'selection'],
      },
    ])

    await act(async () => {
      await instanceRef.current!.workspace.apply({
        version: 1,
        kind: 'apply',
        transactionId: 'mounted-testing-remote-edit',
        expectedRevision: instanceRef.current!.workspace.revision(),
        origin: { kind: 'external-authority', source: 'remote-provider' },
        operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'int main() { return 1; }\n' }],
      })
      await vi.waitFor(() => expect(testing.prepareDiscovery).toHaveBeenCalledTimes(2))
    })
  })

  it('seeds a replacement persistence adapter and isolates a pending old-adapter failure', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const config = configuration(createRuntimeProvider(vi.fn()))
    const oldFailure = new Error('old adapter failed')
    const oldPersistence = {
      save: vi.fn().mockRejectedValue(oldFailure),
      flush: vi.fn(),
      dispose: vi.fn(),
    }
    const replacementPersistence = {
      save: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    }
    const instanceRef = createRef<WebIDEInstanceHandle>()
    const statuses: string[] = []
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('replacement-workspace', 'current snapshot\n', oldPersistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => {
        expect(instanceRef.current?.workspace.snapshot()['/workspace/main.cpp'])
          .toBe('current snapshot\n')
        expect(instanceRef.current?.persistence.snapshot().state).toBe('saving')
      })
    })
    const unsubscribe = instanceRef.current!.persistence.subscribe((status) => statuses.push(status.state))

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('replacement-workspace', 'current snapshot\n', replacementPersistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(oldPersistence.dispose).toHaveBeenCalledTimes(1))
    })
    expect(oldPersistence.save).toHaveBeenCalledWith(
      {
        '/workspace/main.cpp': 'current snapshot\n',
        '/workspace/z-inactive.h': 'replacement-workspace inactive\n',
      },
      expect.objectContaining({ workspaceId: 'replacement-workspace', reason: 'flush' }),
    )
    expect(oldPersistence.flush).toHaveBeenCalledTimes(1)

    await act(async () => instanceRef.current!.flushWorkspace())
    expect(replacementPersistence.save).toHaveBeenCalledWith(
      {
        '/workspace/main.cpp': 'current snapshot\n',
        '/workspace/z-inactive.h': 'replacement-workspace inactive\n',
      },
      expect.objectContaining({ workspaceId: 'replacement-workspace', reason: 'flush' }),
    )
    expect(instanceRef.current!.persistence.snapshot().state).toBe('saved')
    expect(statuses).not.toContain('retrying')
    expect(statuses).not.toContain('error')
    unsubscribe()

    await act(async () => {
      root?.unmount()
      await Promise.resolve()
      await Promise.resolve()
    })
    root = undefined
    await act(async () => {
      await vi.waitFor(() => expect(replacementPersistence.dispose).toHaveBeenCalledTimes(1))
    })
    expect(oldPersistence.dispose).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveBeenCalledWith(
      '[web-ide] workspace persistence cleanup failed',
      expect.anything(),
    )
    warnings.mockRestore()
  })

  it('subscribes a replacement adapter before a saving observer applies a newer snapshot', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const config = configuration(createRuntimeProvider(vi.fn()))
    const oldPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const replacementPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const instanceRef = createRef<WebIDEInstanceHandle>()
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('replacement-reentry', 'seed snapshot\n', oldPersistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(instanceRef.current).not.toBeNull())
    })
    await act(async () => instanceRef.current!.flushWorkspace())
    expect(instanceRef.current!.persistence.snapshot().state).toBe('saved')

    let replacementStarted = false
    let reentrantApplication: Promise<unknown> | undefined
    const unsubscribe = instanceRef.current!.persistence.subscribe((status) => {
      if (!replacementStarted || status.state !== 'saving' || reentrantApplication) return
      reentrantApplication = instanceRef.current!.workspace.apply({
        version: 1,
        kind: 'apply',
        transactionId: 'replacement-saving-reentry',
        expectedRevision: instanceRef.current!.workspace.revision(),
        origin: { kind: 'external-authority', source: 'remote-provider' },
        operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'newer snapshot\n' }],
      })
    })

    vi.useFakeTimers()
    replacementStarted = true
    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('replacement-reentry', 'seed snapshot\n', replacementPersistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(reentrantApplication).toBeDefined()
    await act(async () => {
      await reentrantApplication
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
    })
    vi.useRealTimers()

    expect(instanceRef.current!.workspace.snapshot()['/workspace/main.cpp']).toBe('newer snapshot\n')
    expect(replacementPersistence.save).toHaveBeenCalledTimes(1)
    expect(replacementPersistence.save).toHaveBeenCalledWith(
      {
        '/workspace/main.cpp': 'newer snapshot\n',
        '/workspace/z-inactive.h': 'replacement-reentry inactive\n',
      },
      expect.objectContaining({ workspaceId: 'replacement-reentry', reason: 'change' }),
    )
    unsubscribe()
  })

  it('keeps Explorer-created and renamed aliases canonical in callbacks and editor state', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const runtime = createRuntimeProvider(vi.fn())
    const base = configuration(runtime)
    const config: WebIDEConfiguration = {
      ...base,
      initialLayout: { ...base.initialLayout, selectedActivityId: 'workbench.files' },
      plugins: [...base.plugins, coreWorkbenchPlugin],
    }
    const persistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const explorerHost = host('canonical-explorer', 'main\n', persistence)
    const emit = explorerHost.events!.emit as ReturnType<typeof vi.fn>
    const instanceRef = createRef<WebIDEInstanceHandle>()
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={explorerHost}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => {
        expect(instanceRef.current).not.toBeNull()
        expect(mountedContainer?.querySelector('[title="New File…"]')).not.toBeNull()
      })
    })

    await act(async () => {
      mountedContainer!.querySelector<HTMLButtonElement>('[title="New File…"]')!.click()
    })
    let input = mountedContainer!.querySelector<HTMLInputElement>('.vsx-input')!
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setInputValue.call(input, 'cafe\u0301.cpp')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const created = '/workspace/caf\u00e9.cpp'
    expect(instanceRef.current!.workspace.snapshot()).toHaveProperty(created, '')
    expect(instanceRef.current!.snapshot().editor.activeFile).toBe(created)
    expect(emit).toHaveBeenCalledWith('file_create', { path: created, kind: 'file' })

    const createdRow = [...mountedContainer!.querySelectorAll<HTMLElement>('.vsx-row')]
      .find((row) => row.querySelector('.vsx-label')?.textContent === 'café.cpp')!
    await act(async () => createdRow.click())
    await act(async () => {
      mountedContainer!.querySelector<HTMLElement>('.vsx-tree')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    })
    input = createdRow.querySelector<HTMLInputElement>('.vsx-input')!
    await act(async () => {
      setInputValue.call(input, 'resume\u0301.cpp')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const renamed = '/workspace/resum\u00e9.cpp'
    expect(instanceRef.current!.workspace.snapshot()).toHaveProperty(renamed, '')
    expect(instanceRef.current!.snapshot().editor.activeFile).toBe(renamed)
    expect(instanceRef.current!.snapshot().editor.openFiles).toContain(renamed)
    expect(instanceRef.current!.snapshot().editor.openFiles.every(
      (path) => path === path.normalize('NFC'),
    )).toBe(true)
    expect(emit).toHaveBeenCalledWith('file_rename', { from: created, to: renamed })
  })

  it('recreates instance resources before a delayed workspace identity can bind persistence', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const config = configuration(createRuntimeProvider(vi.fn()))
    const firstPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const secondPersistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const secondRestore = deferred<Record<string, string>>()
    opfsHarness.readWorkspaceFromOPFS.mockImplementation(async (projectId) => {
      if (projectId === 'identity-b') return secondRestore.promise
      return {}
    })
    const instanceRef = createRef<WebIDEInstanceHandle>()
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)

    await act(async () => {
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('identity-a', 'workspace A\n', firstPersistence)}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(
        instanceRef.current?.workspace.snapshot()['/workspace/main.cpp'],
      ).toBe('workspace A\n'))
      await instanceRef.current!.flushWorkspace()
    })
    const firstInstance = harness.instances.get('identity-a') as WorkbenchInstance
    firstPersistence.save.mockClear()
    firstPersistence.flush.mockClear()
    firstPersistence.dispose.mockClear()

    // Leave both the host coordinator's two-second debounce and the
    // controller's browser-local write path pending at the identity boundary.
    await act(async () => {
      firstInstance.workspace.writeLocal('/workspace/main.cpp', 'workspace A pending\n')
      root?.render(
        <WebIDEHostMount
          configuration={config}
          host={host('identity-b', 'workspace B seed\n', secondPersistence, 'opfs')}
          instanceRef={instanceRef}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const secondInstance = harness.instances.get('identity-b') as WorkbenchInstance
    expect(secondInstance).toBeDefined()
    expect(secondInstance).not.toBe(firstInstance)
    expect(secondInstance.workspace.monacoAuthority).not.toBe(firstInstance.workspace.monacoAuthority)
    expect(instanceRef.current?.workspace.snapshot()).toEqual({})

    // No persistence lifecycle is exposed for B until its exact OPFS restore
    // resolves, so an explicit flush during the delay is a safe no-op.
    await act(async () => instanceRef.current!.flushWorkspace())
    expect(secondPersistence.save).not.toHaveBeenCalled()
    expect(secondPersistence.flush).not.toHaveBeenCalled()
    await act(async () => {
      await vi.waitFor(() => expect(firstPersistence.dispose).toHaveBeenCalledTimes(1))
    })
    expect(firstPersistence.save).toHaveBeenCalledWith(
      expect.objectContaining({ '/workspace/main.cpp': 'workspace A pending\n' }),
      expect.objectContaining({ workspaceId: 'identity-a', reason: 'flush' }),
    )
    expect(firstPersistence.save.mock.calls.every(([, context]) =>
      context.workspaceId === 'identity-a')).toBe(true)
    expect(secondPersistence.save).not.toHaveBeenCalled()

    await act(async () => {
      secondRestore.resolve({
        '/workspace/main.cpp': 'workspace B restored\n',
        '/workspace/z-inactive.h': 'identity-b restored inactive\n',
      })
      await vi.waitFor(() => expect(
        instanceRef.current?.workspace.snapshot()['/workspace/main.cpp'],
      ).toBe('workspace B restored\n'))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await instanceRef.current!.flushWorkspace()
    })
    expect(secondPersistence.flush).toHaveBeenCalledTimes(1)
    expect(secondPersistence.save).toHaveBeenLastCalledWith(
      {
        '/workspace/main.cpp': 'workspace B restored\n',
        '/workspace/z-inactive.h': 'identity-b restored inactive\n',
      },
      expect.objectContaining({ workspaceId: 'identity-b', reason: 'flush' }),
    )

    // A new debounced B snapshot is still drained only into B by an explicit
    // flush; no save call on the new adapter may contain workspace A.
    await act(async () => {
      secondInstance.workspace.writeLocal('/workspace/main.cpp', 'workspace B edited\n')
      await instanceRef.current!.flushWorkspace()
    })
    expect(secondPersistence.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ '/workspace/main.cpp': 'workspace B edited\n' }),
      expect.objectContaining({ workspaceId: 'identity-b', reason: 'flush' }),
    )
    expect(secondPersistence.save.mock.calls.every(([files, context]) =>
      context.workspaceId === 'identity-b'
      && files['/workspace/main.cpp'] !== 'workspace A\n'
      && files['/workspace/main.cpp'] !== 'workspace A pending\n')).toBe(true)
    expect(warnings).not.toHaveBeenCalledWith(
      '[web-ide] workspace persistence cleanup failed',
      expect.anything(),
    )
    warnings.mockRestore()
  })

  it('releases a StrictMode instance and disposes persistence exactly once', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const runtimeDisposals = vi.fn()
    const config = configuration(createRuntimeProvider(runtimeDisposals))
    const persistence = { save: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
    const instanceRef = createRef<WebIDEInstanceHandle>()
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    root = createRoot(mountedContainer)
    window.localStorage.setItem('web-ide.clangd.enabled', 'true')

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
    await act(async () => {
      await vi.waitFor(() => expect(harness.instances.has('strict-workspace')).toBe(true))
    })
    const captured = harness.instances.get('strict-workspace') as WorkbenchInstance
    const strictModelUri = captured.workspace.toMonacoUri('/workspace/main.cpp')
    expect(harness.models.get(strictModelUri)?.isDisposed()).toBe(false)

    await act(async () => {
      root?.unmount()
      await Promise.resolve()
      await Promise.resolve()
    })
    root = undefined

    await act(async () => {
      await vi.waitFor(() => {
        expect(harness.instances.has('strict-workspace')).toBe(false)
        expect(persistence.dispose).toHaveBeenCalledTimes(1)
      })
    })
    expect(() => captured.workspace.writeLocal('/workspace/main.cpp', 'late\n'))
      .toThrow(/disposed/)
    expect(captured.getRootElement()).toBeNull()
    expect(harness.models.get(strictModelUri)?.isDisposed()).toBe(true)
    expect(captured.testingV2.snapshot()).toBeUndefined()
    await expect(captured.testingV2.whenAvailable()).rejects.toThrow(/disposed/)
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

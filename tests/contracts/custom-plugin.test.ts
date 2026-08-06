import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  DebugPauseState,
  DrawCommand,
  IDECommandContext,
  IDEPlugin,
  RuntimeSession,
  RuntimeEventChannels,
} from '../../src/web-ide'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'

class FakeEventSource<T> {
  private readonly listeners = new Set<(event: T) => void>()

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function createFakeRuntime(): {
  session: RuntimeSession
  stdout: FakeEventSource<string>
} {
  const events = {
    stdout: new FakeEventSource<string>(),
    stderr: new FakeEventSource<string>(),
    terminalClear: new FakeEventSource<void>(),
    graphicsDraw: new FakeEventSource<DrawCommand[]>(),
    debugPaused: new FakeEventSource<DebugPauseState>(),
    debugResumed: new FakeEventSource<void>(),
    exit: new FakeEventSource<number>(),
    diagnostic: new FakeEventSource<{
      message: string
      severity: 'error' | 'warning'
      phase: 'preparation' | 'execution'
      mode: 'run' | 'debug'
    }>(),
    breakpointsValidated: new FakeEventSource<{
      file: string
      lines: number[]
    }>(),
  } satisfies RuntimeEventChannels

  const session = {
    id: 'host.fake-runtime',
    languageIds: ['text'],
    capabilities: {
      debug: false,
      breakpoints: false,
      stdin: false,
      graphics: false,
    },
    events,
    prepare: () => Promise.resolve({ success: true, errors: [] }),
    start: () => Promise.resolve(),
    stop: () => undefined,
    setBreakpoints: () => Promise.resolve(),
    stepInto: () => Promise.resolve(),
    stepOver: () => Promise.resolve(),
    stepOut: () => Promise.resolve(),
    continueExecution: () => Promise.resolve(),
  } satisfies RuntimeSession

  return { session, stdout: events.stdout }
}

interface HostActivityPluginOptions {
  namespace: string
  resourcePath: string
  resourceContents: string
  surface: 'toolbar'
  onRuntimeOutput(text: string): void
  onPanelRender(runtimeId: string, files: Record<string, string>): void
}

function createHostActivityPlugin({
  namespace,
  resourcePath,
  resourceContents,
  surface,
  onRuntimeOutput,
  onPanelRender,
}: HostActivityPluginOptions): IDEPlugin {
  const panelId = `${namespace}.panel`

  return {
    id: `${namespace}.plugin`,
    contributes: {
      panels: [
        {
          id: panelId,
          title: 'Host Activity',
          component: ({ runtime, workspace }) => {
            onPanelRender(runtime.id, workspace.snapshot())
            return null
          },
        },
      ],
      commands: [
        {
          id: `${namespace}.open`,
          title: 'Open Host Activity',
          surface,
          execute(context) {
            context.panels.reveal(panelId)
          },
        },
      ],
      resources: [
        {
          id: `${namespace}.resources`,
          files: { [resourcePath]: resourceContents },
        },
      ],
    },
    activate(context) {
      if (!context.runtime) throw new Error('This activity requires a runtime')

      context.register(
        context.runtime.events.stdout.subscribe((text) => {
          onRuntimeOutput(text)
        }),
      )
    },
  }
}

describe('host-authored Web IDE plugins', () => {
  it('lets each host provide, omit, or substitute a custom activity through only public plugin seams', async () => {
    const runtimeOutput = vi.fn<(text: string) => void>()
    const replacementRuntimeOutput = vi.fn<(text: string) => void>()
    const panelRender = vi.fn<
      (runtimeId: string, files: Record<string, string>) => void
    >()
    const replacementPanelRender = vi.fn<
      (runtimeId: string, files: Record<string, string>) => void
    >()
    const customPlugin = createHostActivityPlugin({
      namespace: 'example.activity',
      resourcePath: '/activities/example/guide.txt',
      resourceContents: 'A resource bundled by the consuming application.',
      surface: 'toolbar',
      onRuntimeOutput: runtimeOutput,
      onPanelRender: panelRender,
    })
    const replacementPlugin = createHostActivityPlugin({
      namespace: 'host.replacement',
      resourcePath: '/activities/replacement/instructions.txt',
      resourceContents: 'A different host-owned activity.',
      surface: 'toolbar',
      onRuntimeOutput: replacementRuntimeOutput,
      onPanelRender: replacementPanelRender,
    })
    const customManager = new IDEPluginManager([customPlugin])
    const omittedManager = new IDEPluginManager([])
    const replacementManager = new IDEPluginManager([replacementPlugin])
    const { session, stdout } = createFakeRuntime()

    try {
      expect(customManager.panels).not.toBe(replacementManager.panels)
      expect(customManager.panels.has('example.activity.panel')).toBe(true)
      expect(customManager.commands.get('example.activity.open')).toMatchObject({
        surface: 'toolbar',
      })
      expect(customManager.resources.get('example.activity.resources')?.files).toEqual({
        '/activities/example/guide.txt':
          'A resource bundled by the consuming application.',
      })

      expect(omittedManager.panels.getSnapshot()).toEqual([])
      expect(omittedManager.commands.getSnapshot()).toEqual([])
      expect(omittedManager.resources.getSnapshot()).toEqual([])

      expect(replacementManager.panels.has('example.activity.panel')).toBe(false)
      expect(replacementManager.panels.has('host.replacement.panel')).toBe(true)
      expect(replacementManager.commands.get('host.replacement.open')).toMatchObject({
        surface: 'toolbar',
      })
      expect(
        replacementManager.resources.get('host.replacement.resources')?.files,
      ).toEqual({
        '/activities/replacement/instructions.txt':
          'A different host-owned activity.',
      })

      const start = vi.fn<IDECommandContext['execution']['start']>()
      const stop = vi.fn<IDECommandContext['execution']['stop']>()
      const restart = vi.fn<IDECommandContext['execution']['restart']>()
      const snapshot = vi
        .fn<IDECommandContext['workspace']['snapshot']>()
        .mockReturnValue({})
      const reveal = vi.fn<IDECommandContext['panels']['reveal']>()
      const commandContext = Object.freeze({
        execution: Object.freeze({ start, stop, restart }),
        workspace: Object.freeze({ snapshot }),
        panels: Object.freeze({ reveal }),
      }) satisfies IDECommandContext
      const openActivity = customManager.commands.get('example.activity.open')

      expect(reveal).not.toHaveBeenCalled()
      await openActivity?.execute(commandContext)
      expect(reveal).toHaveBeenCalledExactlyOnceWith('example.activity.panel')
      expect(start).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      expect(restart).not.toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()

      const ActivityPanel = customManager.panels.get(
        'example.activity.panel',
      )?.component
      expect(ActivityPanel).toBeDefined()
      renderToStaticMarkup(
        createElement(ActivityPanel!, {
          runtime: session,
          workspace: { snapshot: () => ({ '/workspace/main.txt': 'host data' }) },
          panels: { reveal },
        }),
      )
      expect(panelRender).toHaveBeenCalledExactlyOnceWith(
        'host.fake-runtime',
        { '/workspace/main.txt': 'host data' },
      )
      expect(replacementPanelRender).not.toHaveBeenCalled()

      const activation = customManager.activate({ runtime: session })
      stdout.emit('first typed runtime message')
      expect(runtimeOutput).toHaveBeenCalledExactlyOnceWith(
        'first typed runtime message',
      )

      activation.dispose()
      stdout.emit('ignored after plugin deactivation')
      expect(runtimeOutput).toHaveBeenCalledTimes(1)

      customManager.dispose()
      expect(replacementManager.panels.has('host.replacement.panel')).toBe(true)
      expect(replacementRuntimeOutput).not.toHaveBeenCalled()
    } finally {
      customManager.dispose()
      omittedManager.dispose()
      replacementManager.dispose()
    }
  })
})

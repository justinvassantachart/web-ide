import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const selectPanel = vi.fn()
  const setActiveView = vi.fn()
  const execution = Object.freeze({
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  })
  return {
    activities: [] as Array<Record<string, unknown>>,
    commands: [] as Array<Record<string, unknown>>,
    panels: [] as Array<Record<string, unknown>>,
    execution,
    runtime: {
      id: 'runtime.instance',
      capabilities: {
        debug: true,
        breakpoints: true,
        stdin: true,
        graphics: false,
      },
    },
    setActiveView,
    selectPanel,
  }
})

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
}))

vi.mock('@/engine/engine-context', () => ({
  useEngine: () => harness.runtime,
}))

vi.mock('@/components/layout/use-run-pipeline', () => ({
  useRunPipeline: () => ({ execution: harness.execution }),
}))

vi.mock('@/web-ide/react/contribution-context', () => ({
  useIDEActivities: () => harness.activities,
  useIDECommands: () => harness.commands,
  useIDEPanels: () => harness.panels,
}))

vi.mock('@/store/execution-store', () => ({
  useExecutionStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      setIsRunning: vi.fn(),
      isCompiling: false,
      isRunning: false,
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/web-ide/react/panel-layout-context', () => ({
  usePanelLayout: () => ({
    controller: {
      domIdPrefix: 'contract-panel',
      initialSelectedPanelId: 'host.panel',
      assertInitialPanelAvailable: vi.fn(),
      selectPanel: harness.selectPanel,
    },
    initialLayout: {
      panelColumnPercent: 27,
      panelContentPercent: 70,
    },
    selectedPanelId: 'host.panel',
  }),
}))

vi.mock('@/store/compiler-store', () => ({
  useCompilerStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { cacheState: 'ready', downloadProgress: 100 }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/debug-store', () => ({
  useDebugStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      debugMode: 'idle',
      pushHistoryState: vi.fn(),
      setDebugMode: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/testing/test-store', () => ({
  useTestStore: { getState: () => ({ finalize: vi.fn() }) },
}))

vi.mock('@/web-ide/react/host-context', () => ({
  useWebIDEHost: () => ({ chrome: { brand: false } }),
}))

vi.mock('@/web-ide/react/configuration-context', () => ({
  useWebIDEConfiguration: () => ({ brand: false }),
}))

vi.mock('@/testing/use-test-provider', () => ({
  useSelectedTestProvider: () => undefined,
}))

vi.mock('@/vfs/volume', () => ({
  getAllFiles: () => ({ '/workspace/main.py': 'print("instance")' }),
}))

vi.mock('@/components/sidebar/sidebar-store', () => ({
  useSidebarStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeView: 'host.activity',
      setActiveView: harness.setActiveView,
    }),
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: 'div',
  ResizablePanel: 'section',
  ResizablePanelGroup: 'main',
}))

vi.mock('@/components/terminal/Terminal', () => ({ Terminal: () => null }))
vi.mock('@/components/layout/SaveStatus', () => ({ SaveStatus: () => null }))
vi.mock('@/components/ui/button', () => ({ Button: 'button' }))
vi.mock('@/components/ui/codicon', () => ({ Codicon: () => null }))
vi.mock('@/components/ui/progress', () => ({ Progress: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: 'div',
  TooltipContent: 'div',
  TooltipTrigger: 'span',
}))

import { RightPanel } from '../../src/components/layout/RightPanel'
import { Toolbar } from '../../src/components/layout/Toolbar'
import { SidebarPanel } from '../../src/components/sidebar/SidebarPanel'
import { ContributionSurface } from '../../src/web-ide/react/ContributionSurface'

function findElement(
  node: ReactNode,
  type: ReactElement['type'],
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined
  if (node.type === type) return node
  return findElement(node.props.children as ReactNode, type)
}

beforeEach(() => {
  harness.activities.length = 0
  harness.commands.length = 0
  harness.panels.length = 0
  harness.setActiveView.mockClear()
  harness.selectPanel.mockClear()
})

describe('panel execution services', () => {
  it('uses the same controller object for toolbar command contributions', () => {
    const execute = vi.fn()
    harness.commands.push({
      id: 'host.execute',
      title: 'Execute',
      surface: 'toolbar',
      execute,
    })

    const button = findElement(Toolbar(), 'button')
    expect(button).toBeDefined()
    ;(button?.props.onClick as () => void)()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((execute.mock.calls[0]?.[0] as { execution: unknown }).execution).toBe(
      harness.execution,
    )
  })

  it('passes the selected runtime pipeline to right-panel contributions', () => {
    const Panel = vi.fn(() => null)
    harness.panels.push({
      id: 'host.panel',
      title: 'Host panel',
      component: Panel,
    })

    const selected = findElement(RightPanel(), ContributionSurface)
    expect(selected).toBeDefined()
    expect(selected?.props.component).toBe(Panel)
    expect(selected?.props.runtime).toBe(harness.runtime)
    expect(selected?.props.execution).toBe(harness.execution)
    expect((selected?.props.snapshot as () => unknown)()).toEqual({
      '/workspace/main.py': 'print("instance")',
    })
    ;(selected?.props.revealPanel as (id: string) => void)('other.panel')
    expect(harness.selectPanel).toHaveBeenCalledExactlyOnceWith('other.panel')
  })

  it('passes the selected runtime pipeline to sidebar activity contributions', () => {
    const Activity = vi.fn(() => null)
    harness.activities.push({
      id: 'host.activity',
      title: 'Host activity',
      icon: 'extensions',
      component: Activity,
    })

    const selected = findElement(SidebarPanel(), ContributionSurface)
    expect(selected).toBeDefined()
    expect(selected?.props.component).toBe(Activity)
    expect(selected?.props.runtime).toBe(harness.runtime)
    expect(selected?.props.execution).toBe(harness.execution)
    expect((selected?.props.snapshot as () => unknown)()).toEqual({
      '/workspace/main.py': 'print("instance")',
    })
    ;(selected?.props.revealPanel as (id: string) => void)('other.panel')
    expect(harness.selectPanel).toHaveBeenCalledExactlyOnceWith('other.panel')
  })
})

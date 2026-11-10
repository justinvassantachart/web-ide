import { useCallback, useEffect, useRef, useState, useId } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toolbar } from '@/components/layout/Toolbar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GlobalHotkeys } from '@/components/layout/GlobalHotkeys'
import { HostEventBridge } from '@/components/layout/HostEventBridge'
import { ActivityBar } from '@/components/sidebar/ActivityBar'
import { SidebarPanel } from '@/components/sidebar/SidebarPanel'
import { EditorTerminalPanel } from '@/components/layout/EditorTerminalPanel'
import { RightPanel } from '@/components/layout/RightPanel'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useWebIDEHost } from './host-context'
import { useWebIDEConfiguration } from './configuration-context'
import { usePanelLayout } from './panel-layout-context'
import '@/components/sidebar/sidebar.css'
import { useSidebarLayout } from './sidebar-layout-context'
import { useWorkbenchTheme } from './use-workbench-theme'
import { useWorkbenchInstance } from './workbench-instance-context'
import { useSourcePresentationState } from './source-presentation-state'

/** Reusable workbench UI. Runtime and contribution providers sit above it. */
export function WorkbenchLayout() {
  const host = useWebIDEHost()
  const configuration = useWebIDEConfiguration()
  const { initialLayout } = usePanelLayout()
  const { snapshot: sidebarLayout } = useSidebarLayout()
  const instance = useWorkbenchInstance()
  const { theme } = useWorkbenchTheme()
  const root = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  const { revealRequest } = useSourcePresentationState()
  const revealSequence = revealRequest?.sequence ?? 0
  const [compactSelection, setCompactSelection] = useState({ view: 'code', revealSequence })
  // An explicit source request must expose Code in the same render in which
  // the editor focuses its target. Choosing another pane acknowledges that
  // sequence; unrelated decoration changes cannot steal the user's view.
  const compactView = compactSelection.revealSequence === revealSequence ? compactSelection.view : 'code'
  const setCompactView = (view: string) => setCompactSelection({ view, revealSequence })
  const compactId = useId()
  const responsive = configuration.responsive
  const breakpoint = responsive === false ? 0 : responsive?.breakpoint ?? 900
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < breakpoint))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [breakpoint])
  const setRootElement = useCallback((element: HTMLDivElement | null) => {
    root.current = element
    instance.setRootElement(element)
  }, [instance])
  const sidebarCollapsed = sidebarLayout.collapsed
  const chromeSidebar = host?.chrome?.sidebar !== false
  const chromeStatusBar = host?.chrome?.statusBar !== false
  const sidebarVisible = chromeSidebar && (!sidebarCollapsed || compact)
  const customPanelColumn = configuration.initialLayout?.panelColumnPercent !== undefined
  const editorColumnPercent = customPanelColumn
    ? 100 - initialLayout.panelColumnPercent - (sidebarVisible ? 18 : 0)
    : 55

  useEffect(() => {
    if (configuration.reloadWhenNotIsolated && !window.crossOriginIsolated) {
      window.location.reload()
    }
  }, [configuration.reloadWhenNotIsolated])

  return (
    <TooltipProvider delayDuration={300}>
      <GlobalHotkeys />
      <HostEventBridge />
      <div
        ref={setRootElement}
        tabIndex={-1}
        data-theme={theme}
        data-compact-view={compact ? compactView : undefined}
        className="web-ide-root flex flex-col h-full w-full overflow-hidden"
      >
        <Toolbar />
        {compact && <div className="web-ide-compact-nav" role="tablist" aria-label="Workbench views">
          {[...(chromeSidebar ? [['workspace', 'Workspace']] : []), ['code', 'Code'], ['output', 'Output']].map(([id, label]) =>
            <button key={id} type="button" role="tab" id={`${compactId}-${id}-tab`}
              aria-selected={compactView === id} aria-controls={`${compactId}-${id}`}
              tabIndex={compactView === id ? 0 : -1} onClick={() => setCompactView(id)}
              onKeyDown={(event) => {
                const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
                const index = tabs.indexOf(event.currentTarget)
                const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
                if (next !== undefined) { event.preventDefault(); tabs[next].click(); tabs[next].focus() }
              }}>{label}</button>)}
        </div>}
        <div className="flex-1 min-h-0 flex">
          {chromeSidebar && <ActivityBar onSelect={compact ? () => setCompactView('workspace') : undefined} />}
          <ResizablePanelGroup
            orientation="horizontal"
            className="flex-1 min-h-0"
          >
            {sidebarVisible && (
              <>
                <ResizablePanel
                  id="sidebar"
                  defaultSize="18"
                  minSize="10"
                  maxSize="40"
                  data-web-ide-region="sidebar-column"
                >
                  <div className="h-full" id={`${compactId}-workspace`}><SidebarPanel /></div>
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}

            <ResizablePanel
              key="editor"
              id="editor"
              defaultSize={`${editorColumnPercent}`}
              minSize="25"
              data-web-ide-region="editor-column"
            >
              <div className="h-full" id={`${compactId}-code`}><EditorTerminalPanel /></div>
            </ResizablePanel>

            <ResizableHandle key="right-separator" />

            <ResizablePanel
              key="right"
              id="right"
              defaultSize={`${initialLayout.panelColumnPercent}`}
              minSize="15"
              data-web-ide-region="panel-column"
            >
              <div className="h-full" id={`${compactId}-output`}><RightPanel /></div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        {chromeStatusBar && <StatusBar />}
      </div>
    </TooltipProvider>
  )
}

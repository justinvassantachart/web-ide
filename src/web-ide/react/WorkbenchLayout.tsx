import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toolbar } from '@/components/layout/Toolbar'
import { StatusBar } from '@/components/layout/StatusBar'
import { GlobalHotkeys } from '@/components/layout/GlobalHotkeys'
import { HostEventBridge } from '@/components/layout/HostEventBridge'
import { ActivityBar } from '@/components/sidebar/ActivityBar'
import { SidebarPanel } from '@/components/sidebar/SidebarPanel'
import { useSidebarStore } from '@/components/sidebar/sidebar-store'
import { Editor } from '@/components/editor/Editor'
import { RightPanel } from '@/components/layout/RightPanel'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useWebIDEHost } from './host-context'
import { useWebIDEConfiguration } from './configuration-context'
import '@/components/sidebar/sidebar.css'

/** Reusable workbench UI. Runtime and contribution providers sit above it. */
export function WorkbenchLayout() {
  const host = useWebIDEHost()
  const configuration = useWebIDEConfiguration()
  const sidebarCollapsed = useSidebarStore((state) => state.collapsed)
  const chromeSidebar = host?.chrome?.sidebar !== false
  const chromeStatusBar = host?.chrome?.statusBar !== false
  const sidebarVisible = chromeSidebar && !sidebarCollapsed

  useEffect(() => {
    if (configuration.reloadWhenNotIsolated && !window.crossOriginIsolated) {
      window.location.reload()
    }
  }, [configuration.reloadWhenNotIsolated])

  return (
    <TooltipProvider delayDuration={300}>
      <GlobalHotkeys />
      <HostEventBridge />
      <div className="web-ide-root flex flex-col h-full w-full overflow-hidden">
        <Toolbar />
        <div className="flex-1 min-h-0 flex">
          {chromeSidebar && <ActivityBar />}
          <ResizablePanelGroup
            key={sidebarVisible ? 'with-sidebar' : 'no-sidebar'}
            orientation="horizontal"
            className="flex-1 min-h-0"
          >
            {sidebarVisible && (
              <>
                <ResizablePanel id="sidebar" defaultSize="18" minSize="10" maxSize="40">
                  <SidebarPanel />
                </ResizablePanel>
                <ResizableHandle withHandle />
              </>
            )}

            <ResizablePanel id="editor" defaultSize="55" minSize="25">
              <Editor />
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel id="right" defaultSize="27" minSize="15">
              <RightPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        {chromeStatusBar && <StatusBar />}
      </div>
    </TooltipProvider>
  )
}

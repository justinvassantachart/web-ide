import { useEffect } from 'react'
import { useExecutionStore } from '@/store/execution-store'
import { useCompilerStore } from '@/store/compiler-store'
import { useDebugStore } from '@/store/debug-store'
import { Terminal } from '@/components/terminal/Terminal'
import { useIDEPanels } from '@/web-ide/react/contribution-context'
import { useEngine } from '@/engine/engine-context'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { getAllFiles } from '@/vfs/volume'
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/components/ui/resizable'

export function RightPanel() {
    const runtime = useEngine()
    const {
        rightTab: activeTab,
        setRightTab: setActiveTab,
        isCompiling,
        isRunning,
    } = useExecutionStore()
    const compilerReady = useCompilerStore(({ cacheState }) => cacheState === 'ready')
    const debugMode = useDebugStore(({ debugMode: mode }) => mode)
    const testProvider = useSelectedTestProvider()
    const panels = useIDEPanels().filter((panel) => panel.when?.({
        runState: debugMode === 'paused' ? 'paused' : isRunning ? 'running' : 'idle',
        isCompiling,
        runtimeReady: compilerReady,
        runtimeCapabilities: runtime.capabilities,
        testingAvailable: testProvider !== undefined,
    }) ?? true)
    const selected = panels.find((panel) => panel.id === activeTab) ?? panels[0]
    const SelectedPanel = selected?.component

    useEffect(() => {
        if (selected && selected.id !== activeTab) setActiveTab(selected.id)
    }, [activeTab, selected, setActiveTab])

    return (
        <ResizablePanelGroup orientation="vertical" className="h-full">
            <ResizablePanel defaultSize="70" minSize="25">
                <div className="flex flex-col h-full bg-background">
                    <div className="flex border-b border-border bg-[var(--color-chrome)] h-9 px-1 items-stretch">
                        {panels.map((panel) => (
                            <button
                                key={panel.id}
                                onClick={() => setActiveTab(panel.id)}
                                className={`relative px-4 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                                    selected?.id === panel.id
                                        ? 'text-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {panel.title}
                                {selected?.id === panel.id && (
                                    <span className="absolute left-2 right-2 -bottom-px h-[2px] bg-primary rounded-full" />
                                )}
                            </button>
                        ))}
                    </div>

                    <div className="flex-1 min-h-0 overflow-hidden">
                        {SelectedPanel && (
                            <SelectedPanel
                                runtime={runtime}
                                workspace={{ snapshot: getAllFiles }}
                                panels={{ reveal: setActiveTab }}
                            />
                        )}
                    </div>
                </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize="30" minSize="10">
                <div className="h-full flex flex-col bg-background">
                    <div className="nova-panel-header">
                        <span className="nova-panel-label">Terminal</span>
                    </div>
                    <div className="flex-1 min-h-0">
                        <Terminal />
                    </div>
                </div>
            </ResizablePanel>
        </ResizablePanelGroup>
    )
}

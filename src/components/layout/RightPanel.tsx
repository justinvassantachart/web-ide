import { useEffect, type KeyboardEvent } from 'react'
import { useExecutionStore } from '@/store/execution-store'
import { useCompilerStore } from '@/store/compiler-store'
import { useDebugStore } from '@/store/debug-store'
import { Terminal } from '@/components/terminal/Terminal'
import { useIDEPanels } from '@/web-ide/react/contribution-context'
import { useEngine } from '@/engine/engine-context'
import { useSelectedTestProvider } from '@/testing/use-test-provider'
import { getAllFiles } from '@/vfs/volume'
import { useRunPipeline } from './use-run-pipeline'
import { ContributionSurface } from '@/web-ide/react/ContributionSurface'
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/components/ui/resizable'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'

export function RightPanel() {
    const runtime = useEngine()
    const { execution } = useRunPipeline()
    const { isCompiling, isRunning } = useExecutionStore()
    const {
        controller,
        initialLayout,
        selectedPanelId: activeTab,
    } = usePanelLayout()
    const setActiveTab = controller.selectPanel
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
    controller.assertInitialPanelAvailable(panels.map(({ id }) => id))
    const selected = panels.find((panel) => panel.id === activeTab) ?? panels[0]
    const SelectedPanel = selected?.component

    useEffect(() => {
        if (selected && selected.id !== activeTab) setActiveTab(selected.id)
    }, [activeTab, selected, setActiveTab])

    const selectFromKeyboard = (
        event: KeyboardEvent<HTMLButtonElement>,
        panelIndex: number,
    ) => {
        let nextIndex: number | undefined
        if (event.key === 'ArrowRight') nextIndex = (panelIndex + 1) % panels.length
        if (event.key === 'ArrowLeft') nextIndex = (panelIndex - 1 + panels.length) % panels.length
        if (event.key === 'Home') nextIndex = 0
        if (event.key === 'End') nextIndex = panels.length - 1
        if (nextIndex === undefined) return
        event.preventDefault()
        const nextPanel = panels[nextIndex]
        if (!nextPanel) return
        setActiveTab(nextPanel.id)
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
        )
        tabs?.[nextIndex]?.focus()
    }

    return (
        <ResizablePanelGroup orientation="vertical" className="h-full">
            <ResizablePanel
                defaultSize={`${initialLayout.panelContentPercent}`}
                minSize="25"
                data-web-ide-region="panel-content"
            >
                <div className="flex flex-col h-full bg-background">
                    <div
                        className="flex border-b border-border bg-[var(--color-chrome)] h-9 px-1 items-stretch"
                        role="tablist"
                        aria-label="Workbench panels"
                    >
                        {panels.map((panel, panelIndex) => {
                            const isSelected = selected?.id === panel.id
                            const tabId = `${controller.domIdPrefix}-tab-${panelIndex}`
                            const panelId = `${controller.domIdPrefix}-tabpanel-${panelIndex}`
                            return (
                            <button
                                key={panel.id}
                                type="button"
                                id={tabId}
                                role="tab"
                                aria-selected={isSelected}
                                aria-controls={panelId}
                                tabIndex={isSelected ? 0 : -1}
                                onClick={() => setActiveTab(panel.id)}
                                onKeyDown={(event) => selectFromKeyboard(event, panelIndex)}
                                className={`relative px-4 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                                    isSelected
                                        ? 'text-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {panel.title}
                                {isSelected && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute left-2 right-2 -bottom-px h-[2px] bg-primary rounded-full"
                                    />
                                )}
                            </button>
                            )
                        })}
                    </div>

                    <div
                        id={selected
                            ? `${controller.domIdPrefix}-tabpanel-${panels.indexOf(selected)}`
                            : undefined}
                        role="tabpanel"
                        aria-labelledby={selected
                            ? `${controller.domIdPrefix}-tab-${panels.indexOf(selected)}`
                            : undefined}
                        tabIndex={selected ? 0 : undefined}
                        className="flex-1 min-h-0 overflow-hidden"
                    >
                        {SelectedPanel && selected && (
                            <ContributionSurface
                                key={selected.id}
                                component={SelectedPanel}
                                runtime={runtime}
                                execution={execution}
                                snapshot={getAllFiles}
                                revealPanel={setActiveTab}
                            />
                        )}
                    </div>
                </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel
                defaultSize={`${100 - initialLayout.panelContentPercent}`}
                minSize="10"
                data-web-ide-region="terminal-content"
            >
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

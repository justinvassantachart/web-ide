import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { GroupImperativeHandle } from 'react-resizable-panels'
import { Editor } from '@/components/editor/Editor'
import { Terminal, type TerminalHandle } from '@/components/terminal/Terminal'
import { Codicon } from '@/components/ui/codicon'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'
import './terminal-panel.css'

type TerminalPanelMode = 'normal' | 'hidden' | 'maximized'

/** The editor and its one runtime terminal stay mounted across layout changes. */
export function EditorTerminalPanel() {
    const { initialLayout } = usePanelLayout()
    const container = useRef<HTMLDivElement>(null)
    const group = useRef<GroupImperativeHandle>(null)
    const terminal = useRef<TerminalHandle>(null)
    const editor = useRef<HTMLDivElement>(null)
    const editorPanel = useRef<HTMLDivElement>(null)
    const terminalPanel = useRef<HTMLDivElement>(null)
    const separator = useRef<HTMLDivElement>(null)
    const [mode, setMode] = useState<TerminalPanelMode>('normal')
    const normalEditorPercent = useRef(initialLayout.panelContentPercent)
    const pendingFocus = useRef<'editor' | 'terminal' | undefined>(undefined)
    const panelId = useId()
    const tabId = `${panelId}-tab`

    const restore = useCallback(() => {
        pendingFocus.current = 'terminal'
        group.current?.setLayout({
            source: normalEditorPercent.current,
            terminal: 100 - normalEditorPercent.current,
        })
    }, [])

    const hide = useCallback(() => {
        pendingFocus.current = 'editor'
        group.current?.setLayout({ source: 100, terminal: 0 })
    }, [])

    useLayoutEffect(() => {
        // Apply the native property through public element refs so React 18
        // also excludes the panel's scrollable wrapper from keyboard/AT focus.
        if (editorPanel.current) editorPanel.current.inert = mode === 'maximized'
        if (terminalPanel.current) terminalPanel.current.inert = mode === 'hidden'
        if (pendingFocus.current === 'terminal' && mode !== 'hidden') terminal.current?.focus()
        // Never leave keyboard focus inside a collapsed terminal.
        if (pendingFocus.current === 'editor' && mode !== 'maximized') {
            editor.current?.querySelector<HTMLElement>('[role="textbox"], textarea')?.focus()
            if (!editor.current?.contains(document.activeElement)) editor.current?.focus()
        }
        pendingFocus.current = undefined
    }, [mode])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
                || (event.code !== 'Backquote' && event.key !== '`')) return
            const root = container.current?.closest('.web-ide-root')
            if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return
            event.preventDefault()
            event.stopPropagation()
            if (group.current?.getLayout().terminal === 0) restore()
            else hide()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [hide, restore])

    return (
        <div ref={container} className="web-ide-editor-terminal" data-terminal-state={mode}>
            <ResizablePanelGroup
                orientation="vertical"
                groupRef={group}
                onLayoutChanged={(layout) => {
                    if (!Number.isFinite(layout.source) || !Number.isFinite(layout.terminal)) return
                    const nextMode = layout.terminal === 0 ? 'hidden'
                        : layout.source === 0 ? 'maximized' : 'normal'
                    if (nextMode !== 'normal') {
                        const collapsedPanel = nextMode === 'hidden' ? terminalPanel : editorPanel
                        if (document.activeElement === separator.current
                            || collapsedPanel.current?.contains(document.activeElement)) {
                            pendingFocus.current = nextMode === 'hidden' ? 'editor' : 'terminal'
                        }
                        setMode(nextMode)
                    } else {
                        normalEditorPercent.current = layout.source
                        setMode('normal')
                    }
                }}
            >
                <ResizablePanel
                    id="source"
                    elementRef={editorPanel}
                    aria-hidden={mode === 'maximized'}
                    defaultSize={`${initialLayout.panelContentPercent}%`}
                    minSize="25%"
                    collapsible
                    collapsedSize="0%"
                    data-web-ide-region="editor-content"
                >
                    <div ref={editor} className="h-full" tabIndex={-1} aria-hidden={mode === 'maximized'} style={{ visibility: mode === 'maximized' ? 'hidden' : undefined }}>
                        <Editor />
                    </div>
                </ResizablePanel>
                <ResizableHandle
                    aria-label="Resize terminal panel"
                    elementRef={separator}
                    className="web-ide-terminal-separator"
                    disabled={mode !== 'normal'}
                />
                <ResizablePanel
                    id="terminal"
                    elementRef={terminalPanel}
                    aria-hidden={mode === 'hidden'}
                    defaultSize={`${100 - initialLayout.panelContentPercent}%`}
                    minSize="10%"
                    collapsible
                    collapsedSize="0%"
                    data-web-ide-region="terminal-content"
                >
                    <section className="web-ide-terminal-panel" aria-label="Terminal panel" aria-hidden={mode === 'hidden'} style={{ visibility: mode === 'hidden' ? 'hidden' : undefined }}>
                        <div className="web-ide-terminal-header">
                            <div role="tablist" aria-label="Terminal panels" className="web-ide-terminal-tabs">
                                <button
                                    id={tabId}
                                    role="tab"
                                    type="button"
                                    aria-selected="true"
                                    aria-controls={panelId}
                                    className="web-ide-terminal-tab"
                                    onClick={() => terminal.current?.focus()}
                                >Terminal</button>
                            </div>
                            <div className="web-ide-terminal-actions">
                                <button type="button" aria-label="Clear terminal" title="Clear Terminal" onClick={() => terminal.current?.clear()}>
                                    <Codicon name="clear-all" />
                                </button>
                                <button
                                    type="button"
                                    aria-label={mode === 'maximized' ? 'Restore terminal panel' : 'Maximize terminal panel'}
                                    title={mode === 'maximized' ? 'Restore Panel Size' : 'Maximize Panel Size'}
                                    aria-pressed={mode === 'maximized'}
                                    onClick={() => {
                                        if (mode === 'maximized') restore()
                                        else group.current?.setLayout({ source: 0, terminal: 100 })
                                    }}
                                >
                                    <Codicon name={mode === 'maximized' ? 'screen-normal' : 'screen-full'} />
                                </button>
                                <button type="button" aria-label="Hide terminal panel" title="Hide Panel (Ctrl+`)" onClick={hide}>
                                    <Codicon name="close" />
                                </button>
                            </div>
                        </div>
                        <div id={panelId} role="tabpanel" aria-labelledby={tabId} className="web-ide-terminal-body">
                            <Terminal ref={terminal} />
                        </div>
                    </section>
                </ResizablePanel>
            </ResizablePanelGroup>
            {mode === 'hidden' && (
                <button className="web-ide-terminal-reopen" type="button" aria-label="Show terminal panel" title="Show Terminal (Ctrl+`)" onClick={restore}>
                    <Codicon name="terminal" />
                    <span>Terminal</span>
                </button>
            )}
        </div>
    )
}

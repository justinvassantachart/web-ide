// VS Code-style status bar: 22px strip across the bottom of the IDE.
// Blue while editing, orange (statusBar.debuggingBackground) while a debug
// session is live — the same at-a-glance signal VS Code users rely on.

import { Codicon } from '@/components/ui/codicon'
import { useDebugStore } from '@/store/debug-store'
import { useExecutionStore } from '@/store/execution-store'
import { useEditorStore } from '@/store/editor-store'
import { monacoLanguageLabelForPath } from '@/web-ide/core/monaco-language'

export function StatusBar() {
    const { debugMode, currentLine, currentFile } = useDebugStore()
    const isRunning = useExecutionStore((s) => s.isRunning)
    const isCompiling = useExecutionStore((s) => s.isCompiling)
    const { activeFile, cursorLine, cursorColumn } = useEditorStore()
    const languageLabel = activeFile
        ? monacoLanguageLabelForPath(activeFile)
        : undefined

    const debugging = debugMode === 'paused' || debugMode === 'running'

    let stateIcon = 'check'
    let stateText = 'Ready'
    if (isCompiling) { stateIcon = 'loading'; stateText = 'Compiling…' }
    else if (debugMode === 'paused') {
        stateIcon = 'debug-pause'
        stateText = `Paused at ${currentFile?.split('/').pop() ?? '?'}:${currentLine ?? '?'}`
    }
    else if (debugging) { stateIcon = 'debug-alt'; stateText = 'Debugging' }
    else if (isRunning) { stateIcon = 'play'; stateText = 'Running' }

    return (
        <footer className={`nova-status-bar${debugging ? ' debugging' : ''}`} aria-label="Status bar">
            <div className="nova-status-group">
                <span className="nova-status-item">
                    <Codicon name={stateIcon} size={13} spin={isCompiling} />
                    {stateText}
                </span>
            </div>
            <div className="nova-status-group">
                {activeFile && (
                    <span className="nova-status-item">
                        Ln {cursorLine}, Col {cursorColumn}
                    </span>
                )}
                <span className="nova-status-item">Spaces: 4</span>
                {languageLabel && (
                    <span className="nova-status-item">{languageLabel}</span>
                )}
            </div>
        </footer>
    )
}

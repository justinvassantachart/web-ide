// VS Code-style editor tab strip. Files auto-save on every keystroke, so
// there is no dirty-dot state — every tab just shows icon · name · close.
// Middle-click closes a tab, like VS Code.

import { useEditorStore } from '@/store/editor-store'
import { readFile } from '@/vfs/volume'
import { getFileIconUrl } from '@/lib/vscode-icons'
import { Codicon } from '@/components/ui/codicon'

export function EditorTabs() {
    const { openFiles, activeFile, setActiveFile, closeFile } = useEditorStore()

    if (openFiles.length === 0) return null

    return (
        <div className="nova-tab-strip" role="tablist" aria-label="Open editors">
            {openFiles.map((path) => {
                const name = path.split('/').pop() ?? path
                const active = path === activeFile
                return (
                    <div
                        key={path}
                        role="tab"
                        aria-selected={active}
                        title={path.replace('/workspace/', '')}
                        className={`nova-tab${active ? ' active' : ''}`}
                        onClick={() => {
                            if (!active) setActiveFile(path, readFile(path) ?? '')
                        }}
                        onAuxClick={(e) => {
                            if (e.button === 1) closeFile(path, readFile)
                        }}
                    >
                        <img src={getFileIconUrl(name)} className="h-4 w-4" alt="" draggable={false} />
                        <span className="nova-tab-label">{name}</span>
                        <button
                            type="button"
                            aria-label={`Close ${name}`}
                            className="nova-tab-close"
                            onClick={(e) => {
                                e.stopPropagation()
                                closeFile(path, readFile)
                            }}
                        >
                            <Codicon name="close" size={14} />
                        </button>
                    </div>
                )
            })}
        </div>
    )
}

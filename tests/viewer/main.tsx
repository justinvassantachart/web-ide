import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type * as Monaco from 'monaco-editor'
import { WebIDE, WebIDEHostProvider, type WebIDEInstanceHandle, type IDEPlugin, type IDEPanelServices } from 'web-ide'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import { pythonRuntimePlugin } from 'web-ide/runtimes'
import 'web-ide/styles.css'

declare global {
    interface Window {
        monaco: typeof Monaco
        monacoReady: Promise<void>
        reactCommits: number
        viewer: typeof viewer
    }
}

await window.monacoReady
const monaco = window.monaco
const editors = new Map<number, Monaco.editor.IStandaloneCodeEditor>()
const nodes: HTMLElement[] = []
const counts = { editorCreates: 0, editorDisposes: 0, modelCreates: 0, modelDisposes: 0, flushes: 0, domRemovals: 0, renders: 0 }
const originalCreate = monaco.editor.create
monaco.editor.create = (...args) => {
    const editor = originalCreate(...args)
    const index = Number(args[0].closest('[data-instance]')?.getAttribute('data-instance'))
    editors.set(index, editor)
    counts.editorCreates++
    editor.onDidDispose(() => { counts.editorDisposes++; editors.delete(index) })
    return editor
}
monaco.editor.onDidCreateModel(model => {
    counts.modelCreates++
    model.onWillDispose(() => counts.modelDisposes++)
    model.onDidChangeContent(event => { if (event.isFlush) counts.flushes++ })
})
new MutationObserver(records => {
    for (const record of records) for (const removed of record.removedNodes) {
        if (nodes.some(node => removed === node || removed.contains(node))) counts.domRemovals++
    }
}).observe(document.getElementById('root')!, { subtree: true, childList: true })

const initialFiles = Object.fromEntries(['a.py', 'b.py', 'c.py'].map(name => [`/workspace/${name}`,
    Array.from({ length: 1000 }, (_, i) => `# ${name} line ${String(i + 1).padStart(4, '0')} ${'0123456789'.repeat(20)}`).join('\n')]))
export function SourceProbe({ source, runtime }: IDEPanelServices) {
    return <div>
        <button onClick={() => source.reveal({ path: '/workspace/a.py', line: 25, column: 3 })}>Reveal a.py line 25</button>
        <button onClick={() => runtime.writeStdin?.('continue\n')}>Send input</button>
    </div>
}
const probe: IDEPlugin = { id: 'viewer.probe', contributes: { activities: [{ id: 'viewer.probe.activity', title: 'Source navigation probe', icon: 'file', component: SourceProbe }] } }
const configuration = { runtimeProvider: 'web-ide.runtime.python', plugins: [pythonRuntimePlugin, coreWorkbenchPlugin, probe], brand: false as const }
const params = new URLSearchParams(location.search)
const size = params.has('two') ? 2 : 1
const refs = Array.from({ length: size }, () => createRef<WebIDEInstanceHandle>())
const subscriptions: Array<(() => void) | undefined> = []
const feed: Array<{ instance: number; origin: string; revision: number }> = []
const editEvents: unknown[] = []
const executionEvents: string[] = []
let output = ""
const viewer = {
    counts, initialFiles, feed, editEvents, executionEvents,
    output: () => output,
    handle(index = 0) { const handle = refs[index].current; if (!handle) throw new Error('Instance not mounted'); return handle },
    editor(index = 0) { const editor = editors.get(index); if (!editor) throw new Error('Editor not mounted'); return editor },
    measure(index = 0) {
        const editor = this.editor(index), model = editor.getModel()!, node = editor.getDomNode()!
        if (!nodes.includes(node)) nodes.push(node)
        const visible = editor.getVisibleRanges()
        return { ...counts, renders: window.reactCommits, editorId: editor.getId(), modelId: model.id, modelVersion: model.getVersionId(),
            domNodeId: nodes.indexOf(node), domConnected: node.isConnected,
            active: this.handle(index).snapshot().editor.activeFile,
            selections: editor.getSelections(), focus: editor.hasTextFocus(),
            scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft(),
            topSource: visible[0] ? model.getLineContent(visible[0].startLineNumber) : null }
    },
    async apply(files: Record<string, string>, index = 0) {
        const handle = this.handle(index)
        return handle.workspace.apply({ version: 1, kind: 'apply', transactionId: crypto.randomUUID(),
            expectedRevision: handle.workspace.revision(), origin: { kind: 'external-authority', source: 'packed-viewer-test' },
            operations: [{ op: 'replace', files }] })
    },
}
window.viewer = viewer
createRoot(document.getElementById('root')!).render(<>
    {refs.map((ref, index) => <div key={index} data-instance={index} style={{ width: `${100 / size}%`, height: '100%', display: 'inline-block' }}>
            <WebIDEHostProvider host={{ workspace: { id: `packed-${index}`, initialFiles, localCache: 'memory', readOnly: !params.has('editable') }, events: { includeRuntime: true, emit: (name, payload) => { if (name === 'edit') editEvents.push(payload); if (['run', 'program_exit', 'compile', 'compile_debug'].includes(name)) executionEvents.push(name); if (name === 'terminal_stdout' && 'text' in payload && typeof payload.text === 'string') output += payload.text } } }}>
                <WebIDE ref={handle => {
                    subscriptions[index]?.()
                    ref.current = handle
                    if (handle) subscriptions[index] = handle.workspace.subscribe(change => feed.push({ instance: index, origin: change.origin.kind, revision: change.revision }))
                }} configuration={configuration} />
            </WebIDEHostProvider>
    </div>)}
</>)

import { Volume } from 'memfs'
import { useFilesStore, type VFSNode } from '@/store/files-store'
import { useEditorStore } from '@/store/editor-store'
import { normalizeWorkspaceFiles } from '@/web-ide/core/workspace-path'

// ── Global Volume ──────────────────────────────────────────────
export const vol = new Volume()

// ── Templates ──────────────────────────────────────────────────
const DEFAULT_MAIN = `#include <iostream>

struct Node {
    int data;
    Node* next;
};

// Double every value in the list
void doubleValues(Node* head) {
    Node* current = head;
    while (current != nullptr) {
        current->data *= 2;
        current = current->next;
    }
}

int main() {
    // Build a linked list: 10 -> 20 -> 30
    Node* head = new Node{10, nullptr};
    head->next = new Node{20, nullptr};
    head->next->next = new Node{30, nullptr};

    // Print original values
    Node* current = head;
    while (current != nullptr) {
        std::cout << current->data << std::endl;
        current = current->next;
    }

    // Modify the list in a separate function (use "Step Into")
    doubleValues(head);

    // Print doubled values
    current = head;
    while (current != nullptr) {
        std::cout << current->data << std::endl;
        current = current->next;
    }

    // BUG: only free the head -- leak the rest!
    delete head;

    return 0;
}
`

// ── Current project ID ─────────────────────────────────────────
let activeProjectId = 'default-project'
let vfsInitGeneration = 0

export function getProjectId() { return activeProjectId }
export function setProjectId(id: string) { activeProjectId = id }

// ── Workspace-change emitter ───────────────────────────────────
// Generic subscription used by hosts (e.g. LMS submission auto-save)
// to observe /workspace mutations. Volume.ts knows nothing about
// hosts — just fires events on writes. Subscribers debounce as needed.
type WsListener = () => void
const wsListeners = new Set<WsListener>()
export function subscribeWorkspaceChange(fn: WsListener): () => void {
    wsListeners.add(fn)
    return () => wsListeners.delete(fn)
}
function notifyWorkspaceChange() {
    wsListeners.forEach((fn) => {
        try { fn() } catch (e) { console.warn('[vfs] workspace listener error', e) }
    })
}

// ── OPFS write coalescer ───────────────────────────────────────
// Editor keystrokes call writeFile() on every change. We don't want one
// OPFS round-trip per character — so each write schedules a coalesced
// flush per-path. Structural ops (create/delete/rename) cancel the
// pending flush and write through synchronously so the new state is
// persisted before anything queued by a previous edit can clobber it.
const FLUSH_DELAY_MS = 500
const pendingFlushes = new Map<string, ReturnType<typeof setTimeout>>()
let inFlightCount = 0
let externalPendingCount = 0

// "saved" → no queued local writes, no in-flight local writes, no host save in flight.
// "saving" → at least one local or host save is queued or in flight.
export type SaveState = 'saved' | 'saving'

const saveListeners = new Set<(state: SaveState) => void>()
export function subscribeSaveState(fn: (state: SaveState) => void): () => void {
    saveListeners.add(fn)
    return () => saveListeners.delete(fn)
}
export function getSaveState(): SaveState {
    return pendingFlushes.size === 0 && inFlightCount === 0 && externalPendingCount === 0
        ? 'saved'
        : 'saving'
}
export function hasPendingWrites(): boolean {
    return getSaveState() !== 'saved'
}
// Hosts call this to report their own pending work (e.g. remote persistence
// queued by onWorkspaceChange) so the indicator reflects end-to-end state.
export function markExternalSaving(active: boolean) {
    externalPendingCount += active ? 1 : -1
    if (externalPendingCount < 0) externalPendingCount = 0
    notifySaveState()
}

let lastNotified: SaveState = 'saved'
function notifySaveState() {
    const next = getSaveState()
    if (next === lastNotified) return
    lastNotified = next
    saveListeners.forEach((fn) => {
        try { fn(next) } catch (e) { console.warn('[vfs] save listener error', e) }
    })
}

function cancelPendingFlush(path: string) {
    const t = pendingFlushes.get(path)
    if (t) {
        clearTimeout(t)
        pendingFlushes.delete(path)
    }
}

function runOpfsWrite(projectId: string, path: string, content: string) {
    inFlightCount++
    notifySaveState()
    void import('./opfs-sync')
        .then(({ syncToOPFS }) => syncToOPFS(projectId, path, content))
        .finally(() => {
            inFlightCount = Math.max(0, inFlightCount - 1)
            notifySaveState()
        })
}

function scheduleOpfsWrite(path: string, content: string) {
    if (!path.startsWith('/workspace/') || !activeProjectId) return
    cancelPendingFlush(path)
    const projectId = activeProjectId
    const t = setTimeout(() => {
        pendingFlushes.delete(path)
        runOpfsWrite(projectId, path, content)
    }, FLUSH_DELAY_MS)
    pendingFlushes.set(path, t)
    notifySaveState()
}

function writeOpfsNow(path: string, content: string) {
    if (!path.startsWith('/workspace/') || !activeProjectId) return
    cancelPendingFlush(path)
    runOpfsWrite(activeProjectId, path, content)
}

// Force every queued write to fire now. Useful before navigation /
// project switch / explicit "save" so nothing sits in the debouncer.
export function flushPendingWrites() {
    if (pendingFlushes.size === 0) return
    const paths = [...pendingFlushes.keys()]
    for (const path of paths) {
        cancelPendingFlush(path)
        if (!vol.existsSync(path)) continue
        try {
            const content = vol.readFileSync(path, { encoding: 'utf8' }) as string
            writeOpfsNow(path, content)
        } catch { /* gone */ }
    }
}

// ── CRUD Operations ────────────────────────────────────────────
// writeFile is the hot path: every editor keystroke calls it. It updates
// memfs synchronously, schedules a debounced OPFS write, and fires the
// workspace-change event. createFile/createFolder/deleteItem/renameItem
// are the rare structural ops; they always sync OPFS immediately.

export function writeFile(path: string, content: string) {
    const dir = path.substring(0, path.lastIndexOf('/'))
    if (dir && !vol.existsSync(dir)) {
        vol.mkdirSync(dir, { recursive: true })
    }
    vol.writeFileSync(path, content, { encoding: 'utf8' })
    scheduleOpfsWrite(path, content)
    if (path.startsWith('/workspace/')) notifyWorkspaceChange()
}

export function readFile(path: string): string {
    return vol.readFileSync(path, { encoding: 'utf8' }) as string
}

export function createFile(path: string, content = '') {
    const dir = path.substring(0, path.lastIndexOf('/'))
    if (dir && !vol.existsSync(dir)) vol.mkdirSync(dir, { recursive: true })
    vol.writeFileSync(path, content, { encoding: 'utf8' })
    writeOpfsNow(path, content)
    refreshFileTree()
    if (path.startsWith('/workspace/')) notifyWorkspaceChange()
}

export function createFolder(path: string) {
    if (!vol.existsSync(path)) vol.mkdirSync(path, { recursive: true })
    if (path.startsWith('/workspace/') && activeProjectId) {
        const projectId = activeProjectId
        void import('./opfs-sync').then(({ createFolderInOPFS }) => createFolderInOPFS(projectId, path))
    }
    refreshFileTree()
}

export function deleteItem(path: string) {
    cancelPendingFlush(path)
    const stat = vol.statSync(path)
    if (stat.isDirectory()) {
        vol.rmdirSync(path, { recursive: true } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    } else {
        vol.unlinkSync(path)
    }
    if (activeProjectId) {
        const projectId = activeProjectId
        void import('./opfs-sync').then(({ deleteFromOPFS }) => deleteFromOPFS(projectId, path))
    }

    // Close the tab(s) for the deleted path. closeFile hands focus to the
    // neighboring tab; deleting a folder relies on the editor's workspace
    // sweep to prune any open descendants.
    useEditorStore.getState().closeFile(path, (p) => {
        try { return vol.readFileSync(p, { encoding: 'utf8' }) as string } catch { return null }
    })
    refreshFileTree()
    if (path.startsWith('/workspace/')) notifyWorkspaceChange()
}

export function renameItem(oldPath: string, newPath: string) {
    cancelPendingFlush(oldPath)
    vol.renameSync(oldPath, newPath)
    // Pass in-memory content as a fallback so files that were just created
    // (and never synced) still rename. Directories carry no content.
    let fallback: string | undefined
    try {
        if (!vol.statSync(newPath).isDirectory()) {
            fallback = vol.readFileSync(newPath, { encoding: 'utf8' }) as string
        }
    } catch { /* directory or unreadable */ }
    if (activeProjectId) {
        const projectId = activeProjectId
        void import('./opfs-sync').then(({ renameInOPFS }) => renameInOPFS(projectId, oldPath, newPath, fallback))
    }

    const { activeFile } = useEditorStore.getState()
    if (activeFile === oldPath) {
        useEditorStore.getState().setActiveFile(newPath, readFile(newPath))
    }
    refreshFileTree()
    if (oldPath.startsWith('/workspace/') || newPath.startsWith('/workspace/')) notifyWorkspaceChange()
}

export function fileExists(path: string): boolean {
    return vol.existsSync(path)
}

// ── Get all workspace files (for the runtime) ─────────────────

export function getAllFiles(): Record<string, string> {
    const result: Record<string, string> = {}
    function walk(dir: string) {
        const entries = vol.readdirSync(dir, { encoding: 'utf8' }) as string[]
        for (const entry of entries) {
            const full = dir === '/' ? `/ ${entry} ` : `${dir}/${entry}`
            const stat = vol.statSync(full)
            if (stat.isDirectory()) walk(full)
            else result[full] = vol.readFileSync(full, { encoding: 'utf8' }) as string
        }
    }
    walk('/workspace')

    return result
}

// ── Tree builder ───────────────────────────────────────────────

function buildTree(dir: string): VFSNode[] {
    const entries = vol.readdirSync(dir, { encoding: 'utf8' }) as string[]
    return entries
        .filter((e) => !e.startsWith('.'))
        .map((name) => {
            const path = `${dir}/${name}`
            const isDir = vol.statSync(path).isDirectory()
            return { name, path, isDirectory: isDir, children: isDir ? buildTree(path) : undefined }
        })
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
        })
}

export function refreshFileTree() {
    useFilesStore.getState().setFiles(buildTree('/workspace'))
}

// ── Init ───────────────────────────────────────────────────────

export type InitVFSOptions = {
    // Namespace for OPFS persistence. Each assignment/submission gets its own.
    projectId?: string
    // Seed files when /workspace is empty (overrides default template).
    initialFiles?: Record<string, string>
    // Skip OPFS entirely. Used for read-mostly views (e.g. teacher reviewing a
    // student submission) where we always want the latest seed and don't want
    // local edits to clobber the cached snapshot on the next visit.
    ephemeral?: boolean
}

function wipeWorkspace() {
    try {
        const entries = vol.readdirSync('/workspace', { encoding: 'utf8' }) as string[]
        for (const e of entries) {
            const p = `/workspace/${e}`
            try {
                const stat = vol.statSync(p)
                if (stat.isDirectory()) vol.rmdirSync(p, { recursive: true } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
                else vol.unlinkSync(p)
            } catch { /* ignore */ }
        }
    } catch { /* /workspace doesn't exist yet */ }
}

// Replace /workspace contents with the given files. Used when switching
// assignments. Fires a single change notification.
export function bootstrapWorkspace(files: Record<string, string>) {
    // Validate the entire incoming snapshot before erasing the current one.
    // A malformed persisted/host-owned path must not partially replace or
    // escape the active workspace.
    const normalizedFiles = normalizeWorkspaceFiles(files)
    wipeWorkspace()
    vol.mkdirSync('/workspace', { recursive: true })
    for (const [target, content] of Object.entries(normalizedFiles)) {
        const dir = target.substring(0, target.lastIndexOf('/'))
        if (dir && !vol.existsSync(dir)) vol.mkdirSync(dir, { recursive: true })
        vol.writeFileSync(target, content, { encoding: 'utf8' })
    }
    refreshFileTree()
    const first = Object.keys(normalizedFiles).sort()[0]
    if (first) {
        useEditorStore.getState().setActiveFile(first, readFile(first))
    }
    notifyWorkspaceChange()
}

export async function initVFS(opts: InitVFSOptions = {}) {
    // Do this before changing generation/project state or wiping the volume.
    const normalizedInitialFiles = opts.initialFiles
        ? normalizeWorkspaceFiles(opts.initialFiles)
        : undefined
    const generation = ++vfsInitGeneration
    // Drop any queued writes from the previous project — they'd target the
    // OLD activeProjectId if they fired after the project switch.
    for (const t of pendingFlushes.values()) clearTimeout(t)
    pendingFlushes.clear()

    // Ephemeral views (e.g. teacher reviewing a submission) don't persist to
    // OPFS — set projectId to empty so syncToOPFS/deleteFromOPFS no-op.
    if (opts.ephemeral) activeProjectId = ''
    else if (opts.projectId) activeProjectId = opts.projectId
    const requestedProjectId = activeProjectId

    // Reset workspace before hydrating so switching assignments doesn't leak
    wipeWorkspace()
    vol.mkdirSync('/workspace', { recursive: true })

    if (!opts.ephemeral) {
        // Hydrate from OPFS (per-project)
        try {
            const { hydrateFromOPFS } = await import('./opfs-sync')
            await hydrateFromOPFS(
                requestedProjectId,
                () => generation === vfsInitGeneration,
            )
        } catch { /* OPFS not available */ }
    }

    // A newer workspace switch owns the singleton volume now. The OPFS
    // hydrator also checks this generation before every materialized entry,
    // so stale work cannot seed or refresh the newer workspace.
    if (generation !== vfsInitGeneration) return

    const workspaceEmpty = (() => {
        try { return (vol.readdirSync('/workspace', { encoding: 'utf8' }) as string[]).length === 0 }
        catch { return true }
    })()

    if (workspaceEmpty) {
        if (normalizedInitialFiles && Object.keys(normalizedInitialFiles).length > 0) {
            for (const [path, content] of Object.entries(normalizedInitialFiles)) {
                writeFile(path, content)
            }
        } else if (!opts.ephemeral) {
            writeFile('/workspace/main.cpp', DEFAULT_MAIN)
        }
    }

    refreshFileTree()
    const pickActive = () => {
        if (vol.existsSync('/workspace/main.cpp')) return '/workspace/main.cpp'
        try {
            const entries = (vol.readdirSync('/workspace', { encoding: 'utf8' }) as string[]).sort()
            for (const e of entries) {
                const p = `/workspace/${e}`
                if (!vol.statSync(p).isDirectory()) return p
            }
        } catch { /* empty */ }
        return null
    }
    const active = pickActive()
    if (active) useEditorStore.getState().setActiveFile(active, readFile(active))
}

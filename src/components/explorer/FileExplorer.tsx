import {
    useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback,
    type KeyboardEvent, type ReactNode,
} from 'react'
import type { VFSNode } from '@/store/files-store'
import {
    useWorkbenchEditorStore,
    useWorkbenchFilesStore,
    useWorkbenchInstance,
} from '@/web-ide/react/workbench-instance-context'
import { useWebIDEHost as useIDEHost } from '@/web-ide/react/host-context'
import { getFileIconUrl, getFolderIconUrl } from '@/lib/vscode-icons'
import './explorer.css'

const ROOT = '/workspace'
const WORKSPACE_LABEL = 'Workspace'

// ── Flatten the visible tree into a row list ──────────────────────
// VS Code's tree renders the visible subset as a flat list with depth
// metadata. We mirror that: gives O(1) keyboard nav and avoids deep
// React subtree re-renders when a single row's selection state changes.

type Row = {
    node: VFSNode
    depth: number
}

function flattenVisible(nodes: VFSNode[], expanded: Set<string>, depth = 0): Row[] {
    const rows: Row[] = []
    for (const node of nodes) {
        rows.push({ node, depth })
        if (node.isDirectory && expanded.has(node.path) && node.children?.length) {
            rows.push(...flattenVisible(node.children, expanded, depth + 1))
        }
    }
    return rows
}

// ── Codicon helper ────────────────────────────────────────────────

function Codicon({ name, className = '' }: { name: string; className?: string }) {
    return <span className={`codicon codicon-${name} ${className}`} aria-hidden="true" />
}

// ── Inline input (rename + create) ────────────────────────────────

function InlineInput({
    defaultValue, onSubmit, onCancel,
}: {
    defaultValue?: string
    onSubmit: (name: string) => void
    onCancel: () => void
}) {
    const ref = useRef<HTMLInputElement>(null)
    const [value, setValue] = useState(defaultValue ?? '')

    useEffect(() => {
        ref.current?.focus()
        if (defaultValue) {
            const dot = defaultValue.lastIndexOf('.')
            ref.current?.setSelectionRange(0, dot > 0 ? dot : defaultValue.length)
        }
    }, [defaultValue])

    const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (value.trim()) onSubmit(value.trim())
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
        }
    }

    return (
        <span className="vsx-input-wrap">
            <input
                ref={ref}
                className="vsx-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKey}
                onBlur={() => (value.trim() ? onSubmit(value.trim()) : onCancel())}
                spellCheck={false}
            />
        </span>
    )
}

// ── Context menu ──────────────────────────────────────────────────

type MenuItem =
    | { kind: 'item'; label: string; onClick: () => void; danger?: boolean }
    | { kind: 'separator' }

function ContextMenu({
    x, y, items, onClose,
}: {
    x: number
    y: number
    items: MenuItem[]
    onClose: () => void
}) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) onClose()
        }
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    // Clamp to viewport so the menu doesn't bleed off the right/bottom edges.
    // useLayoutEffect: the menu must be measured after render but repositioned
    // before paint, or it would flash at the unclamped coordinates.
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const nx = x + r.width > window.innerWidth ? window.innerWidth - r.width - 4 : x
        const ny = y + r.height > window.innerHeight ? window.innerHeight - r.height - 4 : y
        el.style.left = `${nx}px`
        el.style.top = `${ny}px`
    }, [x, y])

    return (
        <div ref={ref} className="vsx-context-menu" style={{ left: x, top: y }} role="menu">
            {items.map((it, i) =>
                it.kind === 'separator' ? (
                    <div key={i} className="vsx-menu-separator" />
                ) : (
                    <div
                        key={i}
                        className={`vsx-menu-item${it.danger ? ' danger' : ''}`}
                        role="menuitem"
                        onClick={() => {
                            it.onClick()
                            onClose()
                        }}
                    >
                        {it.label}
                    </div>
                )
            )}
        </div>
    )
}

// ── Tree row ──────────────────────────────────────────────────────

function TreeRow({
    row, isExpanded, isSelected, isFocused,
    onClick, onContextMenu, onTwistieClick, renaming, onRenameSubmit, onRenameCancel,
}: {
    row: Row
    isExpanded: boolean
    isSelected: boolean
    isFocused: boolean
    onClick: () => void
    onContextMenu: (e: React.MouseEvent) => void
    onTwistieClick: (e: React.MouseEvent) => void
    renaming: boolean
    onRenameSubmit: (name: string) => void
    onRenameCancel: () => void
}) {
    const { node, depth } = row
    const isDir = node.isDirectory
    const paddingLeft = 8 + depth * 8

    const iconUrl = isDir
        ? getFolderIconUrl(node.name, isExpanded)
        : getFileIconUrl(node.name)

    return (
        <div
            className={`vsx-row${isSelected ? ' selected' : ''}${isFocused ? ' focused' : ''}`}
            style={{ paddingLeft }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            role="treeitem"
            aria-expanded={isDir ? isExpanded : undefined}
            aria-level={depth + 1}
        >
            {depth > 0 && (
                <span className="vsx-indent">
                    {Array.from({ length: depth }, (_, i) => (
                        <span key={i} className="vsx-indent-guide" />
                    ))}
                </span>
            )}
            <span
                className={`vsx-twistie${isDir ? (isExpanded ? ' expanded' : '') : ' empty'}`}
                onClick={isDir ? onTwistieClick : undefined}
            >
                {isDir && <Codicon name="chevron-right" />}
            </span>
            <img className="vsx-icon" src={iconUrl} alt="" draggable={false} />
            {renaming ? (
                <InlineInput
                    defaultValue={node.name}
                    onSubmit={onRenameSubmit}
                    onCancel={onRenameCancel}
                />
            ) : (
                <span className="vsx-label">{node.name}</span>
            )}
        </div>
    )
}

function InlineCreateRow({
    depth, onSubmit, onCancel,
}: {
    depth: number
    onSubmit: (name: string) => void
    onCancel: () => void
}) {
    const iconUrl = getFileIconUrl('untitled')
    return (
        <div className="vsx-row" style={{ paddingLeft: 8 + depth * 8 }}>
            {depth > 0 && (
                <span className="vsx-indent">
                    {Array.from({ length: depth }, (_, i) => (
                        <span key={i} className="vsx-indent-guide" />
                    ))}
                </span>
            )}
            <span className="vsx-twistie empty" />
            <img className="vsx-icon" src={iconUrl} alt="" draggable={false} />
            <InlineInput onSubmit={onSubmit} onCancel={onCancel} />
        </div>
    )
}

// ── Explorer ──────────────────────────────────────────────────────

export function FileExplorer() {
    const files = useWorkbenchFilesStore((s) => s.files)
    const expandedDirs = useWorkbenchFilesStore((s) => s.expandedDirs)
    const toggleDir = useWorkbenchFilesStore((s) => s.toggleDir)
    const expandDir = useWorkbenchFilesStore((s) => s.expandDir)
    const { activeFile, setActiveFile } = useWorkbenchEditorStore()
    const instance = useWorkbenchInstance()
    const host = useIDEHost()
    const readOnly = host?.workspace?.readOnly === true

    const [focusedPath, setFocusedPath] = useState<string | null>(null)
    const [renamingPath, setRenamingPath] = useState<string | null>(null)
    // Inline create has a parent path ('' = root). Null = idle.
    const [creating, setCreating] = useState<{ parent: string } | null>(null)
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
    const [sectionCollapsed, setSectionCollapsed] = useState(false)

    const rows = useMemo(
        () => (sectionCollapsed ? [] : flattenVisible(files, expandedDirs)),
        [files, expandedDirs, sectionCollapsed]
    )

    // Selection follows activeFile so opening a file from elsewhere highlights
    // it. Adjust-state-during-render (guarded by a previous-value comparison)
    // instead of an effect, so the highlight lands in the same paint.
    const [prevActiveFile, setPrevActiveFile] = useState(activeFile)
    if (activeFile !== prevActiveFile) {
        setPrevActiveFile(activeFile)
        if (activeFile) setFocusedPath(activeFile)
    }

    // ── Row actions ───────────────────────────────────────────────

    const openOrToggle = useCallback((node: VFSNode) => {
        if (node.isDirectory) {
            toggleDir(node.path)
        } else {
            setActiveFile(node.path, instance.workspace.readFile(node.path))
        }
        setFocusedPath(node.path)
    }, [instance, toggleDir, setActiveFile])

    const handleRename = useCallback((node: VFSNode, name: string) => {
        if (readOnly) return
        const parent = node.path.substring(0, node.path.lastIndexOf('/'))
        const newPath = `${parent}/${name}`
        if (newPath !== node.path && !instance.workspace.fileExists(newPath)) {
            try {
                instance.workspace.renameLocal(node.path, newPath)
                host?.events?.emit('file_rename', { from: node.path, to: newPath })
            } catch (error) {
                console.warn('[web-ide] local workspace rename rejected', error)
            }
        }
        setRenamingPath(null)
    }, [host, instance, readOnly])

    const handleDelete = useCallback((node: VFSNode) => {
        if (readOnly) return
        try {
            instance.workspace.deleteLocal(node.path)
            host?.events?.emit('file_delete', { path: node.path })
        } catch (error) {
            console.warn('[web-ide] local workspace delete rejected', error)
        }
    }, [host, instance, readOnly])

    const handleCreate = useCallback((parent: string, name: string) => {
        if (readOnly) return
        const base = parent || ROOT
        const newPath = `${base}/${name}`
        if (!instance.workspace.fileExists(newPath)) {
            try {
                instance.workspace.createFileLocal(newPath, '')
                host?.events?.emit('file_create', { path: newPath, kind: 'file' })
                setActiveFile(newPath, '')
            } catch (error) {
                console.warn('[web-ide] local workspace create rejected', error)
            }
        }
        if (parent) expandDir(parent)
        setCreating(null)
    }, [host, expandDir, instance, readOnly, setActiveFile])

    const startCreate = useCallback((parent: string) => {
        if (readOnly) return
        if (parent) expandDir(parent)
        setCreating({ parent })
    }, [expandDir, readOnly])

    // ── Context menu ──────────────────────────────────────────────

    const showRowMenu = (e: React.MouseEvent, node: VFSNode) => {
        e.preventDefault()
        e.stopPropagation()
        setFocusedPath(node.path)
        if (readOnly) return
        const parent = node.isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
        setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                { kind: 'item', label: 'New File…', onClick: () => startCreate(parent) },
                { kind: 'separator' },
                { kind: 'item', label: 'Rename…', onClick: () => setRenamingPath(node.path) },
                { kind: 'item', label: 'Delete', danger: true, onClick: () => handleDelete(node) },
            ],
        })
    }

    const showEmptyAreaMenu = (e: React.MouseEvent) => {
        e.preventDefault()
        if (readOnly) return
        setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                { kind: 'item', label: 'New File…', onClick: () => startCreate('') },
            ],
        })
    }

    // ── Keyboard nav ──────────────────────────────────────────────

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        // Ignore keys that bubbled up from a child input (inline rename /
        // create) — otherwise Backspace in the new-file field deletes the
        // currently focused file in the tree.
        if (e.target !== e.currentTarget) return
        if (!focusedPath || rows.length === 0) return
        const idx = rows.findIndex((r) => r.node.path === focusedPath)
        if (idx === -1) return
        const row = rows[idx]

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault()
                if (idx < rows.length - 1) setFocusedPath(rows[idx + 1].node.path)
                break
            case 'ArrowUp':
                e.preventDefault()
                if (idx > 0) setFocusedPath(rows[idx - 1].node.path)
                break
            case 'ArrowRight':
                e.preventDefault()
                if (row.node.isDirectory) {
                    if (!expandedDirs.has(row.node.path)) toggleDir(row.node.path)
                    else if (idx < rows.length - 1) setFocusedPath(rows[idx + 1].node.path)
                }
                break
            case 'ArrowLeft':
                e.preventDefault()
                if (row.node.isDirectory && expandedDirs.has(row.node.path)) {
                    toggleDir(row.node.path)
                } else if (row.depth > 0) {
                    for (let i = idx - 1; i >= 0; i--) {
                        if (rows[i].depth === row.depth - 1) {
                            setFocusedPath(rows[i].node.path)
                            break
                        }
                    }
                }
                break
            case 'Enter':
                e.preventDefault()
                openOrToggle(row.node)
                break
            case 'F2':
                e.preventDefault()
                if (readOnly) break
                setRenamingPath(row.node.path)
                break
            case 'Delete':
            case 'Backspace':
                e.preventDefault()
                if (readOnly) break
                handleDelete(row.node)
                break
        }
    }

    // ── Render rows + interleave the inline-create stub at the right depth ──

    const renderedRows: ReactNode[] = []
    if (!readOnly && !sectionCollapsed && creating?.parent === '') {
        renderedRows.push(
            <InlineCreateRow
                key="__create_root"
                depth={0}
                onSubmit={(name) => handleCreate('', name)}
                onCancel={() => setCreating(null)}
            />
        )
    }
    for (const row of rows) {
        const expanded = expandedDirs.has(row.node.path)
        const renaming = renamingPath === row.node.path
        const isSelected = focusedPath === row.node.path
        renderedRows.push(
            <TreeRow
                key={row.node.path}
                row={row}
                isExpanded={expanded}
                isSelected={isSelected}
                isFocused={isSelected}
                onClick={() => openOrToggle(row.node)}
                onTwistieClick={(e) => {
                    e.stopPropagation()
                    toggleDir(row.node.path)
                    setFocusedPath(row.node.path)
                }}
                onContextMenu={(e) => showRowMenu(e, row.node)}
                renaming={!readOnly && renaming}
                onRenameSubmit={(name) => handleRename(row.node, name)}
                onRenameCancel={() => setRenamingPath(null)}
            />
        )
        if (
            !readOnly && creating &&
            row.node.isDirectory &&
            expanded &&
            creating.parent === row.node.path
        ) {
            renderedRows.push(
                <InlineCreateRow
                    key={`__create_${row.node.path}`}
                    depth={row.depth + 1}
                    onSubmit={(name) => handleCreate(row.node.path, name)}
                    onCancel={() => setCreating(null)}
                />
            )
        }
    }

    return (
        <div className="vscode-explorer">
            <div className="vsx-titlebar">
                <span className="vsx-titlebar-label">Explorer</span>
            </div>

            <div
                className="vsx-section-header"
                onClick={() => setSectionCollapsed((v) => !v)}
            >
                <span className={`vsx-section-twistie${sectionCollapsed ? ' collapsed' : ''}`}>
                    <Codicon name="chevron-down" />
                </span>
                <span className="vsx-section-title">{WORKSPACE_LABEL}</span>
                <span className="vsx-section-actions" onClick={(e) => e.stopPropagation()}>
                    {!readOnly && (
                        <>
                            <button
                                className="vsx-action-btn"
                                title="New File…"
                                onClick={() => { setSectionCollapsed(false); startCreate('') }}
                            >
                                <Codicon name="new-file" />
                            </button>
                        </>
                    )}
                    <button
                        className="vsx-action-btn"
                        title="Refresh Explorer"
                        onClick={(e) => { e.stopPropagation() }}
                    >
                        <Codicon name="refresh" />
                    </button>
                    <button
                        className="vsx-action-btn"
                        title="Collapse Folders in Explorer"
                        onClick={(e) => {
                            e.stopPropagation()
                            for (const p of [...expandedDirs]) toggleDir(p)
                        }}
                    >
                        <Codicon name="collapse-all" />
                    </button>
                </span>
            </div>

            <div
                className="vsx-tree"
                tabIndex={0}
                onKeyDown={onKeyDown}
                onContextMenu={showEmptyAreaMenu}
                role="tree"
            >
                {renderedRows}
                {!sectionCollapsed && rows.length === 0 && !creating && (
                    <div className="vsx-empty">No files</div>
                )}
            </div>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={menu.items}
                    onClose={() => setMenu(null)}
                />
            )}
        </div>
    )
}

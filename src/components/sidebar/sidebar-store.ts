// Activity-bar / sidebar selection state.
//
// Clicking the active activity-bar item collapses the sidebar — that's
// VS Code's behavior and the only way to give the editor full width without
// dragging the resize handle. Persisted to localStorage so a refresh keeps
// the user's last layout.

import { create } from 'zustand'

const STORAGE_KEY = 'web-ide.sidebar'

export type SidebarView = string

type Persisted = { activeView: SidebarView; collapsed: boolean }

interface SidebarState extends Persisted {
    setActiveView: (v: SidebarView) => void
    toggleCollapsed: () => void
    /** Activity-bar click handler: same view = collapse toggle; different = switch + expand. */
    onActivityClick: (v: SidebarView) => void
}

function readStored(): Persisted {
    const fallback: Persisted = { activeView: 'workbench.files', collapsed: false }
    if (typeof window === 'undefined') return fallback
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (
            typeof parsed.activeView === 'string' && parsed.activeView.length > 0 &&
            typeof parsed.collapsed === 'boolean'
        ) {
            return parsed
        }
    } catch { /* corrupt entry or storage blocked */ }
    return fallback
}

function persist(state: Persisted): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch { /* best-effort */ }
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
    ...readStored(),
    setActiveView: (v) => {
        const next: Persisted = { activeView: v, collapsed: false }
        persist(next)
        set(next)
    },
    toggleCollapsed: () => {
        const cur = get()
        const next: Persisted = { activeView: cur.activeView, collapsed: !cur.collapsed }
        persist(next)
        set(next)
    },
    onActivityClick: (v) => {
        const cur = get()
        const next: Persisted = cur.activeView === v
            ? { activeView: v, collapsed: !cur.collapsed }
            : { activeView: v, collapsed: false }
        persist(next)
        set(next)
    },
}))

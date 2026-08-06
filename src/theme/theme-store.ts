// Color-theme store. Persists to localStorage so the user's choice survives
// reloads, and exposes `applyTheme` so `main.tsx` can paint the right palette
// before React mounts (avoids a one-frame flash of the wrong theme).

import { create } from 'zustand'

const STORAGE_KEY = 'web-ide.theme'

export type Theme = 'dark' | 'light'

function readStored(): Theme {
    if (typeof window === 'undefined') return 'light'
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === 'dark' || raw === 'light') return raw
    } catch { /* private mode — fall through */ }
    return 'light'
}

function writeAttr(theme: Theme): void {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-theme', theme)
}

interface ThemeState {
    theme: Theme
    setTheme: (t: Theme) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
    theme: readStored(),
    setTheme: (t) => {
        try { window.localStorage.setItem(STORAGE_KEY, t) } catch { /* best-effort */ }
        writeAttr(t)
        set({ theme: t })
    },
}))

// Call once before React mounts so the document already carries the right
// data-theme attribute when stylesheets parse.
export function initTheme(): void {
    writeAttr(readStored())
}

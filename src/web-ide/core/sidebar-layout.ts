const SIDEBAR_STORAGE_KEY = 'web-ide.sidebar'
const DEFAULT_ACTIVITY_ID = 'workbench.files'

export interface SidebarLayoutSnapshot {
  readonly selectedActivityId: string
  readonly collapsed: boolean
}

export interface SidebarLayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SidebarLayoutController {
  readonly getSnapshot: () => SidebarLayoutSnapshot
  readonly subscribe: (listener: () => void) => () => void
  selectActivity(activityId: string): void
  toggleCollapsed(): void
  handleActivityClick(activityId: string): void
}

function browserStorage(): SidebarLayoutStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStored(storage: SidebarLayoutStorage | undefined): SidebarLayoutSnapshot {
  if (!storage) {
    return Object.freeze({ selectedActivityId: DEFAULT_ACTIVITY_ID, collapsed: false })
  }
  try {
    const raw = storage.getItem(SIDEBAR_STORAGE_KEY)
    if (raw === null) {
      return Object.freeze({ selectedActivityId: DEFAULT_ACTIVITY_ID, collapsed: false })
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.activeView === 'string'
      && parsed.activeView.length > 0
      && typeof parsed.collapsed === 'boolean'
    ) {
      return Object.freeze({
        selectedActivityId: parsed.activeView,
        collapsed: parsed.collapsed,
      })
    }
  } catch {
    // Corrupt or blocked storage preserves the established Explorer fallback.
  }
  return Object.freeze({ selectedActivityId: DEFAULT_ACTIVITY_ID, collapsed: false })
}

function persist(storage: SidebarLayoutStorage | undefined, snapshot: SidebarLayoutSnapshot): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({
      activeView: snapshot.selectedActivityId,
      collapsed: snapshot.collapsed,
    }))
  } catch {
    // Sidebar persistence remains best-effort.
  }
}

/** Creates activity selection state owned by one mounted workbench. */
export function createSidebarLayoutController(
  initialSelectedActivityId?: string,
  storage: SidebarLayoutStorage | undefined = browserStorage(),
): SidebarLayoutController {
  let snapshot = initialSelectedActivityId === undefined
    ? readStored(storage)
    : Object.freeze({ selectedActivityId: initialSelectedActivityId, collapsed: false })
  const listeners = new Set<() => void>()

  const update = (next: SidebarLayoutSnapshot) => {
    if (
      next.selectedActivityId === snapshot.selectedActivityId
      && next.collapsed === snapshot.collapsed
    ) return
    snapshot = Object.freeze(next)
    persist(storage, snapshot)
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    selectActivity(activityId) {
      update({ selectedActivityId: activityId, collapsed: false })
    },
    toggleCollapsed() {
      update({ ...snapshot, collapsed: !snapshot.collapsed })
    },
    handleActivityClick(activityId) {
      update(snapshot.selectedActivityId === activityId
        ? { selectedActivityId: activityId, collapsed: !snapshot.collapsed }
        : { selectedActivityId: activityId, collapsed: false })
    },
  }
}

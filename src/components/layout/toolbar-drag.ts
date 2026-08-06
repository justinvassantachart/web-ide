// Pure geometry + persistence helpers for the draggable debug toolbar.
// Kept free of React/DOM so the math is unit-testable: positions are
// pixel offsets of the toolbar's top-left corner inside its positioning
// container (the editor wrapper).

export type Pos = { x: number; y: number }
export type Size = { width: number; height: number }

export const TOOLBAR_POSITION_KEY = 'web-ide.debug-toolbar.pos.v1'

// (The DEFAULT position — top-center, 6px gap — lives in the stylesheet:
// a null stored position simply means "don't override the CSS".)

// Keep the toolbar fully inside the container. When the container is
// smaller than the toolbar (tiny editor pane), pin to the top-left rather
// than letting it escape.
export function clampPosition(pos: Pos, toolbar: Size, container: Size): Pos {
  const maxX = Math.max(0, container.width - toolbar.width)
  const maxY = Math.max(0, container.height - toolbar.height)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  }
}

// Where the toolbar lands when a drag that started with the toolbar at
// `origin` has moved the pointer by `delta`.
export function positionFromDrag(
  origin: Pos,
  delta: Pos,
  toolbar: Size,
  container: Size,
): Pos {
  return clampPosition({ x: origin.x + delta.x, y: origin.y + delta.y }, toolbar, container)
}

export function serializePosition(pos: Pos): string {
  return JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) })
}

// Strict parse: anything malformed (older formats, corrupted storage,
// hand-edited values) degrades to null = "use the default position".
export function parseStoredPosition(raw: string | null): Pos | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const { x, y } = v as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

// localStorage can throw (privacy modes, disabled storage) — degrade to
// session-only positioning rather than crashing the toolbar.
export function loadStoredPosition(): Pos | null {
  try {
    return parseStoredPosition(localStorage.getItem(TOOLBAR_POSITION_KEY))
  } catch {
    return null
  }
}

export function storePosition(pos: Pos | null): void {
  try {
    if (pos === null) localStorage.removeItem(TOOLBAR_POSITION_KEY)
    else localStorage.setItem(TOOLBAR_POSITION_KEY, serializePosition(pos))
  } catch {
    // Best-effort persistence only.
  }
}

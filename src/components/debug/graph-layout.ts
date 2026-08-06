// Pure, incremental layout engine for the memory graph.
//
// Design goals, in priority order:
//   1. NEVER place nodes on top of each other (auto-placement is
//      collision-free against everything already on the canvas).
//   2. Stability: a node that already has a position keeps it exactly —
//      stepping the debugger must not reshuffle the picture the learner is
//      looking at. New nodes are added around the existing ones.
//   3. Readability: heap objects flow left→right by pointer depth (rank),
//      so lists and trees read as chains, with new nodes appearing next to
//      the node that points to them.
//
// Everything here is pure data-in/data-out (no React, no DOM) so the
// guarantees above are enforceable by tests.

export type Point = { x: number; y: number }
export type Rect = Point & { width: number; height: number }

// Geometry constants shared with the component. The stack column is a fixed
// 260px-wide spine at x=0; heap columns start past it.
export const STACK_X = 0
export const HEAP_X0 = 360
export const NODE_WIDTH = 220
export const COLUMN_WIDTH = 340 // NODE_WIDTH + inter-column gap
export const VERTICAL_GAP = 30
export const ROW_HEIGHT = 28
export const NODE_CHROME = 40 // header + borders
export const MIN_NODE_HEIGHT = 60

export function rowsToHeight(rows: number): number {
    return Math.max(MIN_NODE_HEIGHT, rows * ROW_HEIGHT + NODE_CHROME)
}

export function rectsIntersect(a: Rect, b: Rect, gap = 0): boolean {
    return (
        a.x < b.x + b.width + gap
        && b.x < a.x + a.width + gap
        && a.y < b.y + b.height + gap
        && b.y < a.y + a.height + gap
    )
}

// ── Stack column ────────────────────────────────────────────────

export function placeStackFrames(frames: { id: string; height: number }[]): Map<string, Point> {
    const out = new Map<string, Point>()
    let y = 0
    for (const f of frames) {
        out.set(f.id, { x: STACK_X, y })
        y += f.height + VERTICAL_GAP
    }
    return out
}

// ── Heap placement ──────────────────────────────────────────────

export type HeapLayoutInput = {
    // Heap nodes in the current snapshot, in discovery (allocation-walk)
    // order. Heights come from the node's current row count.
    nodes: { id: string; height: number }[]
    // Directed heap→heap pointer edges.
    edges: { source: string; target: string }[]
    // Heap nodes pointed to directly from stack variables — rank-0 roots.
    roots: string[]
    // Positions persisted from earlier snapshots (including nodes not in
    // this snapshot — navigating backward and forward restores the same spots).
    previous: ReadonlyMap<string, Point>
}

// Pointer-depth rank per node: BFS from the stack-pointed roots, then from
// any still-unranked node in snapshot order (covers orphans and cycles).
export function computeRanks(input: Pick<HeapLayoutInput, 'nodes' | 'edges' | 'roots'>): Map<string, number> {
    const present = new Set(input.nodes.map((n) => n.id))
    const out = new Map<string, number>()
    const adjacency = new Map<string, string[]>()
    for (const e of input.edges) {
        if (!present.has(e.source) || !present.has(e.target)) continue
        const list = adjacency.get(e.source)
        if (list) list.push(e.target)
        else adjacency.set(e.source, [e.target])
    }

    const bfs = (start: string) => {
        if (out.has(start)) return
        out.set(start, 0)
        const queue = [start]
        while (queue.length > 0) {
            const id = queue.shift()!
            const rank = out.get(id)!
            for (const next of adjacency.get(id) ?? []) {
                if (!out.has(next)) {
                    out.set(next, rank + 1)
                    queue.push(next)
                }
            }
        }
    }

    for (const root of input.roots) if (present.has(root)) bfs(root)
    for (const node of input.nodes) bfs(node.id)
    return out
}

// Slide a desired rect downward until it collides with nothing. Obstacles
// are checked in y-order so the result is deterministic; y only increases,
// so termination is guaranteed.
function resolveCollision(desired: Rect, obstacles: Rect[]): Point {
    const sorted = [...obstacles].sort((a, b) => a.y - b.y || a.x - b.x)
    const rect = { ...desired }
    let moved = true
    while (moved) {
        moved = false
        for (const o of sorted) {
            if (rectsIntersect(rect, o, VERTICAL_GAP / 2)) {
                rect.y = o.y + o.height + VERTICAL_GAP
                moved = true
            }
        }
    }
    return { x: rect.x, y: rect.y }
}

export function placeHeapNodes(input: HeapLayoutInput): Map<string, Point> {
    const ranks = computeRanks(input)
    const heightById = new Map(input.nodes.map((n) => [n.id, n.height]))
    const order = new Map(input.nodes.map((n, i) => [n.id, i]))

    // First incoming pointer per node — used to seed a new node's y next to
    // the node that points to it, so a list grows as a visual chain.
    const parentOf = new Map<string, string>()
    for (const e of input.edges) {
        if (!parentOf.has(e.target) && e.source !== e.target) parentOf.set(e.target, e.source)
    }

    const out = new Map<string, Point>()
    const obstacles: Rect[] = []
    const asRect = (id: string, p: Point): Rect => ({
        ...p, width: NODE_WIDTH, height: heightById.get(id) ?? MIN_NODE_HEIGHT,
    })

    // Pass 1 — nodes with remembered positions keep them. Processed in
    // (y, x, id) order; a kept node is only moved if it now collides with a
    // kept node placed before it (e.g. a node above it grew taller), which
    // preserves the no-overlap guarantee without reshuffling the layout.
    const kept = input.nodes
        .filter((n) => input.previous.has(n.id))
        .sort((a, b) => {
            const pa = input.previous.get(a.id)!
            const pb = input.previous.get(b.id)!
            return pa.y - pb.y || pa.x - pb.x || a.id.localeCompare(b.id)
        })
    for (const node of kept) {
        const prev = input.previous.get(node.id)!
        const pos = resolveCollision(asRect(node.id, prev), obstacles)
        out.set(node.id, pos)
        obstacles.push(asRect(node.id, pos))
    }

    // Pass 2 — new nodes, in (rank, discovery-order): desired position is
    // the node's rank column, vertically next to its pointer parent when it
    // has one; collisions slide it down past whatever is in the way.
    const fresh = input.nodes
        .filter((n) => !input.previous.has(n.id))
        .sort((a, b) => {
            const ra = ranks.get(a.id) ?? 0
            const rb = ranks.get(b.id) ?? 0
            return ra - rb || (order.get(a.id)! - order.get(b.id)!)
        })
    for (const node of fresh) {
        const rank = ranks.get(node.id) ?? 0
        const parent = parentOf.get(node.id)
        const parentPos = parent !== undefined ? out.get(parent) : undefined
        const desired: Rect = {
            x: HEAP_X0 + rank * COLUMN_WIDTH,
            y: parentPos ? parentPos.y : 0,
            width: NODE_WIDTH,
            height: node.height,
        }
        const pos = resolveCollision(desired, obstacles)
        out.set(node.id, pos)
        obstacles.push(asRect(node.id, pos))
    }

    return out
}

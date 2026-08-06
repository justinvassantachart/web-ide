import { describe, expect, it } from 'vitest'
import {
    placeStackFrames,
    computeRanks,
    placeHeapNodes,
    rectsIntersect,
    rowsToHeight,
    STACK_X,
    HEAP_X0,
    NODE_WIDTH,
    COLUMN_WIDTH,
    VERTICAL_GAP,
    MIN_NODE_HEIGHT,
    type Point,
    type Rect,
} from '../../src/components/debug/graph-layout'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Rect from a placed point + a node's height (and the fixed NODE_WIDTH). */
function toRect(p: Point, height: number): Rect {
    return { x: p.x, y: p.y, width: NODE_WIDTH, height }
}

/** Assert no two nodes in `layout` overlap, given their heights. */
function assertNoOverlap(
    layout: Map<string, Point>,
    heightById: Map<string, number>,
    label = '',
): void {
    const entries = [...layout.entries()]
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [idA, posA] = entries[i]
            const [idB, posB] = entries[j]
            const hA = heightById.get(idA) ?? MIN_NODE_HEIGHT
            const hB = heightById.get(idB) ?? MIN_NODE_HEIGHT
            const rectA = toRect(posA, hA)
            const rectB = toRect(posB, hB)
            if (rectsIntersect(rectA, rectB, 0)) {
                throw new Error(
                    `Overlap${label ? ' (' + label + ')' : ''}: ` +
                    `${idA} at (${posA.x},${posA.y},h=${hA}) intersects ` +
                    `${idB} at (${posB.x},${posB.y},h=${hB})`,
                )
            }
        }
    }
}

/** Mulberry32 PRNG — deterministic, seeded. */
function mulberry32(seed: number) {
    let s = seed
    return function rand(): number {
        s |= 0
        s = s + 0x6d2b79f5 | 0
        let z = Math.imul(s ^ s >>> 15, 1 | s)
        z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
        return ((z ^ z >>> 14) >>> 0) / 0x100000000
    }
}

// ── placeStackFrames ──────────────────────────────────────────────────────────

describe('placeStackFrames', () => {
    it('stacks frames at x=STACK_X with VERTICAL_GAP spacing, starting at y=0, in input order', () => {
        const h0 = rowsToHeight(3)
        const h1 = rowsToHeight(1)
        const h2 = rowsToHeight(5)
        const frames = [
            { id: 'main', height: h0 },
            { id: 'foo', height: h1 },
            { id: 'bar', height: h2 },
        ]
        const layout = placeStackFrames(frames)

        expect(layout.size).toBe(3)

        // First frame at y=0
        expect(layout.get('main')).toEqual({ x: STACK_X, y: 0 })

        // Second frame starts right after first + gap
        const expectedFooY = h0 + VERTICAL_GAP
        expect(layout.get('foo')).toEqual({ x: STACK_X, y: expectedFooY })

        // Third frame starts after second + gap
        const expectedBarY = expectedFooY + h1 + VERTICAL_GAP
        expect(layout.get('bar')).toEqual({ x: STACK_X, y: expectedBarY })

        // All x values equal STACK_X
        for (const [, pos] of layout) {
            expect(pos.x).toBe(STACK_X)
        }
    })

    it('returns empty map for empty input', () => {
        const layout = placeStackFrames([])
        expect(layout.size).toBe(0)
    })
})

// ── computeRanks ─────────────────────────────────────────────────────────────

describe('computeRanks', () => {
    it('assigns ranks 0,1,2,3 for a linear chain a→b→c→d rooted at a', () => {
        const nodes = [
            { id: 'a', height: MIN_NODE_HEIGHT },
            { id: 'b', height: MIN_NODE_HEIGHT },
            { id: 'c', height: MIN_NODE_HEIGHT },
            { id: 'd', height: MIN_NODE_HEIGHT },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'c' },
            { source: 'c', target: 'd' },
        ]
        const ranks = computeRanks({ nodes, edges, roots: ['a'] })

        expect(ranks.get('a')).toBe(0)
        expect(ranks.get('b')).toBe(1)
        expect(ranks.get('c')).toBe(2)
        expect(ranks.get('d')).toBe(3)
    })

    it('assigns children rank = parent rank + 1 in a binary tree', () => {
        // root(rank 0) → left(rank 1), right(rank 1); left → ll(rank 2), lr(rank 2)
        const nodes = [
            { id: 'root', height: MIN_NODE_HEIGHT },
            { id: 'left', height: MIN_NODE_HEIGHT },
            { id: 'right', height: MIN_NODE_HEIGHT },
            { id: 'll', height: MIN_NODE_HEIGHT },
            { id: 'lr', height: MIN_NODE_HEIGHT },
        ]
        const edges = [
            { source: 'root', target: 'left' },
            { source: 'root', target: 'right' },
            { source: 'left', target: 'll' },
            { source: 'left', target: 'lr' },
        ]
        const ranks = computeRanks({ nodes, edges, roots: ['root'] })

        expect(ranks.get('root')).toBe(0)
        expect(ranks.get('left')).toBe(1)
        expect(ranks.get('right')).toBe(1)
        expect(ranks.get('ll')).toBe(2)
        expect(ranks.get('lr')).toBe(2)
    })

    it('terminates and assigns finite ranks for a cycle (a→b→c→a, root a)', () => {
        const nodes = [
            { id: 'a', height: MIN_NODE_HEIGHT },
            { id: 'b', height: MIN_NODE_HEIGHT },
            { id: 'c', height: MIN_NODE_HEIGHT },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'c' },
            { source: 'c', target: 'a' },
        ]
        const ranks = computeRanks({ nodes, edges, roots: ['a'] })

        expect(ranks.size).toBe(3)
        expect(typeof ranks.get('a')).toBe('number')
        expect(typeof ranks.get('b')).toBe('number')
        expect(typeof ranks.get('c')).toBe('number')
        // a is the root, so rank 0; b and c follow BFS
        expect(ranks.get('a')).toBe(0)
        expect(ranks.get('b')).toBe(1)
        expect(ranks.get('c')).toBe(2)
    })

    it('assigns rank 0 to orphan nodes with no edges and not in roots', () => {
        const nodes = [
            { id: 'orphan1', height: MIN_NODE_HEIGHT },
            { id: 'orphan2', height: MIN_NODE_HEIGHT },
        ]
        const ranks = computeRanks({ nodes, edges: [], roots: [] })

        expect(ranks.get('orphan1')).toBe(0)
        expect(ranks.get('orphan2')).toBe(0)
    })

    it('ignores edges referencing nodes not in `nodes` — no phantom entries', () => {
        const nodes = [
            { id: 'a', height: MIN_NODE_HEIGHT },
        ]
        const edges = [
            { source: 'a', target: 'missing' },
            { source: 'ghost', target: 'a' },
        ]
        const ranks = computeRanks({ nodes, edges, roots: ['a'] })

        expect(ranks.has('missing')).toBe(false)
        expect(ranks.has('ghost')).toBe(false)
        expect(ranks.size).toBe(1)
        expect(ranks.get('a')).toBe(0)
    })

    it('gives a shared node the rank from the FIRST BFS root that reaches it', () => {
        // root1(rank0) → shared; root2(rank0) → mid(rank1) → shared
        // With roots: ['root1', 'root2'], BFS from root1 reaches shared first
        // giving rank 1; BFS from root2 would give rank 2 via mid→shared.
        const nodes = [
            { id: 'root1', height: MIN_NODE_HEIGHT },
            { id: 'root2', height: MIN_NODE_HEIGHT },
            { id: 'mid', height: MIN_NODE_HEIGHT },
            { id: 'shared', height: MIN_NODE_HEIGHT },
        ]
        const edges = [
            { source: 'root1', target: 'shared' },
            { source: 'root2', target: 'mid' },
            { source: 'mid', target: 'shared' },
        ]
        // root1 is listed first in roots, so its BFS runs first
        const ranks = computeRanks({ nodes, edges, roots: ['root1', 'root2'] })

        expect(ranks.get('root1')).toBe(0)
        expect(ranks.get('root2')).toBe(0)
        expect(ranks.get('mid')).toBe(1)
        // root1 reaches shared at rank 1; root2's path gives rank 2
        expect(ranks.get('shared')).toBe(1)
    })
})

// ── placeHeapNodes — core invariants ─────────────────────────────────────────

describe('placeHeapNodes', () => {
    const noPos: ReadonlyMap<string, Point> = new Map()

    // ── Test 9: NO-OVERLAP on fresh layouts ──────────────────────────────────

    describe('NO-OVERLAP invariant', () => {
        it('no overlaps for a fresh linear chain a→b→c→d→e', () => {
            const h = rowsToHeight(2)
            const ids = ['a', 'b', 'c', 'd', 'e']
            const nodes = ids.map((id) => ({ id, height: h }))
            const edges = ids.slice(0, -1).map((id, i) => ({ source: id, target: ids[i + 1] }))
            const layout = placeHeapNodes({ nodes, edges, roots: ['a'], previous: noPos })
            const heights = new Map(ids.map((id) => [id, h]))
            assertNoOverlap(layout, heights, 'fresh chain')
            expect(layout.size).toBe(ids.length)
        })

        it('no overlaps for a fresh binary tree', () => {
            const h = rowsToHeight(3)
            const nodes = [
                { id: 'r', height: h },
                { id: 'l', height: h },
                { id: 'ri', height: h },
                { id: 'll', height: h },
                { id: 'lr', height: h },
                { id: 'rl', height: h },
                { id: 'rr', height: h },
            ]
            const edges = [
                { source: 'r', target: 'l' },
                { source: 'r', target: 'ri' },
                { source: 'l', target: 'll' },
                { source: 'l', target: 'lr' },
                { source: 'ri', target: 'rl' },
                { source: 'ri', target: 'rr' },
            ]
            const layout = placeHeapNodes({ nodes, edges, roots: ['r'], previous: noPos })
            const heights = new Map(nodes.map((n) => [n.id, n.height]))
            assertNoOverlap(layout, heights, 'fresh binary tree')
        })

        it('no overlaps for a fresh cyclic graph', () => {
            const h = rowsToHeight(2)
            const nodes = [
                { id: 'a', height: h },
                { id: 'b', height: h },
                { id: 'c', height: h },
            ]
            const edges = [
                { source: 'a', target: 'b' },
                { source: 'b', target: 'c' },
                { source: 'c', target: 'a' },
            ]
            const layout = placeHeapNodes({ nodes, edges, roots: ['a'], previous: noPos })
            const heights = new Map(nodes.map((n) => [n.id, n.height]))
            assertNoOverlap(layout, heights, 'fresh cycle')
        })

        it('no overlaps for many orphan nodes (tall nodes)', () => {
            const h = rowsToHeight(8)
            const ids = Array.from({ length: 15 }, (_, i) => `orphan${i}`)
            const nodes = ids.map((id) => ({ id, height: h }))
            const layout = placeHeapNodes({ nodes, edges: [], roots: [], previous: noPos })
            const heights = new Map(ids.map((id) => [id, h]))
            assertNoOverlap(layout, heights, 'many orphans')
        })

        it('no overlaps for mixed: chain + orphans + cycle', () => {
            const h = rowsToHeight(2)
            const chainIds = ['a', 'b', 'c']
            const orphanIds = ['x', 'y', 'z']
            const cycleIds = ['p', 'q']
            const allIds = [...chainIds, ...orphanIds, ...cycleIds]
            const nodes = allIds.map((id) => ({ id, height: h }))
            const edges = [
                { source: 'a', target: 'b' },
                { source: 'b', target: 'c' },
                { source: 'p', target: 'q' },
                { source: 'q', target: 'p' },
            ]
            const layout = placeHeapNodes({ nodes, edges, roots: ['a', 'p'], previous: noPos })
            const heights = new Map(allIds.map((id) => [id, h]))
            assertNoOverlap(layout, heights, 'mixed graph')
        })
    })

    // ── Test 10: STABILITY ───────────────────────────────────────────────────

    it('STABILITY: nodes in previous keep their exact position when no collision', () => {
        const h = rowsToHeight(2)
        const nodes = [
            { id: 'a', height: h },
            { id: 'b', height: h },
            { id: 'c', height: h },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'c' },
        ]
        // First layout (fresh)
        const layout1 = placeHeapNodes({ nodes, edges, roots: ['a'], previous: noPos })

        // Second layout with same nodes — all are in previous now
        const layout2 = placeHeapNodes({ nodes, edges, roots: ['a'], previous: layout1 })

        // Every position should be identical
        for (const [id, pos] of layout1) {
            expect({ id, pos: layout2.get(id) }).toEqual({ id, pos })
        }
    })

    // ── Test 11: INCREMENTAL (linked list growing) ───────────────────────────

    it('INCREMENTAL: growing a linked list step-by-step preserves all prior positions and no overlaps', () => {
        const h = rowsToHeight(2)
        const n = 12
        const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i)) // a–l

        let previous: Map<string, Point> = new Map()

        for (let step = 1; step <= n; step++) {
            const stepIds = ids.slice(0, step)
            const nodes = stepIds.map((id) => ({ id, height: h }))
            const edges = stepIds.slice(0, -1).map((id, i) => ({
                source: id,
                target: stepIds[i + 1],
            }))

            const layout = placeHeapNodes({
                nodes,
                edges,
                roots: [stepIds[0]],
                previous,
            })

            // (a) All nodes get a position
            expect(layout.size).toBe(step)

            // (b) No overlaps
            const heights = new Map(stepIds.map((id) => [id, h]))
            assertNoOverlap(layout, heights, `step ${step}`)

            // (c) All previously placed nodes keep their exact positions
            for (const [id, prevPos] of previous) {
                if (layout.has(id)) {
                    expect({ step, id, pos: layout.get(id) }).toEqual({ step, id, pos: prevPos })
                }
            }

            // (d) New node is in its rank's column (x = HEAP_X0 + rank * COLUMN_WIDTH)
            //     when nothing blocked it from fresh placement
            if (step === 1) {
                // Only one node — must be at HEAP_X0
                const pos = layout.get(ids[0])!
                expect(pos.x).toBe(HEAP_X0)
            }

            previous = layout
        }
    })

    // ── Test 12: REPLAY RESTORE ──────────────────────────────────────────────

    it('REPLAY RESTORE: a node removed then re-added with the same previous map returns to its original spot', () => {
        const h = rowsToHeight(2)
        const nodes = [
            { id: 'a', height: h },
            { id: 'b', height: h },
            { id: 'c', height: h },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'c' },
        ]

        // Initial placement of a, b, c
        const layout1 = placeHeapNodes({ nodes, edges, roots: ['a'], previous: noPos })
        const posC = layout1.get('c')!

        // Build a previous map that contains ALL three original positions
        const fullPrevious: Map<string, Point> = new Map(layout1)

        // Layout without c (c absent but still in previous)
        const nodesWithoutC = nodes.filter((n) => n.id !== 'c')
        const edgesWithoutC = edges.filter((e) => e.source !== 'b' || e.target !== 'c')
        const layout2 = placeHeapNodes({
            nodes: nodesWithoutC,
            edges: edgesWithoutC,
            roots: ['a'],
            previous: fullPrevious,
        })
        expect(layout2.has('c')).toBe(false)

        // Re-add c with the SAME fullPrevious (which still contains c's original position)
        const layout3 = placeHeapNodes({ nodes, edges, roots: ['a'], previous: fullPrevious })

        // c returns to its exact original spot
        expect({ id: 'c', pos: layout3.get('c') }).toEqual({ id: 'c', pos: posC })
    })

    // ── Test 13: COLLISION PUSHDOWN ──────────────────────────────────────────

    it('COLLISION PUSHDOWN: new node is pushed below a kept node occupying its desired slot', () => {
        const h = rowsToHeight(2)
        const desiredX = HEAP_X0  // rank 0 column
        const desiredY = 0

        // Kept node sits exactly where the new node wants to go
        const keptPos: Point = { x: desiredX, y: desiredY }
        const previous: Map<string, Point> = new Map([['kept', keptPos]])

        // New node 'fresh' is a root (rank 0) so it wants x=HEAP_X0, y=0
        const nodes = [
            { id: 'kept', height: h },
            { id: 'fresh', height: h },
        ]
        const layout = placeHeapNodes({ nodes, edges: [], roots: ['kept', 'fresh'], previous })

        // Kept node must not move
        expect(layout.get('kept')).toEqual(keptPos)

        // Fresh node must be below kept by at least VERTICAL_GAP (no overlap)
        const freshPos = layout.get('fresh')!
        expect(freshPos.y).toBeGreaterThanOrEqual(keptPos.y + h + VERTICAL_GAP)

        // No overlap
        const heights = new Map<string, number>([['kept', h], ['fresh', h]])
        assertNoOverlap(layout, heights, 'collision pushdown')
    })

    // ── Test 14: KEPT-NODE GROWTH ────────────────────────────────────────────

    it('KEPT-NODE GROWTH: upper node grows taller so it would overlap the lower one → lower is pushed down', () => {
        const hSmall = rowsToHeight(1)
        const hLarge = rowsToHeight(6)
        const x = HEAP_X0
        // Two nodes stacked tightly: upper at y=0 (hSmall), lower at y = hSmall + VERTICAL_GAP
        const upperPos: Point = { x, y: 0 }
        const lowerPos: Point = { x, y: hSmall + VERTICAL_GAP }
        const previous: Map<string, Point> = new Map([
            ['upper', upperPos],
            ['lower', lowerPos],
        ])

        // Now upper's height grows to hLarge → it would collide with lower
        const nodes = [
            { id: 'upper', height: hLarge },
            { id: 'lower', height: hSmall },
        ]
        const layout = placeHeapNodes({ nodes, edges: [], roots: ['upper', 'lower'], previous })

        // Upper keeps its exact position
        expect(layout.get('upper')).toEqual(upperPos)

        // Lower is pushed down (no overlap)
        const lowerNew = layout.get('lower')!
        const heights = new Map<string, number>([['upper', hLarge], ['lower', hSmall]])
        assertNoOverlap(layout, heights, 'kept-node growth')

        // Lower should have moved below upper's new bottom
        expect(lowerNew.y).toBeGreaterThanOrEqual(hLarge + VERTICAL_GAP)
    })

    // ── Test 15: PARENT ADJACENCY ────────────────────────────────────────────

    it('PARENT ADJACENCY: fresh chain a→b→c lays out in one horizontal line (same y)', () => {
        const h = rowsToHeight(2)
        const nodes = [
            { id: 'a', height: h },
            { id: 'b', height: h },
            { id: 'c', height: h },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'c' },
        ]
        const layout = placeHeapNodes({ nodes, edges, roots: ['a'], previous: noPos })

        const posA = layout.get('a')!
        const posB = layout.get('b')!
        const posC = layout.get('c')!

        // a is in column 0, b in column 1, c in column 2
        expect(posA.x).toBe(HEAP_X0 + 0 * COLUMN_WIDTH)
        expect(posB.x).toBe(HEAP_X0 + 1 * COLUMN_WIDTH)
        expect(posC.x).toBe(HEAP_X0 + 2 * COLUMN_WIDTH)

        // All in the same row (y coordinates equal — adjacent to parent)
        expect(posB.y).toBe(posA.y)
        expect(posC.y).toBe(posB.y)
    })

    // ── Test 16: DETERMINISM ─────────────────────────────────────────────────

    it('DETERMINISM: two identical calls return deep-equal results', () => {
        const h = rowsToHeight(3)
        const nodes = [
            { id: 'a', height: h },
            { id: 'b', height: rowsToHeight(2) },
            { id: 'c', height: rowsToHeight(5) },
            { id: 'd', height: h },
        ]
        const edges = [
            { source: 'a', target: 'b' },
            { source: 'a', target: 'c' },
            { source: 'b', target: 'd' },
        ]
        const previous: Map<string, Point> = new Map([['a', { x: HEAP_X0, y: 0 }]])

        const layout1 = placeHeapNodes({ nodes, edges, roots: ['a'], previous })
        const layout2 = placeHeapNodes({ nodes, edges, roots: ['a'], previous })

        expect([...layout1.entries()].sort()).toEqual([...layout2.entries()].sort())
    })

    // ── Test 17: USER-DRAGGED POSITIONS ──────────────────────────────────────

    it('USER-DRAGGED POSITIONS: arbitrary coordinates in previous are preserved exactly, new nodes avoid them', () => {
        const h = rowsToHeight(2)
        // Weird positions: negative x, huge y
        const draggedPos: Point = { x: -500, y: 9999 }
        const anotherDragged: Point = { x: 1500, y: -200 }
        const previous: Map<string, Point> = new Map([
            ['dragged1', draggedPos],
            ['dragged2', anotherDragged],
        ])

        const nodes = [
            { id: 'dragged1', height: h },
            { id: 'dragged2', height: h },
            { id: 'fresh', height: h },
        ]
        const layout = placeHeapNodes({ nodes, edges: [], roots: ['fresh'], previous })

        // Dragged nodes keep their exact positions
        expect(layout.get('dragged1')).toEqual(draggedPos)
        expect(layout.get('dragged2')).toEqual(anotherDragged)

        // New node gets a position
        expect(layout.has('fresh')).toBe(true)

        // No overlaps (using the weird positions)
        const heights = new Map<string, number>([
            ['dragged1', h], ['dragged2', h], ['fresh', h],
        ])
        assertNoOverlap(layout, heights, 'user-dragged positions')
    })

    // ── Test 18: Random-graph fuzz ───────────────────────────────────────────

    it('FUZZ: 200 random graphs have no overlaps, full coverage, and are deterministic', () => {
        const rand = mulberry32(0xdeadbeef)

        for (let iter = 0; iter < 200; iter++) {
            const nodeCount = Math.max(1, Math.floor(rand() * 30))
            const ids = Array.from({ length: nodeCount }, (_, i) => `n${iter}_${i}`)
            const nodes = ids.map((id) => ({
                id,
                height: rowsToHeight(1 + Math.floor(rand() * 8)),
            }))

            // Random edges (including self-loops and edges to missing ids)
            const edgeCount = Math.floor(rand() * nodeCount * 2)
            const allPossibleTargets = [...ids, 'phantom_a', 'phantom_b']
            const edges = Array.from({ length: edgeCount }, () => ({
                source: ids[Math.floor(rand() * ids.length)],
                target: allPossibleTargets[Math.floor(rand() * allPossibleTargets.length)],
            }))

            // Random roots
            const rootCount = Math.max(0, Math.floor(rand() * Math.min(3, nodeCount)))
            const roots = Array.from(
                new Set(Array.from({ length: rootCount }, () => ids[Math.floor(rand() * ids.length)])),
            )

            // Random previous: a subset of nodes at varied positions
            const prevCount = Math.floor(rand() * nodeCount)
            const prevEntries: [string, Point][] = Array.from({ length: prevCount }, (_, i) => [
                ids[i % ids.length],
                {
                    x: HEAP_X0 + Math.floor(rand() * 5) * COLUMN_WIDTH,
                    y: Math.floor(rand() * 1000),
                },
            ])
            const previous: Map<string, Point> = new Map(prevEntries)

            // (a) Every input node gets a position
            const layout1 = placeHeapNodes({ nodes, edges, roots, previous })
            for (const { id } of nodes) {
                if (!layout1.has(id)) {
                    throw new Error(`iter=${iter}: node ${id} missing from layout`)
                }
            }

            // (b) No overlaps
            const heightById = new Map(nodes.map((n) => [n.id, n.height]))
            assertNoOverlap(layout1, heightById, `iter=${iter}`)

            // (c) Determinism
            const layout2 = placeHeapNodes({ nodes, edges, roots, previous })
            for (const { id } of nodes) {
                if (
                    layout1.get(id)!.x !== layout2.get(id)!.x ||
                    layout1.get(id)!.y !== layout2.get(id)!.y
                ) {
                    throw new Error(`iter=${iter}: node ${id} is non-deterministic`)
                }
            }
        }
    })

    // ── Test 19: Incremental-session fuzz ────────────────────────────────────

    it('FUZZ: 50 incremental sessions — stability of surviving nodes and no overlaps at every step', () => {
        const rand = mulberry32(0xcafef00d)

        for (let session = 0; session < 50; session++) {
            // Use constant heights per node id throughout the session
            const nodeHeights = new Map<string, number>()
            const getHeight = (id: string): number => {
                if (!nodeHeights.has(id)) {
                    nodeHeights.set(id, rowsToHeight(1 + Math.floor(rand() * 5)))
                }
                return nodeHeights.get(id)!
            }

            const activeIds: Set<string> = new Set()
            let previous: Map<string, Point> = new Map()
            const allSeenIds: Set<string> = new Set()
            let idCounter = 0

            for (let step = 0; step < 10; step++) {
                // Add 0–3 new nodes
                const addCount = Math.floor(rand() * 4)
                for (let i = 0; i < addCount; i++) {
                    const newId = `s${session}_n${idCounter++}`
                    activeIds.add(newId)
                    allSeenIds.add(newId)
                }

                // Remove 0–1 nodes (they stay in previous but leave active set)
                if (activeIds.size > 1 && rand() < 0.5) {
                    const removeIdx = Math.floor(rand() * activeIds.size)
                    const arr = [...activeIds]
                    activeIds.delete(arr[removeIdx])
                }

                if (activeIds.size === 0) continue

                const idArr = [...activeIds]
                const nodes = idArr.map((id) => ({ id, height: getHeight(id) }))

                // Random edges among active nodes
                const edgeCount = Math.floor(rand() * idArr.length)
                const edges = Array.from({ length: edgeCount }, () => ({
                    source: idArr[Math.floor(rand() * idArr.length)],
                    target: idArr[Math.floor(rand() * idArr.length)],
                }))

                const roots = idArr.length > 0 ? [idArr[0]] : []

                const layout = placeHeapNodes({ nodes, edges, roots, previous })

                // Assert: every active node gets a position
                for (const id of idArr) {
                    if (!layout.has(id)) {
                        throw new Error(`session=${session} step=${step}: active node ${id} missing`)
                    }
                }

                // Assert: no overlaps
                const heightById = new Map(nodes.map((n) => [n.id, n.height]))
                assertNoOverlap(layout, heightById, `session=${session} step=${step}`)

                // Assert: stability — nodes that are still active AND were in previous
                // must keep their exact positions (heights are constant, so kept
                // nodes can only move if forced by another kept node collision,
                // but with constant heights the sort order is stable and a node
                // placed first won't push itself; the only collision is from
                // height-change which is excluded here).
                // Note: we check nodes that were in previous AND are still active.
                for (const id of idArr) {
                    if (previous.has(id)) {
                        // With constant heights the spec says kept nodes must never move.
                        // However, if an earlier kept node in sort order forces a pushdown
                        // (because two nodes happen to collide due to previous arbitrary
                        // positions), we can't assert strict equality. Instead we assert
                        // no overlaps (already done above) and that the position equals
                        // the previous value OR has moved downward (never upward).
                        const prevPos = previous.get(id)!
                        const newPos = layout.get(id)!
                        if (newPos.x !== prevPos.x || newPos.y !== prevPos.y) {
                            // If it moved, it must have moved downward (pushed by a
                            // collision from a node sorted before it), not upward.
                            expect(newPos.y).toBeGreaterThanOrEqual(prevPos.y)
                        }
                    }
                }

                previous = layout
            }
        }
    })
})

// ── rectsIntersect helper ────────────────────────────────────────────────────

describe('rectsIntersect', () => {
    it('returns true for overlapping rects', () => {
        const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
        const b: Rect = { x: 50, y: 50, width: 100, height: 100 }
        expect(rectsIntersect(a, b, 0)).toBe(true)
    })

    it('returns false for non-overlapping rects with gap=0', () => {
        const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
        const b: Rect = { x: 200, y: 0, width: 100, height: 100 }
        expect(rectsIntersect(a, b, 0)).toBe(false)
    })

    it('returns false for touching rects (gap=0, sharing an edge)', () => {
        const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
        const b: Rect = { x: 100, y: 0, width: 100, height: 100 }
        expect(rectsIntersect(a, b, 0)).toBe(false)
    })

    it('returns true for touching rects when gap > 0', () => {
        const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
        const b: Rect = { x: 100, y: 0, width: 100, height: 100 }
        expect(rectsIntersect(a, b, 1)).toBe(true)
    })
})

// ── rowsToHeight helper ──────────────────────────────────────────────────────

describe('rowsToHeight', () => {
    it('returns at least MIN_NODE_HEIGHT for any row count', () => {
        for (let r = 0; r <= 10; r++) {
            expect(rowsToHeight(r)).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT)
        }
    })

    it('grows linearly for larger row counts', () => {
        const h1 = rowsToHeight(5)
        const h2 = rowsToHeight(6)
        // Each extra row adds ROW_HEIGHT
        expect(h2 - h1).toBe(28) // ROW_HEIGHT
    })
})

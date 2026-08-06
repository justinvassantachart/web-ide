import { describe, expect, it } from 'vitest'
import {
    clampPosition,
    parseStoredPosition,
    positionFromDrag,
    serializePosition,
} from '../../src/components/layout/toolbar-drag'

const toolbar = { width: 300, height: 32 }
const container = { width: 1000, height: 600 }

describe('clampPosition', () => {
    it('passes through positions fully inside the container', () => {
        expect(clampPosition({ x: 120, y: 40 }, toolbar, container)).toEqual({ x: 120, y: 40 })
    })
    it('clamps each edge', () => {
        expect(clampPosition({ x: -50, y: 40 }, toolbar, container).x).toBe(0)
        expect(clampPosition({ x: 120, y: -5 }, toolbar, container).y).toBe(0)
        expect(clampPosition({ x: 9999, y: 40 }, toolbar, container).x).toBe(700)
        expect(clampPosition({ x: 120, y: 9999 }, toolbar, container).y).toBe(568)
    })
    it('exact corner positions are stable (idempotent)', () => {
        const corner = { x: 700, y: 568 }
        expect(clampPosition(corner, toolbar, container)).toEqual(corner)
    })
    it('pins to the top-left when the container is smaller than the toolbar', () => {
        const tiny = { width: 100, height: 20 }
        expect(clampPosition({ x: 50, y: 50 }, toolbar, tiny)).toEqual({ x: 0, y: 0 })
    })
})

describe('positionFromDrag', () => {
    const origin = { x: 350, y: 6 }
    it('moves by the pointer delta', () => {
        expect(positionFromDrag(origin, { x: -100, y: 200 }, toolbar, container))
            .toEqual({ x: 250, y: 206 })
    })
    it('clamps a drag past the edges', () => {
        expect(positionFromDrag(origin, { x: -9999, y: -9999 }, toolbar, container))
            .toEqual({ x: 0, y: 0 })
        expect(positionFromDrag(origin, { x: 9999, y: 9999 }, toolbar, container))
            .toEqual({ x: 700, y: 568 })
    })
    it('a zero delta is a no-op', () => {
        expect(positionFromDrag(origin, { x: 0, y: 0 }, toolbar, container)).toEqual(origin)
    })
})

describe('serialize / parse round trip', () => {
    it('round-trips a position (rounded to integers)', () => {
        const parsed = parseStoredPosition(serializePosition({ x: 12.6, y: 90.2 }))
        expect(parsed).toEqual({ x: 13, y: 90 })
    })
    it.each([
        ['null input', null],
        ['empty string', ''],
        ['not json', 'garbage{'],
        ['wrong shape', '"hello"'],
        ['array', '[1,2]'],
        ['missing y', '{"x":5}'],
        ['non-numeric', '{"x":"5","y":2}'],
        ['NaN', '{"x":null,"y":2}'],
        ['infinity', '{"x":1e999,"y":2}'],
    ])('rejects %s', (_name, raw) => {
        expect(parseStoredPosition(raw)).toBeNull()
    })
    it('accepts out-of-bounds values (clamped later against the live container)', () => {
        expect(parseStoredPosition('{"x":99999,"y":-50}')).toEqual({ x: 99999, y: -50 })
    })
})

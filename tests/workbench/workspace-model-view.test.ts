import { describe, expect, it } from 'vitest'
import { mapOffset, textHunks } from '../../src/components/editor/workspace-model-view'

function apply(before: string, after: string) {
    return textHunks(before, after).reduceRight((text, edit) =>
        text.slice(0, edit.start) + edit.text + text.slice(edit.end), before)
}

describe('external workspace text mapping', () => {
    it('keeps distant unchanged source outside edited ranges', () => {
        const original = Array.from({ length: 10000 }, (_, i) => `line ${i}\n`).join('')
        const next = original.replace('line 10\n', 'inserted\nline 10\n')
            .replace('line 9000\n', 'changed\n')
        const edits = textHunks(original, next)
        expect(edits).toHaveLength(2)
        const anchor = original.indexOf('line 5000\n')
        expect(next.slice(mapOffset(anchor, edits))).toBe(original.slice(anchor).replace('line 9000\n', 'changed\n'))
        expect(apply(original, next)).toBe(next)
    })

    it('maps insertion boundaries forward and removed endpoints to the nearest survivor', () => {
        const edit = [{ start: 10, end: 20, text: 'new' }]
        expect([9, 10, 14, 15, 16, 20, 21].map(offset => mapOffset(offset, edit)))
            .toEqual([9, 10, 10, 10, 13, 13, 14])
        expect(mapOffset(10, [{ start: 10, end: 10, text: 'new' }])).toBe(13)
    })

    it.each([
        ['', ''], ['', '\n'], ['abc', ''], ['a\r\nb\r\n', 'a\r\nx\r\nb\r\n'],
        ['a😀b\n', 'a😁b\n'], ['a\n', 'a'], ['a', 'a\n'],
        ['same\n'.repeat(10000), 'new\n' + 'same\n'.repeat(10000)],
        ['a\nb\na\nb\n', 'b\na\nb\na\n'], ['\t a\n\t b', '\t x\n\t b'],
    ])('applies complete text without splitting CRLF or surrogate pairs (%j)', (before, after) => {
        expect(apply(before, after)).toBe(after)
        for (const edit of textHunks(before, after)) {
            for (const at of [edit.start, edit.end]) {
                expect(before.slice(at - 1, at + 1)).not.toBe('\r\n')
                const code = before.charCodeAt(at)
                expect(code >= 0xdc00 && code <= 0xdfff).toBe(false)
            }
        }
    })

    it('reconstructs bounded adversarial repeated documents deterministically', () => {
        let seed = 531
        const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
        for (let i = 0; i < 300; i++) {
            const doc = () => Array.from({ length: random() % 90 }, () =>
                ['x\n', 'y\r\n', '😀\n', '\n', 'last'][random() % 5]).join('')
            const before = doc(), after = doc()
            expect(apply(before, after)).toBe(after)
        }
    })
})

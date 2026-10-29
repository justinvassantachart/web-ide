import { describe, expect, it, vi } from 'vitest'
import { classifyDebugType, DebugValueCapture, type DapVariable } from '../../src/runtimes/debug-values'

function fixture(total = 101) {
  let active = true
  const updated = vi.fn()
  const send = vi.fn((handle: number, page: { start: number; count: number }) => ({
    success: true,
    body: { variables: handle === 1
      ? [{ name: 'v', type: 'Vector<int*>', value: '@1024', memoryReference: '1024', variablesReference: 2, indexedVariables: total }]
      : Array.from({ length: Math.min(page.count, Math.max(0, total - page.start)) }, (_, i) => ({ name: `[${page.start + i}]`, value: String(page.start + i), type: 'int', variablesReference: 0 })),
    },
  }))
  const capture = new DebugValueCapture('pause', true, () => active, send, updated)
  const root = capture.captureScope(1)[0]
  return { capture, root, send, updated, resume: () => { active = false } }
}

describe('pause-scoped raw values', () => {
  it('classifies only the outer declarator and preserves unreadable non-null pointers', () => {
    expect(classifyDebugType('Vector<int*>')).toBe('value')
    expect(classifyDebugType('const Map<string, Vector<int*>>&')).toBe('reference')
    expect(classifyDebugType('Vector<int*> * const')).toBe('pointer')
    expect(classifyDebugType('Vector<int*')).toBe('unknown')
    const variables: DapVariable[] = [
      { name: 'p', type: 'int*', value: '0xffff0000', variablesReference: 0 },
      { name: 'q', type: 'int*', value: '<unavailable>', variablesReference: 0 },
      { name: 's', type: 'Vector<int>', value: '<error: bad storage>', variablesReference: 0 },
    ]
    const capture = new DebugValueCapture('p', true, () => true, () => ({ success: true, body: { variables } }), () => {})
    const [p, q, s] = capture.captureScope(1)
    expect(p).toMatchObject({ value: '0xffff0000', pointsTo: 4294901760, isPointer: true })
    expect(q).toMatchObject({ value: '<unavailable>', availability: 'unavailable' })
    expect(q.pointsTo).toBeUndefined()
    expect(s.availability).toBe('unavailable')
    expect(p).not.toHaveProperty('size')
  })

  it('captures 100 of 101, deduplicates a later page and keeps the old revision immutable', async () => {
    const { capture, root, send, updated } = fixture()
    expect(root.childrenInfo).toEqual({ total: 101, loaded: 100, complete: false })
    const requests = send.mock.calls.length
    const [a, b] = await Promise.all([
      capture.readChildren(root.debugRef!, { start: 100, count: 100 }),
      capture.readChildren(root.debugRef!, { start: 100, count: 100 }),
    ])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ start: 100, total: 101, complete: true, children: [{ name: '[100]', debugOrdinal: 100 }] })
    expect(send.mock.calls.length).toBe(requests + 1)
    expect(updated).toHaveBeenCalledTimes(1)
    expect(root.members).toHaveLength(100)
    expect(capture.read(root.debugRef!)?.childrenInfo).toEqual({ total: 101, loaded: 101, complete: true })
  })

  it.each([99, 100, 101])('reports exact completeness for %i children', (total) => {
    const { root } = fixture(total)
    expect(root.childrenInfo).toEqual({ total, loaded: Math.min(total, 100), complete: total <= 100 })
  })

  it('reuses overlapping captured ranges instead of reading them twice', async () => {
    const { capture, root, send } = fixture(300)
    await Promise.all([
      capture.readChildren(root.debugRef!, { start: 50, count: 100 }),
      capture.readChildren(root.debugRef!, { start: 125, count: 100 }),
    ])
    expect(send.mock.calls.slice(2).map(([, page]) => page)).toEqual([
      { start: 100, count: 50 }, { start: 150, count: 75 },
    ])
  })

  it('rejects foreign pause identities even when native handles are reused', async () => {
    const old = fixture()
    const send = vi.fn(() => ({ success: true, body: { variables: [] } }))
    const next = new DebugValueCapture('next-pause', true, () => true, send, () => {})
    expect(await next.readChildren(old.root.debugRef!, { start: 100, count: 1 })).toMatchObject({ availability: 'unavailable' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not commit when execution resumes during a native request', async () => {
    let active = true
    const updated = vi.fn()
    let failAfterCapture = false
    const capture = new DebugValueCapture('p', true, () => active, (handle, page) => {
      if (failAfterCapture) active = false
      return { success: true, body: { variables: handle === 1
        ? [{ name: 'v', value: '@12', variablesReference: 2, indexedVariables: 101 }]
        : Array.from({ length: Math.min(page.count, 101 - page.start) }, (_, i) => ({ name: String(i), value: '1', variablesReference: 0 })) } }
    }, updated)
    const root = capture.captureScope(1)[0]
    failAfterCapture = true
    expect(await capture.readChildren(root.debugRef!, { start: 100, count: 1 })).toMatchObject({ availability: 'unavailable' })
    expect(updated).not.toHaveBeenCalled()
    expect(capture.read(root.debugRef!)?.members).toHaveLength(100)
  })

  it('validates the pause before sending a queued request', async () => {
    const { capture, root, send, resume } = fixture()
    const before = send.mock.calls.length
    const queued = capture.readChildren(root.debugRef!, { start: 100, count: 1 })
    resume()
    expect(await queued).toMatchObject({ complete: false, availability: 'partial' })
    expect(send.mock.calls).toHaveLength(before)
  })

  it('keeps noninitial pages sparse and enforces the total node budget', async () => {
    const { capture, root, send } = fixture(2000)
    await capture.readChildren(root.debugRef!, { start: 300, count: 100 })
    expect(capture.read(root.debugRef!)?.members?.[100].debugOrdinal).toBe(300)
    for (let start = 400; start < 2000; start += 100) {
      await capture.readChildren(root.debugRef!, { start, count: 10000 })
    }
    expect(capture.read(root.debugRef!)!.members!.length).toBeLessThanOrEqual(999)
    expect(send.mock.calls.every(([, page]) => page.count <= 100)).toBe(true)
  })

  it('does not reinterpret a failed request as an empty container', async () => {
    const updated = vi.fn()
    const capture = new DebugValueCapture('p', true, () => true, (handle) => handle === 1
      ? { success: true, body: { variables: [{ name: 'v', value: '@12', variablesReference: 2 }] } }
      : { success: false }, updated)
    const value = capture.captureScope(1)[0]
    expect(value.childrenInfo).toEqual({ total: undefined, loaded: 0, complete: false })
    expect(await capture.readChildren(value.debugRef!, { start: 0, count: 100 })).toMatchObject({ complete: false, availability: 'partial' })
    await capture.readChildren(value.debugRef!, { start: 0, count: 100 })
    expect(updated).not.toHaveBeenCalled()
  })
})

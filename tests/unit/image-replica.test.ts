import { describe, it, expect } from 'vitest'
import { createImageResourceReplica, parseImageServiceEvent } from '../../src/assets/image-replica'
const ref = { resourceId: 'image', version: 1, width: 1, height: 1, byteLength: 4 }
describe('worker image replica', () => {
  it('owns bytes, fences generations and requires ordered resources before presentations', () => {
    const store = createImageResourceReplica()
    store.reset(1)
    expect(store.apply({ kind: 'reset' }, 0)).toBe(false)
    expect(() => store.apply({ kind: 'presentation', presentation: { presentationId: 'p', title: 'Photo', resource: ref } }, 1)).toThrow(/before/)
    const bytes = new Uint8Array([1, 2, 3, 255])
    store.apply({ kind: 'resource', resource: ref, rgba: bytes }, 1)
    bytes[0] = 10
    expect(store.getResource(ref).data[0]).toBe(1)
    store.apply({ kind: 'presentation', presentation: { presentationId: 'p', title: 'Photo', resource: ref } }, 1)
    expect(store.snapshot().presentations).toHaveLength(1)
    store.reset(2)
    expect(() => store.getResource(ref)).toThrow(/unavailable/)
  })
  it('accounts renderer allocations and release with reset-safe reservations', () => {
    const store = createImageResourceReplica({ limits: { maxResidentBytes: 8 } })
    store.apply({ kind: 'resource', resource: ref, rgba: new Uint8Array(4) })
    const release = store.reserveExternalBytes(4)
    expect(() => store.reserveExternalBytes(1)).toThrow(/budget/)
    release(); release()
    expect(() => store.reserveExternalBytes(4)).not.toThrow()
    store.reset()
    release()
    expect(() => store.reserveExternalBytes(9)).toThrow(/budget/)
  })
  it('rejects inconsistent buffers and dimensions before copying', () => {
    expect(() => parseImageServiceEvent({ kind: 'resource', resource: ref, rgba: new Uint8Array(3) })).toThrow(/bytes/)
    expect(() => parseImageServiceEvent({ kind: 'resource', resource: { ...ref, width: 100000 }, rgba: new Uint8Array(4) })).toThrow(/dimensions/)
  })
  it('keeps old renderer allocations charged through reset until their cleanup runs', () => {
    const store = createImageResourceReplica({ limits: { maxResidentBytes: 8 } })
    const release = store.reserveExternalBytes(8)
    store.reset()
    expect(() => store.apply({ kind: 'resource', resource: ref, rgba: new Uint8Array(4) })).toThrow(/budget/)
    release()
    expect(store.apply({ kind: 'resource', resource: ref, rgba: new Uint8Array(4) })).toBe(true)
  })
})

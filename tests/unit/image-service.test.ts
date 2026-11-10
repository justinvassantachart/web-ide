import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64, createImageService, normalizeWorkspaceDocument, type ImageCodec, type ImageResourceRef, type ImageService, type ImageServiceEvent } from '../../src/assets'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const pixel = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }
const codec: ImageCodec = { decode: async () => pixel, encode: async () => ({ bytes: new Uint8Array(png), mediaType: 'image/png' }) }
const services: ImageService[] = []
function service(options: Parameters<typeof createImageService>[0] = {}) { const value = createImageService({ codec, ...options }); services.push(value); return value }
afterEach(() => { services.splice(0).forEach((value) => value.dispose()); vi.useRealTimers() })

describe('shared run-owned image service', () => {
  it('shares canonical Unicode paths and text rules with source workspaces', () => {
    const document = normalizeWorkspaceDocument({ schemaVersion: 2, files: [{ path: '/workspace/cafe\u0301.py', content: 'a\r\nb\r' }], assets: [] })
    expect(document.files[0]).toEqual({ path: '/workspace/café.py', content: 'a\nb\n' })
    expect(() => normalizeWorkspaceDocument({ ...document, files: [...document.files, { path: '/workspace/cafe\u0301.py', content: '' }] })).toThrow(/Conflicting/)
    expect(() => normalizeWorkspaceDocument({ ...document, files: [{ path: '/workspace/\ud800.py', content: '' }] })).toThrow()
  })
  it('publishes replacement presentations before releasing their previous pixels', async () => {
    const events: ImageServiceEvent[] = []
    const images = service({ onEvent: (event) => events.push(event) })
    const first = images.publishResource(pixel)
    await images.dispatch({ op: 'presentation.show', ...first, presentationId: 'main' })
    await images.dispatch({ op: 'resource.release', ...first })
    const next = images.publishResource(pixel)
    events.length = 0
    await images.dispatch({ op: 'presentation.show', ...next, presentationId: 'main' })
    expect(events.map((event) => event.kind)).toEqual(['presentation', 'resource-release'])
  })
  it('rejects incomplete, overlapping and oversized chunks; owns decoded pixels', async () => {
    const images = service()
    const { transferId } = await images.dispatch({ op: 'encoded.begin', length: png.length }) as { transferId: string }
    await expect(images.dispatch({ op: 'encoded.decode', transferId })).rejects.toMatchObject({ code: 'INVALID_TRANSFER' })
    await expect(images.dispatch({ op: 'transfer.write', transferId, offset: 1, base64: bytesToBase64(png) })).rejects.toMatchObject({ code: 'INVALID_TRANSFER' })
    await images.dispatch({ op: 'transfer.write', transferId, offset: 0, base64: bytesToBase64(png) })
    const ref = await images.dispatch({ op: 'encoded.decode', transferId }) as ImageResourceRef
    const owned = images.getResource(ref); owned.data.fill(0)
    expect(images.getResource(ref).data).toEqual(pixel.data)
    await expect(images.dispatch({ op: 'encoded.decode', transferId })).rejects.toMatchObject({ code: 'INVALID_TRANSFER' })
  })
  it('retains scene/presentation versions after guest release and normal exit, resets old handles', async () => {
    const events: ImageServiceEvent[] = []
    const images = service({ onEvent: (event) => events.push(event) })
    const first = images.publishResource(pixel)
    images.retainResource(first)
    const next = images.publishResource({ ...pixel, data: new Uint8Array([0, 255, 0, 255]) }, first.resourceId)
    await images.dispatch({ op: 'presentation.show', ...next, presentationId: 'main' })
    await images.dispatch({ op: 'resource.release', ...first })
    await images.dispatch({ op: 'resource.release', ...next })
    expect(images.getResource(first).data[0]).toBe(255)
    images.releaseResource(first)
    expect(() => images.getResource(first)).toThrow()
    images.disconnect()
    expect((await images.downloadPresentation('main')).bytes).toEqual(png)
    expect(events[0].kind).toBe('resource')
    images.reset()
    expect(images.snapshot().resources).toEqual([])
    expect(() => images.getResource(next)).toThrow()
  })
  it('keeps successful upload leases when the request signal is aborted after reply', async () => {
    const images = service()
    const request = new AbortController()
    const result = await images.dispatch({ op: 'rgba.begin', width: 1, height: 1 }, request.signal) as { transferId: string }
    request.abort()
    await images.dispatch({ op: 'transfer.write', ...result, offset: 0, base64: bytesToBase64(pixel.data) })
    expect(await images.dispatch({ op: 'rgba.commit', ...result })).toMatchObject({ width: 1, height: 1 })
  })
  it('prevents an asynchronous decode from publishing into a replacement run', async () => {
    let resolve!: (value: typeof pixel) => void
    const images = service({ codec: { ...codec, decode: () => new Promise((done) => { resolve = done }) } })
    const result = await images.dispatch({ op: 'encoded.begin', length: png.length }) as { transferId: string }
    await images.dispatch({ op: 'transfer.write', ...result, offset: 0, base64: bytesToBase64(png) })
    const pending = images.dispatch({ op: 'encoded.decode', ...result })
    images.reset(); resolve(pixel)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(images.snapshot().resources).toEqual([])
    // Old finally blocks and renderer releases cannot subtract from the new budget.
    const release = images.reserveExternalBytes(images.limits.maxResidentBytes)
    expect(() => images.publishResource(pixel)).toThrow()
    release(); expect(images.publishResource(pixel).width).toBe(1)
  })
  it('charges external renderer allocations and expires abandoned transfers', async () => {
    vi.useFakeTimers()
    const images = service({ limits: { maxResidentBytes: 16, transferTimeoutMs: 10 } })
    const release = images.reserveExternalBytes(12)
    const result = await images.dispatch({ op: 'rgba.begin', width: 1, height: 1 }) as { transferId: string }
    expect(() => images.publishResource(pixel)).toThrow()
    vi.advanceTimersByTime(11)
    await expect(images.dispatch({ op: 'rgba.commit', ...result })).rejects.toMatchObject({ code: 'INVALID_TRANSFER' })
    release(); release()
    expect(images.publishResource(pixel).byteLength).toBe(4)
  })
  it.each(['reset', 'release', 'timeout'] as const)('charges the pending decode input after %s removes its transfer', async (action) => {
    vi.useFakeTimers()
    let resolve!: (value: typeof pixel) => void
    const images = service({ limits: { maxResidentBytes: 1024, transferTimeoutMs: 10 }, codec: { ...codec, decode: () => new Promise((done) => { resolve = done }) } })
    const transfer = await images.dispatch({ op: 'encoded.begin', length: png.length }) as { transferId: string }
    await images.dispatch({ op: 'transfer.write', ...transfer, offset: 0, base64: bytesToBase64(png) })
    const pending = images.dispatch({ op: 'encoded.decode', ...transfer })
    if (action === 'reset') images.reset()
    else if (action === 'release') await images.dispatch({ op: 'transfer.release', ...transfer })
    else vi.advanceTimersByTime(11)
    const free = images.reserveExternalBytes(1024 - 12 - png.length)
    expect(() => images.reserveExternalBytes(1)).toThrow(/budget/)
    free(); resolve(pixel)
    if (action === 'reset') await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    else await pending
    images.reset()
    images.reserveExternalBytes(1024)()
  })
  it('drops completed malformed encoded transfers immediately', async () => {
    const images = service({ limits: { maxResidentBytes: 32 } })
    const transfer = await images.dispatch({ op: 'encoded.begin', length: 32 }) as { transferId: string }
    await images.dispatch({ op: 'transfer.write', ...transfer, offset: 0, base64: bytesToBase64(new Uint8Array(32)) })
    await expect(images.dispatch({ op: 'encoded.decode', ...transfer })).rejects.toThrow()
    images.reserveExternalBytes(32)()
  })
  it('bounds tiny resource metadata and forgets fully collected logical IDs', async () => {
    const images = service()
    for (let i = 0; i < 1000; i++) {
      const ref = images.publishResource(pixel)
      await images.dispatch({ op: 'resource.release', ...ref })
      expect(() => images.publishResource(pixel, ref.resourceId)).toThrow(/unknown/)
    }
    const refs = Array.from({ length: 256 }, () => images.publishResource(pixel))
    expect(() => images.publishResource(pixel)).toThrow(/live image revisions/)
    await images.dispatch({ op: 'resource.release', ...refs[0] })
    expect(images.publishResource(pixel).width).toBe(1)
  })
  it('cancels retained downloads on reset while keeping codec reservations until settlement', async () => {
    let resolve!: (value: { bytes: Uint8Array; mediaType: 'image/png' }) => void
    let encodeSignal: AbortSignal | undefined
    const images = service({ codec: { ...codec, encode: async (_pixels, _type, _quality, signal) => { encodeSignal = signal; return new Promise((done) => { resolve = done }) } } })
    const ref = images.publishResource(pixel)
    await images.dispatch({ op: 'presentation.show', ...ref, presentationId: 'main' })
    images.disconnect()
    const pending = images.downloadPresentation('main')
    expect(encodeSignal?.aborted).toBe(false)
    images.reset()
    expect(encodeSignal?.aborted).toBe(true)
    const free = images.reserveExternalBytes(images.limits.maxResidentBytes - 12 - images.limits.maxEncodedBytes)
    expect(() => images.reserveExternalBytes(1)).toThrow(/budget/)
    free()
    resolve({ bytes: png, mediaType: 'image/png' })
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    images.reserveExternalBytes(images.limits.maxResidentBytes)()
  })
  it('permits repeated saves after releasing completed transfers without replaying expired receipts', async () => {
    const images = service()
    const ref = images.publishResource(pixel)
    for (let i = 0; i < 300; i++) {
      const encoded = await images.dispatch({ op: 'resource.encode', ...ref, mediaType: 'image/png' }) as { transferId: string }
      await images.dispatch({ op: 'output.prepare', ...encoded, transactionId: `save-${i}`, path: '/workspace/out.png' })
      await images.dispatch({ op: 'output.commit', transactionId: `save-${i}` })
      await images.dispatch({ op: 'transfer.release', ...encoded })
    }
    expect(images.snapshot().outputs[0].version).toBe(300)
    await expect(images.dispatch({ op: 'output.commit', transactionId: 'save-0' })).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' })
    expect(images.snapshot().outputs[0].version).toBe(300)
  })
  it('commits generated outputs exactly once and retains the prior output on failed replacement', async () => {
    const images = service()
    const ref = images.publishResource(pixel)
    const encoded = await images.dispatch({ op: 'resource.encode', ...ref, mediaType: 'image/png' }) as { transferId: string }
    await images.dispatch({ op: 'output.prepare', ...encoded, transactionId: 'save-1', path: '/workspace/out.png' })
    expect(images.snapshot().outputs).toEqual([])
    const output = await images.dispatch({ op: 'output.commit', transactionId: 'save-1' }) as { outputId: string }
    expect(await images.dispatch({ op: 'output.commit', transactionId: 'save-1' })).toEqual(output)
    await images.dispatch({ op: 'output.prepare', ...encoded, transactionId: 'save-2', path: '/workspace/out.png' })
    await images.dispatch({ op: 'output.abort', transactionId: 'save-2' })
    await expect(images.dispatch({ op: 'output.commit', transactionId: 'save-2' })).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' })
    expect(images.getOutput(output.outputId).bytes).toEqual(png)
    images.disconnect()
    expect(images.getOutput(output.outputId).bytes).toEqual(png)
  })
})

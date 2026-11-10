import { ImageServiceError, MAX_IMAGE_RESOURCE_REVISIONS, type EncodedImage, type ImageCodec, type ImageLimits, type ImageOutput, type ImagePixels, type ImagePresentation, type ImageResourceRef, type ImageService, type ImageServiceEvent, type ImageServiceOptions } from './contracts'
import { createBrowserImageCodec } from './browser-codec'
import { assertImageActive, base64ToBytes, bytesToBase64, imageInteger, imageMediaType, imageString, inspectImage, normalizeAssetPath, resolveImageLimits, validateImageDimensions } from './validation'

type Ref = Pick<ImageResourceRef, 'resourceId' | 'version'>
type Resource = { ref: ImageResourceRef; pixels: ImagePixels; owner: boolean; pins: number }
type Transfer = { id: string; kind: 'encoded' | 'rgba' | 'read'; bytes: Uint8Array; written: number; mediaType?: EncodedImage['mediaType']; width?: number; height?: number; resourceId?: string; timer: ReturnType<typeof setTimeout> }
type OutputReceipt = { path: string; transferId: string; state: 'prepared' | 'committed' | 'aborted'; encoded?: EncodedImage; result?: ImageOutput }
const resourceKey = (ref: Ref) => `${ref.resourceId}:${ref.version}`

/** One run-owned service shared by all language adapters and renderers. */
export function createImageService(options: ImageServiceOptions = {}): ImageService {
  return new RunImageService(options)
}

class RunImageService implements ImageService {
  readonly limits: ImageLimits
  private readonly codec: ImageCodec
  private readonly onEvent?: (event: ImageServiceEvent) => void
  private generation = 1
  private sequence = 0
  private residentBytes = 0
  private externalBytes = 0
  private transferBytes = 0
  private connected = true
  private disposed = false
  private runAbort = new AbortController()
  private lifetimeAbort = new AbortController()
  private resources = new Map<string, Resource>()
  private versions = new Map<string, number>()
  private transfers = new Map<string, Transfer>()
  private presentations = new Map<string, ImagePresentation>()
  private outputs = new Map<string, { output: ImageOutput; encoded: EncodedImage }>()
  private receipts = new Map<string, OutputReceipt>()

  constructor(options: ImageServiceOptions) {
    this.limits = resolveImageLimits(options.limits)
    this.codec = options.codec ?? createBrowserImageCodec(this.limits)
    this.onEvent = options.onEvent
  }
  private emit(event: ImageServiceEvent): void {
    // Observers must not turn an already committed resource into a failed request.
    try { this.onEvent?.(event) } catch { /* adapter isolates its observer failure */ }
  }
  private active(): void {
    if (this.disposed || !this.connected) throw new ImageServiceError('CANCELLED', 'Image run has ended')
  }
  private allocate(size: number): void {
    if (size > this.limits.maxResidentBytes - this.residentBytes - this.externalBytes) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Image memory budget exceeded')
    this.residentBytes += size
  }
  reserveExternalBytes(byteLength: number): () => void {
    if (this.disposed) throw new ImageServiceError('CANCELLED', 'Image service disposed')
    const size = imageInteger(byteLength, 'allocation size')
    if (size > this.limits.maxResidentBytes - this.residentBytes - this.externalBytes) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Image memory budget exceeded')
    this.externalBytes += size
    let released = false
    return () => {
      if (released) return
      released = true
      // A reset cannot free an in-flight browser codec or a mounted renderer.
      // Keep that reservation until its actual owner releases it.
      this.externalBytes -= size
    }
  }
  private id(kind: string): string { return `${kind}-${this.generation}-${++this.sequence}` }
  private find(ref: Ref): Resource {
    const resource = this.resources.get(resourceKey(ref))
    if (!resource) throw new ImageServiceError('STALE_RESOURCE', 'Image resource is unavailable or belongs to an earlier run')
    return resource
  }
  private collect(resource: Resource): void {
    if (resource.owner || resource.pins > 0) return
    this.resources.delete(resourceKey(resource.ref))
    if (![...this.resources.values()].some((other) => other.ref.resourceId === resource.ref.resourceId)) this.versions.delete(resource.ref.resourceId)
    this.residentBytes -= resource.ref.byteLength
    this.emit({ kind: 'resource-release', resource: resource.ref })
  }
  retainResource(ref: Ref): void { this.find(ref).pins += 1 }
  releaseResource(ref: Ref): void {
    const resource = this.resources.get(resourceKey(ref))
    if (!resource) return
    if (resource.pins > 0) resource.pins -= 1
    this.collect(resource)
  }
  publishResource(pixels: ImagePixels, existingId?: string): ImageResourceRef {
    this.active()
    const size = validateImageDimensions(pixels.width, pixels.height, this.limits)
    if (!(pixels.data instanceof Uint8Array) || pixels.data.length !== size) throw new ImageServiceError('INVALID_IMAGE', 'Invalid RGBA length')
    const resourceId = existingId === undefined ? this.id('image') : imageString(existingId, 'resource identity')
    if (existingId !== undefined && !this.versions.has(existingId)) throw new ImageServiceError('STALE_RESOURCE', 'Cannot update an unknown image')
    if (this.resources.size >= MAX_IMAGE_RESOURCE_REVISIONS) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many live image revisions')
    this.allocate(size)
    const version = (this.versions.get(resourceId) ?? 0) + 1
    const ref = Object.freeze({ resourceId, version, width: pixels.width, height: pixels.height, byteLength: size })
    const owned = { width: pixels.width, height: pixels.height, data: new Uint8Array(pixels.data) }
    this.versions.set(resourceId, version)
    this.resources.set(resourceKey(ref), { ref, pixels: owned, owner: true, pins: 0 })
    this.emit({ kind: 'resource', resource: ref, rgba: new Uint8Array(owned.data) })
    return ref
  }
  getResource(ref: Ref): ImagePixels {
    const { pixels } = this.find(ref)
    return { width: pixels.width, height: pixels.height, data: new Uint8Array(pixels.data) }
  }
  snapshot() {
    return Object.freeze({ resources: Object.freeze([...this.resources.values()].map((value) => value.ref)), presentations: Object.freeze([...this.presentations.values()]), outputs: Object.freeze([...this.outputs.values()].map((value) => value.output)) })
  }
  private transfer(id: unknown): Transfer {
    const transfer = this.transfers.get(imageString(id, 'transfer identity'))
    if (!transfer) throw new ImageServiceError('INVALID_TRANSFER', 'Image transfer expired or is unavailable')
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => this.dropTransfer(transfer.id), this.limits.transferTimeoutMs)
    return transfer
  }
  private newTransfer(kind: Transfer['kind'], length: number, extra: Partial<Transfer> = {}): Transfer {
    if (this.transfers.size >= 128 || length > this.limits.maxTransferBytes - this.transferBytes) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Image transfer budget exceeded')
    this.allocate(length)
    this.transferBytes += length
    const id = this.id('transfer')
    const transfer: Transfer = { ...extra, id, kind, bytes: new Uint8Array(length), written: 0, timer: setTimeout(() => this.dropTransfer(id), this.limits.transferTimeoutMs) }
    this.transfers.set(id, transfer)
    return transfer
  }
  private dropTransfer(id: string): void {
    const transfer = this.transfers.get(id)
    if (!transfer) return
    clearTimeout(transfer.timer)
    this.transfers.delete(id)
    this.residentBytes -= transfer.bytes.length
    this.transferBytes -= transfer.bytes.length
  }
  private complete(transfer: Transfer, kind: Transfer['kind']): void {
    if (transfer.kind !== kind || transfer.written !== transfer.bytes.length) throw new ImageServiceError('INVALID_TRANSFER', 'Image transfer is incomplete or has the wrong type')
  }
  private chunk(bytes: Uint8Array, offsetValue: unknown, lengthValue: unknown) {
    const offset = imageInteger(offsetValue, 'offset', 0, bytes.length)
    const length = imageInteger(lengthValue, 'chunk length', 1, this.limits.maxChunkBytes)
    return { offset, base64: bytesToBase64(bytes.subarray(offset, Math.min(offset + length, bytes.length))), byteLength: bytes.length }
  }
  private requestSignal(signal?: AbortSignal): { signal: AbortSignal; close(): void } {
    const controller = new AbortController()
    const runSignal = this.runAbort.signal
    const abort = () => controller.abort()
    runSignal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (runSignal.aborted || signal?.aborted) abort()
    return { signal: controller.signal, close() { runSignal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort) } }
  }
  async dispatch(request: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    this.active()
    const scope = this.requestSignal(signal)
    try {
      assertImageActive(scope.signal)
      const op = imageString(request.op, 'image operation')
      switch (op) {
        case 'capabilities': return { version: 1, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], limits: this.limits }
        case 'encoded.begin': {
          const length = imageInteger(request.length, 'encoded length', 1, this.limits.maxEncodedBytes)
          const transfer = this.newTransfer('encoded', length, { mediaType: request.mediaType === undefined ? undefined : imageMediaType(request.mediaType) })
          return { transferId: transfer.id }
        }
        case 'rgba.begin': {
          const length = validateImageDimensions(request.width, request.height, this.limits)
          const resourceId = request.resourceId === undefined ? undefined : imageString(request.resourceId, 'resource identity')
          if (resourceId !== undefined && !this.versions.has(resourceId)) throw new ImageServiceError('STALE_RESOURCE', 'Cannot update an unknown image')
          const transfer = this.newTransfer('rgba', length, { width: request.width as number, height: request.height as number, resourceId })
          return { transferId: transfer.id }
        }
        case 'transfer.write': {
          const transfer = this.transfer(request.transferId)
          if (transfer.kind === 'read') throw new ImageServiceError('INVALID_TRANSFER', 'Encoded output is read-only')
          const offset = imageInteger(request.offset, 'offset')
          const bytes = base64ToBytes(request.base64, this.limits.maxChunkBytes)
          if (offset !== transfer.written || bytes.length === 0 || bytes.length > transfer.bytes.length - offset) throw new ImageServiceError('INVALID_TRANSFER', 'Image chunks must be complete and sequential')
          transfer.bytes.set(bytes, offset)
          transfer.written += bytes.length
          return { offset: transfer.written }
        }
        case 'encoded.decode': {
          const transfer = this.transfer(request.transferId)
          this.complete(transfer, 'encoded')
          let release: (() => void) | undefined
          try {
            const info = inspectImage(transfer.bytes, transfer.mediaType, this.limits)
            // Keep the codec's input charged even if reset/release/timeout drops
            // its transfer. Decode also owns bitmap, canvas and copied RGBA.
            release = this.reserveExternalBytes(validateImageDimensions(info.width, info.height, this.limits) * 3 + transfer.bytes.length)
            const pixels = await this.codec.decode(transfer.bytes, info.mediaType, scope.signal)
            assertImageActive(scope.signal)
            return this.publishResource(pixels)
          } finally { release?.(); this.dropTransfer(transfer.id) }
        }
        case 'rgba.commit': {
          const transfer = this.transfer(request.transferId)
          this.complete(transfer, 'rgba')
          try { return this.publishResource({ width: transfer.width!, height: transfer.height!, data: transfer.bytes }, transfer.resourceId) }
          finally { this.dropTransfer(transfer.id) }
        }
        case 'resource.read': return this.chunk(this.find(this.parseRef(request)).pixels.data, request.offset, request.length)
        case 'resource.encode': {
          const ref = this.parseRef(request)
          const encoded = await this.encode(ref, imageMediaType(request.mediaType), request.quality, scope.signal)
          assertImageActive(scope.signal)
          const transfer = this.newTransfer('read', encoded.bytes.length, { mediaType: encoded.mediaType })
          transfer.bytes.set(encoded.bytes)
          transfer.written = transfer.bytes.length
          return { transferId: transfer.id, byteLength: transfer.bytes.length, mediaType: encoded.mediaType }
        }
        case 'transfer.read': {
          const transfer = this.transfer(request.transferId)
          this.complete(transfer, 'read')
          return this.chunk(transfer.bytes, request.offset, request.length)
        }
        case 'transfer.release': this.dropTransfer(imageString(request.transferId, 'transfer identity')); return {}
        case 'resource.release': {
          const resource = this.resources.get(resourceKey(this.parseRef(request)))
          if (resource) { resource.owner = false; this.collect(resource) }
          return {}
        }
        case 'presentation.show': {
          const resource = this.find(this.parseRef(request))
          const presentationId = imageString(request.presentationId, 'presentation identity')
          const previous = this.presentations.get(presentationId)
          if (!previous && this.presentations.size >= this.limits.maxPresentations) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many image presentations')
          const title = request.title === undefined ? 'Image' : imageString(request.title, 'presentation title', 512)
          this.retainResource(resource.ref)
          const presentation = Object.freeze({ presentationId, title, resource: resource.ref })
          this.presentations.set(presentationId, presentation)
          this.emit({ kind: 'presentation', presentation })
          if (previous) this.releaseResource(previous.resource)
          return { presentationId }
        }
        case 'output.prepare': return this.prepareOutput(request)
        case 'output.commit': return this.commitOutput(imageString(request.transactionId, 'output transaction'))
        case 'output.abort': {
          const receipt = this.receipts.get(imageString(request.transactionId, 'output transaction'))
          if (receipt?.state === 'prepared') { this.residentBytes -= receipt.encoded!.bytes.length; receipt.encoded = undefined; receipt.state = 'aborted' }
          return {}
        }
        default: throw new ImageServiceError('INVALID_IMAGE', `Unknown image operation: ${op}`)
      }
    } finally { scope.close() }
  }
  private parseRef(request: Readonly<Record<string, unknown>>): Ref {
    return { resourceId: imageString(request.resourceId, 'resource identity'), version: imageInteger(request.version, 'resource version', 1) }
  }
  private async encode(ref: Ref, mediaType: EncodedImage['mediaType'], quality: unknown, signal?: AbortSignal): Promise<EncodedImage> {
    const resource = this.find(ref)
    if (quality !== undefined && (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1)) throw new ImageServiceError('ENCODE_FAILED', 'Invalid image quality')
    this.retainResource(ref)
    let release: (() => void) | undefined
    try {
      // The input survives reset along with canvas/readback and encoded output.
      release = this.reserveExternalBytes(resource.ref.byteLength * 3 + this.limits.maxEncodedBytes)
      const result = await this.codec.encode(resource.pixels, mediaType, quality as number | undefined, signal)
      assertImageActive(signal)
      if (result.mediaType !== mediaType || result.bytes.length === 0 || result.bytes.length > this.limits.maxEncodedBytes) throw new ImageServiceError('ENCODE_FAILED', 'Invalid encoded image result')
      return result
    } finally { release?.(); this.releaseResource(ref) }
  }
  async downloadPresentation(presentationId: string, signal?: AbortSignal): Promise<EncodedImage> {
    const presentation = this.presentations.get(presentationId)
    if (!presentation) throw new ImageServiceError('STALE_RESOURCE', 'Image presentation is unavailable')
    const generation = this.generation
    const scope = signal ? AbortSignal.any([signal, this.lifetimeAbort.signal]) : this.lifetimeAbort.signal
    const encoded = await this.encode(presentation.resource, 'image/png', undefined, scope)
    if (generation !== this.generation) throw new ImageServiceError('CANCELLED', 'Image run was replaced')
    return { bytes: new Uint8Array(encoded.bytes), mediaType: encoded.mediaType }
  }
  private prepareOutput(request: Readonly<Record<string, unknown>>) {
    const transactionId = imageString(request.transactionId, 'output transaction')
    const path = normalizeAssetPath(request.path)
    const transferId = imageString(request.transferId, 'transfer identity')
    const previous = this.receipts.get(transactionId)
    if (previous) {
      if (previous.path !== path || previous.transferId !== transferId || previous.state === 'aborted') throw new ImageServiceError('OUTPUT_WRITE_FAILED', 'Output transaction was reused with different data')
      return { transactionId }
    }
    if (this.receipts.size >= 256) {
      // Once its transfer is gone an old prepare cannot replay bytes. Keep a
      // bounded retry window without exhausting long-running save animations.
      for (const [id, receipt] of this.receipts) {
        if (receipt.state !== 'prepared' && !this.transfers.has(receipt.transferId)) this.receipts.delete(id)
        if (this.receipts.size < 256) break
      }
    }
    if (this.receipts.size >= 256) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many pending image output transactions')
    if (![...this.outputs.values()].some((value) => value.output.path === path) && this.outputs.size >= this.limits.maxOutputs) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many generated image files')
    const transfer = this.transfer(transferId)
    this.complete(transfer, 'read')
    this.allocate(transfer.bytes.length)
    this.receipts.set(transactionId, { path, transferId, state: 'prepared', encoded: { bytes: new Uint8Array(transfer.bytes), mediaType: transfer.mediaType! } })
    return { transactionId }
  }
  private commitOutput(transactionId: string): ImageOutput {
    const receipt = this.receipts.get(transactionId)
    if (!receipt || receipt.state === 'aborted') throw new ImageServiceError('OUTPUT_WRITE_FAILED', 'No prepared image output')
    if (receipt.state === 'committed') return receipt.result!
    const previous = [...this.outputs.values()].find((value) => value.output.path === receipt.path)
    if (!previous && this.outputs.size >= this.limits.maxOutputs) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many generated image files')
    const encoded = receipt.encoded!
    const output = Object.freeze({ outputId: previous?.output.outputId ?? this.id('output'), path: receipt.path, mediaType: encoded.mediaType, byteLength: encoded.bytes.length, version: (previous?.output.version ?? 0) + 1 })
    if (previous) this.residentBytes -= previous.encoded.bytes.length
    this.outputs.set(output.outputId, { output, encoded })
    receipt.state = 'committed'; receipt.result = output; receipt.encoded = undefined
    this.emit({ kind: 'output', output })
    return output
  }
  getOutput(outputId: string): EncodedImage {
    const output = this.outputs.get(outputId)
    if (!output) throw new ImageServiceError('STALE_RESOURCE', 'Generated image is unavailable')
    return { mediaType: output.encoded.mediaType, bytes: new Uint8Array(output.encoded.bytes) }
  }
  disconnect(): void {
    this.connected = false
    this.runAbort.abort()
    for (const id of this.transfers.keys()) this.dropTransfer(id)
    for (const receipt of this.receipts.values()) if (receipt.state === 'prepared') { this.residentBytes -= receipt.encoded!.bytes.length; receipt.encoded = undefined; receipt.state = 'aborted' }
    for (const resource of [...this.resources.values()]) { resource.owner = false; this.collect(resource) }
  }
  reset(): void {
    this.lifetimeAbort.abort()
    this.disconnect()
    this.generation += 1
    this.residentBytes = 0; this.transferBytes = 0
    this.resources.clear(); this.versions.clear(); this.presentations.clear(); this.outputs.clear(); this.receipts.clear()
    this.runAbort = new AbortController()
    this.lifetimeAbort = new AbortController()
    this.connected = !this.disposed
    this.emit({ kind: 'reset' })
  }
  dispose(): void { this.disposed = true; this.reset() }
}

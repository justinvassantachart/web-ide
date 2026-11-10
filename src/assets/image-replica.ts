/** Bounded main-thread projection of ordered, generation-fenced worker events. */
import { DEFAULT_IMAGE_LIMITS, MAX_IMAGE_RESOURCE_REVISIONS, ImageServiceError, type ImageLimits, type ImagePixels, type ImageResourceRef, type ImageServiceEvent, type ImageServiceSnapshot, type ImagePresentation, type ImageOutput } from './contracts'
import { normalizeAssetPath, resolveImageLimits } from './validation'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageServiceError('INVALID_IMAGE', 'Invalid image event')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /\p{Cc}/u.test(value)) throw new ImageServiceError('INVALID_IMAGE', 'Invalid image event text')
  return value
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ImageServiceError('INVALID_IMAGE', 'Invalid image event number')
  return Number(value)
}
function reference(value: unknown, limits: ImageLimits): ImageResourceRef {
  const v = record(value)
  const width = positive(v.width), height = positive(v.height), byteLength = positive(v.byteLength)
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels || byteLength !== width * height * 4) throw new ImageServiceError('IMAGE_TOO_LARGE', 'Image event exceeds dimensions')
  return Object.freeze({ resourceId: text(v.resourceId), version: positive(v.version), width, height, byteLength })
}

/** Validate structured-clone data without retaining its mutable buffers. */
export function parseImageServiceEvent(value: unknown, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): ImageServiceEvent {
  const event = record(value)
  switch (event.kind) {
    case 'reset': return { kind: 'reset' }
    case 'resource': {
      const resource = reference(event.resource, limits)
      if (!(event.rgba instanceof Uint8Array) || event.rgba.byteLength !== resource.byteLength) throw new ImageServiceError('INVALID_IMAGE', 'Invalid image resource bytes')
      return { kind: 'resource', resource, rgba: event.rgba }
    }
    case 'resource-release': return { kind: 'resource-release', resource: reference(event.resource, limits) }
    case 'presentation': {
      const value = record(event.presentation)
      return { kind: 'presentation', presentation: Object.freeze({ presentationId: text(value.presentationId), title: text(value.title, 512), resource: reference(value.resource, limits) }) }
    }
    case 'output': {
      const value = record(event.output)
      const mediaType = value.mediaType
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp') throw new ImageServiceError('UNSUPPORTED_FORMAT', 'Unsupported output media type')
      const byteLength = positive(value.byteLength)
      if (byteLength > limits.maxEncodedBytes) throw new ImageServiceError('IMAGE_TOO_LARGE', 'Output exceeds encoded limit')
      return { kind: 'output', output: Object.freeze({ outputId: text(value.outputId), path: normalizeAssetPath(value.path), mediaType, byteLength, version: positive(value.version) }) }
    }
    default: throw new ImageServiceError('INVALID_IMAGE', 'Unknown image event')
  }
}

const key = (ref: Pick<ImageResourceRef, 'resourceId' | 'version'>) => `${ref.resourceId}:${ref.version}`
export function createImageResourceReplica(options: { limits?: Partial<ImageLimits> } = {}) {
  const limits = resolveImageLimits(options.limits)
  const resources = new Map<string, { ref: ImageResourceRef; data: Uint8Array }>()
  const presentations = new Map<string, ImagePresentation>()
  const outputs = new Map<string, ImageOutput>()
  let resident = 0
  let external = 0
  let generation = 0
  const reserveExternalBytes = (byteLength: number) => {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || resident + external + byteLength > limits.maxResidentBytes) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Image display budget exceeded')
    external += byteLength
    let released = false
    return () => { if (!released) external -= byteLength; released = true }
  }
  const reset = (nextGeneration = generation + 1) => {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration < generation) return false
    generation = nextGeneration; resident = 0
    resources.clear(); presentations.clear(); outputs.clear()
    return true
  }
  const apply = (value: unknown, eventGeneration = generation): boolean => {
    if (eventGeneration !== generation) return false
    const event = parseImageServiceEvent(value, limits)
    switch (event.kind) {
      case 'reset': return reset(generation)
      case 'resource': {
        const id = key(event.resource)
        if (resources.has(id)) throw new ImageServiceError('STALE_RESOURCE', 'Duplicate immutable image resource')
        if (resources.size >= MAX_IMAGE_RESOURCE_REVISIONS) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many live image revisions')
        if (resident + external + event.rgba.byteLength > limits.maxResidentBytes) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Image display budget exceeded')
        resources.set(id, { ref: event.resource, data: event.rgba.slice() }); resident += event.rgba.byteLength
        break
      }
      case 'resource-release': {
        const item = resources.get(key(event.resource))
        if (item) { resources.delete(key(event.resource)); resident -= item.data.byteLength }
        break
      }
      case 'presentation':
        if (!resources.has(key(event.presentation.resource))) throw new ImageServiceError('STALE_RESOURCE', 'Presentation arrived before its image resource')
        if (!presentations.has(event.presentation.presentationId) && presentations.size >= limits.maxPresentations) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many image presentations')
        presentations.set(event.presentation.presentationId, event.presentation)
        break
      case 'output':
        if (!outputs.has(event.output.outputId) && outputs.size >= limits.maxOutputs) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Too many image outputs')
        outputs.set(event.output.outputId, event.output)
        break
    }
    return true
  }
  const getResource = (ref: Pick<ImageResourceRef, 'resourceId' | 'version'>): ImagePixels => {
    const item = resources.get(key(ref))
    if (!item) throw new ImageServiceError('STALE_RESOURCE', 'Image resource is unavailable')
    return { width: item.ref.width, height: item.ref.height, data: item.data.slice() }
  }
  const snapshot = (): ImageServiceSnapshot => ({ resources: [...resources.values()].map(item => item.ref), presentations: [...presentations.values()], outputs: [...outputs.values()] })
  return { apply, reset, getResource, snapshot, reserveExternalBytes, dispose: () => { reset(); }, get generation() { return generation } }
}

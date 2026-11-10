import { DEFAULT_IMAGE_LIMITS, ImageServiceError, type ImageLimits, type ImageMediaType, type WorkspaceAssetRefV1, type WorkspaceDocumentV2 } from './contracts'
import { normalizeWorkspacePathV1, normalizeWorkspaceTextV1 } from '../web-ide/public/canonical-contract'

export function assertImageActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImageServiceError('CANCELLED', 'Image operation cancelled')
}

export function imageInteger(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ImageServiceError('INVALID_IMAGE', `${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function imageString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) {
    throw new ImageServiceError('INVALID_IMAGE', `Invalid ${name}`)
  }
  return value
}

export function imageMediaType(value: unknown): ImageMediaType {
  if (value !== 'image/png' && value !== 'image/jpeg' && value !== 'image/webp') {
    throw new ImageServiceError('UNSUPPORTED_FORMAT', 'Use a PNG, JPEG or non-animated WebP image')
  }
  return value
}

export function validateImageDimensions(width: unknown, height: unknown, limits = DEFAULT_IMAGE_LIMITS): number {
  const w = imageInteger(width, 'width', 1)
  const h = imageInteger(height, 'height', 1)
  if (w > limits.maxDimension || h > limits.maxDimension || w * h > limits.maxPixels) {
    throw new ImageServiceError('IMAGE_TOO_LARGE', `Image exceeds ${limits.maxDimension} pixels per side or ${limits.maxPixels} pixels total`)
  }
  return w * h * 4
}

/** Bounded header scan before passing encoded data to a browser decoder. */
export function inspectImage(bytes: Uint8Array, claimedType?: ImageMediaType, limits = DEFAULT_IMAGE_LIMITS): { mediaType: ImageMediaType; width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new ImageServiceError('INVALID_IMAGE', 'Empty image')
  if (bytes.length > limits.maxEncodedBytes) throw new ImageServiceError('IMAGE_TOO_LARGE', 'Encoded image exceeds the file limit')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count))
  let mediaType: ImageMediaType
  let width = 0
  let height = 0
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\u001a\n') {
    mediaType = 'image/png'
    if (view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') throw new ImageServiceError('INVALID_IMAGE', 'Invalid PNG header')
    width = view.getUint32(16)
    height = view.getUint32(20)
    let ended = false
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset)
      if (length > bytes.length - offset - 12) throw new ImageServiceError('INVALID_IMAGE', 'Truncated PNG chunk')
      const type = ascii(offset + 4, 4)
      if (type === 'acTL') throw new ImageServiceError('UNSUPPORTED_FORMAT', 'Animated PNG is not supported')
      offset += length + 12
      if (type === 'IEND') { ended = true; break }
    }
    if (!ended) throw new ImageServiceError('INVALID_IMAGE', 'Missing PNG end chunk')
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mediaType = 'image/jpeg'
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) throw new ImageServiceError('INVALID_IMAGE', 'Invalid JPEG marker')
      while (offset < bytes.length && bytes[offset] === 255) offset += 1
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || length > bytes.length - offset) throw new ImageServiceError('INVALID_IMAGE', 'Truncated JPEG segment')
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new ImageServiceError('INVALID_IMAGE', 'Invalid JPEG dimensions')
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
        break
      }
      offset += length
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mediaType = 'image/webp'
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new ImageServiceError('INVALID_IMAGE', 'Invalid WebP length')
    const type = ascii(12, 4)
    if (type === 'VP8X') {
      if ((bytes[20] & 2) !== 0) throw new ImageServiceError('UNSUPPORTED_FORMAT', 'Animated WebP is not supported')
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    } else if (type === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (type === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 0x3fff
      height = view.getUint16(28, true) & 0x3fff
    }
  } else {
    throw new ImageServiceError('UNSUPPORTED_FORMAT', 'File is not a supported raster image')
  }
  if (claimedType !== undefined && claimedType !== mediaType) throw new ImageServiceError('INVALID_IMAGE', 'Image type does not match its bytes')
  validateImageDimensions(width, height, limits)
  return { mediaType, width, height }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(text)
}

export function base64ToBytes(value: unknown, maxBytes = DEFAULT_IMAGE_LIMITS.maxChunkBytes): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ImageServiceError('INVALID_TRANSFER', 'Invalid or oversized base64 chunk')
  }
  const decoded = atob(value)
  if (decoded.length > maxBytes) throw new ImageServiceError('INVALID_TRANSFER', 'Chunk exceeds the transfer limit')
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
  if (bytesToBase64(bytes) !== value) throw new ImageServiceError('INVALID_TRANSFER', 'Non-canonical base64 chunk')
  return bytes
}

export async function imageSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeAssetPath(value: unknown): string {
  const path = imageString(value, 'workspace path', 4096)
  try {
    return normalizeWorkspacePathV1(path)
  } catch {
    throw new ImageServiceError('INVALID_PATH', 'Use a canonical file path inside /workspace')
  }
}

export function normalizeWorkspaceDocument(value: WorkspaceDocumentV2): WorkspaceDocumentV2 {
  if (!value || value.schemaVersion !== 2 || !Array.isArray(value.files) || !Array.isArray(value.assets)) throw new ImageServiceError('INVALID_IMAGE', 'Invalid workspace document version')
  if (value.files.length + value.assets.length > 500) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Workspace exceeds 500 files')
  const paths = new Set<string>()
  const admit = (input: unknown, asset = false) => {
    if (typeof input !== 'string') throw new ImageServiceError('INVALID_PATH', 'Workspace path must be text')
    const path = asset ? normalizeAssetPath(input) : normalizeWorkspacePathV1(input)
    if (paths.has(path) || [...paths].some((other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) throw new ImageServiceError('INVALID_PATH', `Conflicting workspace path: ${path}`)
    paths.add(path)
    return path
  }
  const files = value.files.map((file) => {
    if (!file || typeof file.content !== 'string') throw new ImageServiceError('INVALID_IMAGE', 'Source content must be text')
    return Object.freeze({ path: admit(file.path), content: normalizeWorkspaceTextV1(file.content) })
  }).sort((a, b) => a.path.localeCompare(b.path))
  let total = 0
  const assets = value.assets.map((asset): WorkspaceAssetRefV1 => {
    const path = admit(asset?.path, true)
    const byteLength = imageInteger(asset.byteLength, 'asset length', 1, DEFAULT_IMAGE_LIMITS.maxEncodedBytes)
    total += byteLength
    if (total > 64 * 1024 * 1024) throw new ImageServiceError('IMAGE_BUDGET_EXCEEDED', 'Workspace images exceed 64 MiB')
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new ImageServiceError('INVALID_IMAGE', 'Invalid asset SHA-256')
    return Object.freeze({ path, blobId: imageString(asset.blobId, 'asset identity', 256), sha256: asset.sha256, byteLength, mediaType: imageMediaType(asset.mediaType) })
  }).sort((a, b) => a.path.localeCompare(b.path))
  return Object.freeze({ schemaVersion: 2, files: Object.freeze(files), assets: Object.freeze(assets) })
}

export function resolveImageLimits(options: Partial<ImageLimits> = {}): ImageLimits {
  const limits = { ...DEFAULT_IMAGE_LIMITS, ...options }
  for (const [name, value] of Object.entries(limits)) imageInteger(value, name, 1)
  if (limits.maxChunkBytes > 32 * 1024) throw new ImageServiceError('INVALID_TRANSFER', 'Image chunks must fit the shared device profile')
  return Object.freeze(limits)
}

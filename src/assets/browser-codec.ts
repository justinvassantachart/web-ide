import { DEFAULT_IMAGE_LIMITS, ImageServiceError, type ImageCodec, type ImageLimits, type ImageMediaType, type ImagePixels } from './contracts'
import { assertImageActive, inspectImage, validateImageDimensions } from './validation'

function canvasFor(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  throw new ImageServiceError('UNSUPPORTED_FORMAT', 'This browser does not provide an offscreen raster canvas')
}

async function decodeSource(blob: Blob, signal?: AbortSignal): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  assertImageActive(signal)
  if (typeof createImageBitmap !== 'function') throw new ImageServiceError('UNSUPPORTED_FORMAT', 'Image decoding is unavailable in this browser')
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' })
  if (signal?.aborted) { bitmap.close(); assertImageActive(signal) }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
}

/** Browser/worker codec; constructing it performs no DOM work. */
export function createBrowserImageCodec(limits: ImageLimits = DEFAULT_IMAGE_LIMITS): ImageCodec {
  return {
    async decode(bytes, mediaType, signal) {
      inspectImage(bytes, mediaType, limits)
      assertImageActive(signal)
      let source: Awaited<ReturnType<typeof decodeSource>> | undefined
      try {
        source = await decodeSource(new Blob([new Uint8Array(bytes)], { type: mediaType }), signal)
        validateImageDimensions(source.width, source.height, limits)
        assertImageActive(signal)
        const canvas = canvasFor(source.width, source.height)
        const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
        if (!context) throw new ImageServiceError('INVALID_IMAGE', 'Unable to create image surface')
        context.drawImage(source.source, 0, 0)
        const data = new Uint8Array(context.getImageData(0, 0, source.width, source.height).data)
        assertImageActive(signal)
        return { width: source.width, height: source.height, data }
      } catch (error) {
        if (error instanceof ImageServiceError) throw error
        throw new ImageServiceError('INVALID_IMAGE', 'The browser could not decode this image')
      } finally { source?.close() }
    },
    async encode(pixels: ImagePixels, mediaType: ImageMediaType, quality = 0.9, signal) {
      const size = validateImageDimensions(pixels.width, pixels.height, limits)
      if (pixels.data.length !== size) throw new ImageServiceError('INVALID_IMAGE', 'Invalid RGBA length')
      if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new ImageServiceError('ENCODE_FAILED', 'Image quality must be between 0 and 1')
      assertImageActive(signal)
      const canvas = canvasFor(pixels.width, pixels.height)
      const context = canvas.getContext('2d', { colorSpace: 'srgb' }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
      if (!context) throw new ImageServiceError('ENCODE_FAILED', 'Unable to create image surface')
      const data = new Uint8ClampedArray(pixels.data)
      if (mediaType === 'image/jpeg') {
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3] / 255
          for (let channel = 0; channel < 3; channel += 1) data[i + channel] = Math.round(data[i + channel] * alpha + 255 * (1 - alpha))
          data[i + 3] = 255
        }
      }
      context.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0)
      const blob = await canvas.convertToBlob({ type: mediaType, quality })
      assertImageActive(signal)
      if (blob.type !== mediaType) throw new ImageServiceError('UNSUPPORTED_FORMAT', `This browser cannot encode ${mediaType}`)
      if (blob.size > limits.maxEncodedBytes) throw new ImageServiceError('IMAGE_TOO_LARGE', 'Encoded output exceeds the file limit')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      assertImageActive(signal)
      return { bytes, mediaType }
    },
  }
}

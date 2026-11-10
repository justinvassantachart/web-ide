/** Framework-free image and workspace byte contracts shared by language companions. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/** Bounds resource metadata even when every image is only one pixel. */
export const MAX_IMAGE_RESOURCE_REVISIONS = 256

export interface WorkspaceAssetRefV1 {
  readonly path: string
  readonly blobId: string
  readonly sha256: string
  readonly byteLength: number
  readonly mediaType: ImageMediaType
}

export interface WorkspaceDocumentV2 {
  readonly schemaVersion: 2
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly assets: readonly WorkspaceAssetRefV1[]
}

export interface WorkspaceAssetPort {
  read(asset: WorkspaceAssetRefV1, signal?: AbortSignal): Promise<Uint8Array>
  stage(input: { path: string; bytes: Uint8Array; mediaType: ImageMediaType }, signal?: AbortSignal): Promise<WorkspaceAssetRefV1>
  /** Synchronous host limits/path policy, checked before an atomic local commit. */
  validateDocument?(document: WorkspaceDocumentV2): void
  readonly capabilities?: {
    readonly import?: boolean
    readonly delete?: boolean
    readonly download?: boolean
    readonly promote?: boolean
  }
}

export interface ImageLimits {
  readonly maxEncodedBytes: number
  readonly maxPixels: number
  readonly maxDimension: number
  readonly maxResidentBytes: number
  readonly maxTransferBytes: number
  readonly maxChunkBytes: number
  readonly maxPresentations: number
  readonly maxOutputs: number
  readonly transferTimeoutMs: number
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = Object.freeze({
  maxEncodedBytes: 8 * 1024 * 1024,
  maxPixels: 4_000_000,
  maxDimension: 4096,
  maxResidentBytes: 128 * 1024 * 1024,
  maxTransferBytes: 64 * 1024 * 1024,
  maxChunkBytes: 32 * 1024,
  maxPresentations: 32,
  maxOutputs: 32,
  transferTimeoutMs: 60_000,
})

export interface ImagePixels {
  readonly width: number
  readonly height: number
  /** Owned row-major, tightly packed, straight RGBA8. */
  readonly data: Uint8Array
}

export interface EncodedImage {
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
}

export interface ImageCodec {
  decode(bytes: Uint8Array, mediaType: ImageMediaType, signal?: AbortSignal): Promise<ImagePixels>
  encode(pixels: ImagePixels, mediaType: ImageMediaType, quality?: number, signal?: AbortSignal): Promise<EncodedImage>
}

export interface ImageResourceRef {
  readonly resourceId: string
  readonly version: number
  readonly width: number
  readonly height: number
  readonly byteLength: number
}

export interface ImagePresentation {
  readonly presentationId: string
  readonly title: string
  readonly resource: ImageResourceRef
}

export interface ImageOutput {
  readonly outputId: string
  readonly path: string
  readonly mediaType: ImageMediaType
  readonly byteLength: number
  readonly version: number
}

export type ImageServiceEvent =
  | { readonly kind: 'resource'; readonly resource: ImageResourceRef; readonly rgba: Uint8Array }
  | { readonly kind: 'resource-release'; readonly resource: ImageResourceRef }
  | { readonly kind: 'presentation'; readonly presentation: ImagePresentation }
  | { readonly kind: 'output'; readonly output: ImageOutput }
  | { readonly kind: 'reset' }

export interface ImageServiceSnapshot {
  readonly resources: readonly ImageResourceRef[]
  readonly presentations: readonly ImagePresentation[]
  readonly outputs: readonly ImageOutput[]
}

export type ImageServiceRequest =
  | { op: 'capabilities' }
  | { op: 'encoded.begin'; length: number; mediaType?: ImageMediaType }
  | { op: 'transfer.write'; transferId: string; offset: number; base64: string }
  | { op: 'encoded.decode'; transferId: string }
  | { op: 'rgba.begin'; width: number; height: number; resourceId?: string }
  | { op: 'rgba.commit'; transferId: string }
  | { op: 'resource.read'; resourceId: string; version: number; offset: number; length: number }
  | { op: 'resource.encode'; resourceId: string; version: number; mediaType: ImageMediaType; quality?: number }
  | { op: 'transfer.read'; transferId: string; offset: number; length: number }
  | { op: 'transfer.release'; transferId: string }
  | { op: 'resource.release'; resourceId: string; version: number }
  | { op: 'presentation.show'; resourceId: string; version: number; presentationId: string; title?: string }
  | { op: 'output.prepare'; transactionId: string; path: string; transferId: string }
  | { op: 'output.commit' | 'output.abort'; transactionId: string }

export interface ImageServiceOptions {
  readonly codec?: ImageCodec
  readonly limits?: Partial<ImageLimits>
  readonly onEvent?: (event: ImageServiceEvent) => void
}

export interface ImageService {
  readonly limits: ImageLimits
  dispatch(request: ImageServiceRequest | Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
  /** Direct host adapter path (for example C++ canvas bulk readback). Copies input. */
  publishResource(pixels: ImagePixels, resourceId?: string): ImageResourceRef
  /** Returns an owned copy; mutating it never changes an existing scene revision. */
  getResource(ref: Pick<ImageResourceRef, 'resourceId' | 'version'>): ImagePixels
  /** Retain/release a host scene reference independently of the guest owner. */
  retainResource(ref: Pick<ImageResourceRef, 'resourceId' | 'version'>): void
  releaseResource(ref: Pick<ImageResourceRef, 'resourceId' | 'version'>): void
  /** Charge renderer backing stores to the same aggregate budget. */
  reserveExternalBytes(byteLength: number): () => void
  snapshot(): ImageServiceSnapshot
  downloadPresentation(presentationId: string, signal?: AbortSignal): Promise<EncodedImage>
  getOutput(outputId: string): EncodedImage
  /** End requests/transfers while retaining final displayed/output leases. */
  disconnect(): void
  /** Start a fresh generation; all old handles are invalid. */
  reset(): void
  dispose(): void
}

export type ImageErrorCode =
  | 'INVALID_PATH' | 'UNSUPPORTED_FORMAT' | 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE'
  | 'IMAGE_BUDGET_EXCEEDED' | 'INVALID_COORDINATE' | 'INVALID_TRANSFER'
  | 'STALE_RESOURCE' | 'CANCELLED' | 'ENCODE_FAILED' | 'OUTPUT_WRITE_FAILED'

export class ImageServiceError extends Error {
  readonly code: ImageErrorCode
  constructor(code: ImageErrorCode, message: string) {
    super(message)
    this.name = 'ImageServiceError'
    this.code = code
  }
}

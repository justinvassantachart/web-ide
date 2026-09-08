import type { WorkspaceFiles } from '../contracts/host'

const PATH_LIMIT = 1024

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function canonicalArrayIndex(key: PropertyKey, length: number): boolean {
  if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function assertJsonValue(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) throw new TypeError(`${path} contains unpaired Unicode surrogate data`)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
    ancestors.add(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
      throw new TypeError(`${path} has an invalid array length`)
    }
    const length = lengthDescriptor.value as number
    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length')
    if (keys.length !== length || keys.some((key) => !canonicalArrayIndex(key, length))) {
      throw new TypeError(`${path} must be a dense array without extra properties`)
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}[${index}] must be an enumerable data property`)
      }
      assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors)
    }
    ancestors.delete(value)
    return
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`)
    }
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`)
    ancestors.add(value)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`${path} contains a symbol key`)
      if (!isWellFormedUnicode(key)) throw new TypeError(`${path} contains an unpaired Unicode surrogate key`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`)
      }
      if (descriptor.value === undefined) throw new TypeError(`${path}.${key} is undefined`)
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors)
    }
    ancestors.delete(value)
    return
  }
  throw new TypeError(`${path} is not a JSON value`)
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number
    const children = Array.from({ length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!
      return serialize(descriptor.value)
    })
    return `[${children.join(',')}]`
  }
  // `assertJsonValue` has already proved that every own key is an enumerable
  // data property. Read those descriptors again instead of using Object.entries
  // so canonicalization never invokes a getter or a Proxy `get` trap after the
  // validation pass.
  return `{${Reflect.ownKeys(value)
    .map((key) => [key as string, Object.getOwnPropertyDescriptor(value, key)!.value] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`)
    .join(',')}}`
}

export function canonicalStringifyV1(value: unknown): string {
  assertJsonValue(value, '$')
  return serialize(value)
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  if (typeof value === 'string' && !isWellFormedUnicode(value)) {
    throw new TypeError('cannot UTF-8 hash unpaired Unicode surrogate data')
  }
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const input = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(input).set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeVfsPathV1(input: string): string {
  if (input.length === 0 || input.includes('\0') || !isWellFormedUnicode(input)) {
    throw new TypeError('VFS path is empty or contains NUL')
  }
  if (input.includes('\\')) throw new TypeError('VFS paths use forward slashes')
  const normalized = input.normalize('NFC')
  if (!isWellFormedUnicode(normalized) || [...normalized].length > PATH_LIMIT) {
    throw new TypeError('VFS path is oversized or contains unpaired Unicode surrogate data')
  }
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    throw new TypeError('VFS path must be absolute with one leading slash')
  }
  const segments = normalized.split('/')
  if (segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'))) {
    throw new TypeError('VFS path contains an empty or traversal segment')
  }
  return normalized
}

export function normalizeWorkspacePathV1(input: string): string {
  const normalized = normalizeVfsPathV1(input)
  if (!normalized.startsWith('/workspace/')) throw new TypeError('workspace path must be below /workspace')
  return normalized
}

export function normalizeWorkspaceTextV1(text: string): string {
  if (typeof text !== 'string' || !isWellFormedUnicode(text)) {
    throw new TypeError('workspace text must be well-formed Unicode')
  }
  return text.replace(/\r\n?/g, '\n')
}

export async function workspaceDigestV1(files: Readonly<WorkspaceFiles>): Promise<string> {
  canonicalStringifyV1(files)
  const normalized = Object.entries(files)
    .map(([path, text]) => [normalizeWorkspacePathV1(path), normalizeWorkspaceTextV1(text)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const duplicate = normalized.find(([path], index) => index > 0 && normalized[index - 1]?.[0] === path)
  if (duplicate) throw new TypeError(`duplicate normalized path: ${duplicate[0]}`)
  return sha256Hex(canonicalStringifyV1(Object.fromEntries(normalized)))
}

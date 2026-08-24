import type {
  IDESourceDecoration,
  IDESourceDecorationKind,
  IDESourceLocation,
  IDESourcePresentationOwner,
  IDESourcePresentationSnapshot,
} from '../contracts/source-presentation'
import { canonicalWorkspaceFilePath } from './workspace-path'

export interface SourcePresentationControllerOptions {
  /** Reads a canonical visible source file, or returns undefined when hidden. */
  readVisibleSource(path: string): string | undefined
  /** Performs editor navigation without exposing the editor to an owner. */
  onReveal(location: IDESourceLocation): void
}

interface OwnerState {
  decorations: readonly IDESourceDecoration[]
}

const EMPTY_DECORATIONS: readonly IDESourceDecoration[] = Object.freeze([])
// Bound one owner's editor-facing workload while leaving ordinary source size
// and the number of independently managed presentation owners unconstrained.
const MAX_SOURCE_DECORATIONS_PER_OWNER = 256
const SOURCE_KINDS = new Set<IDESourceDecorationKind>([
  'current',
  'historical',
  'error',
])

function strictDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must not inherit source data`)
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys])
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported property`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} properties must be plain data values`)
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing ${JSON.stringify(key)}`)
    }
  }
  return value as Readonly<Record<string, unknown>>
}

function positiveSourceCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value as number
}

function canonicalVisibleSource(
  value: unknown,
  readVisibleSource: (path: string) => string | undefined,
  cache?: Map<string, readonly string[]>,
): { path: string; lines: readonly string[] } {
  if (typeof value !== 'string' || !value.startsWith('/workspace/')) {
    throw new TypeError('Source path must be an absolute /workspace file path')
  }
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return character === '\\' || codePoint <= 0x1f || codePoint === 0x7f
  })) {
    throw new TypeError('Source path contains an unsupported character')
  }

  const canonical = canonicalWorkspaceFilePath(value)
  if (canonical !== value) {
    throw new TypeError(`Source path is not canonical: ${JSON.stringify(value)}`)
  }
  const cached = cache?.get(canonical)
  if (cached) return { path: canonical, lines: cached }
  const content = readVisibleSource(canonical)
  if (typeof content !== 'string') {
    throw new TypeError(`Source path is not a visible workspace resource: ${JSON.stringify(value)}`)
  }
  const lines = Object.freeze(content.split(/\r\n|\r|\n/u))
  cache?.set(canonical, lines)
  return { path: canonical, lines }
}

function normalizeLocation(
  value: unknown,
  readVisibleSource: (path: string) => string | undefined,
  cache?: Map<string, readonly string[]>,
): IDESourceLocation {
  const record = strictDataRecord(
    value,
    ['path', 'line'],
    ['column'],
    'Source location',
  )
  const { path, lines: sourceLines } = canonicalVisibleSource(
    record.path,
    readVisibleSource,
    cache,
  )
  const line = positiveSourceCoordinate(record.line, 'Source line')
  const column = record.column === undefined
    ? undefined
    : positiveSourceCoordinate(record.column, 'Source column')
  if (line > sourceLines.length) {
    throw new RangeError(`Source line ${line} is outside ${JSON.stringify(path)}`)
  }
  const maxColumn = (sourceLines[line - 1]?.length ?? 0) + 1
  if (column !== undefined && column > maxColumn) {
    throw new RangeError(`Source column ${column} is outside ${JSON.stringify(path)} line ${line}`)
  }

  return Object.freeze(column === undefined ? { path, line } : { path, line, column })
}

function normalizeDecoration(
  value: unknown,
  readVisibleSource: (path: string) => string | undefined,
  cache?: Map<string, readonly string[]>,
): IDESourceDecoration {
  const record = strictDataRecord(
    value,
    ['path', 'line', 'kind'],
    ['column'],
    'Source decoration',
  )
  const location = normalizeLocation(
    record.column === undefined
      ? { path: record.path, line: record.line }
      : { path: record.path, line: record.line, column: record.column },
    readVisibleSource,
    cache,
  )
  if (typeof record.kind !== 'string' || !SOURCE_KINDS.has(record.kind as IDESourceDecorationKind)) {
    throw new TypeError(`Source decoration kind is not supported: ${JSON.stringify(record.kind)}`)
  }

  return Object.freeze({ ...location, kind: record.kind as IDESourceDecorationKind })
}

function decorationsEqual(
  left: readonly IDESourceDecoration[],
  right: readonly IDESourceDecoration[],
): boolean {
  return left.length === right.length && left.every((decoration, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && decoration.path === candidate.path
      && decoration.line === candidate.line
      && decoration.column === candidate.column
      && decoration.kind === candidate.kind
  })
}

/**
 * Pure owner-scoped state boundary. UI adapters subscribe to its immutable
 * aggregate snapshot; activity owners receive only their narrow facade.
 */
export class SourcePresentationController {
  private readonly readVisibleSource: (path: string) => string | undefined
  private readonly onReveal: (location: IDESourceLocation) => void
  private readonly owners = new Map<object, OwnerState>()
  private readonly listeners = new Set<() => void>()
  private snapshot: IDESourcePresentationSnapshot = Object.freeze({
    decorations: EMPTY_DECORATIONS,
  })
  private disposed = false

  constructor(options: SourcePresentationControllerOptions) {
    if (typeof options?.readVisibleSource !== 'function') {
      throw new TypeError('readVisibleSource must be a function')
    }
    if (typeof options.onReveal !== 'function') {
      throw new TypeError('onReveal must be a function')
    }
    this.readVisibleSource = options.readVisibleSource
    this.onReveal = options.onReveal
  }

  /** Stable getter suitable for `useSyncExternalStore`. */
  readonly getSnapshot = (): IDESourcePresentationSnapshot => this.snapshot

  /** Subscribes to actual aggregate decoration changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.assertControllerActive()
    if (typeof listener !== 'function') {
      throw new TypeError('Source presentation listener must be a function')
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Creates one facade whose mutations can affect only its own decorations. */
  createOwner(): IDESourcePresentationOwner {
    this.assertControllerActive()
    const token = {}
    this.owners.set(token, { decorations: EMPTY_DECORATIONS })
    let ownerDisposed = false

    const assertOwnerActive = () => {
      if (ownerDisposed || this.disposed || !this.owners.has(token)) {
        throw new Error('Source presentation owner is no longer active')
      }
    }

    return Object.freeze({
      reveal: (location: IDESourceLocation) => {
        assertOwnerActive()
        this.onReveal(normalizeLocation(location, this.readVisibleSource))
      },
      replaceDecorations: (decorations: readonly IDESourceDecoration[]) => {
        assertOwnerActive()
        if (!Array.isArray(decorations)) {
          throw new TypeError('Source decorations must be an array')
        }
        if (decorations.length > MAX_SOURCE_DECORATIONS_PER_OWNER) {
          throw new RangeError(
            `A source presentation owner may provide at most ${MAX_SOURCE_DECORATIONS_PER_OWNER} decorations`,
          )
        }
        const sourceCache = new Map<string, readonly string[]>()
        const normalized = Object.freeze(
          decorations.map((decoration) => (
            normalizeDecoration(decoration, this.readVisibleSource, sourceCache)
          )),
        )
        const state = this.owners.get(token)!
        if (decorationsEqual(state.decorations, normalized)) return
        state.decorations = normalized
        this.rebuildSnapshot()
      },
      clearDecorations: () => {
        assertOwnerActive()
        const state = this.owners.get(token)!
        if (state.decorations.length === 0) return
        state.decorations = EMPTY_DECORATIONS
        this.rebuildSnapshot()
      },
      dispose: () => {
        if (ownerDisposed) return
        ownerDisposed = true
        const state = this.owners.get(token)
        if (!state) return
        this.owners.delete(token)
        if (state.decorations.length > 0) this.rebuildSnapshot()
      },
    })
  }

  /** Drops locations that stopped resolving after an edit, rename, or delete. */
  readonly pruneInvalid = (): void => {
    this.assertControllerActive()
    let changed = false
    const sourceCache = new Map<string, readonly string[]>()

    for (const state of this.owners.values()) {
      const valid = state.decorations.filter((decoration) => {
        try {
          normalizeDecoration(decoration, this.readVisibleSource, sourceCache)
          return true
        } catch {
          return false
        }
      })
      if (valid.length === state.decorations.length) continue
      state.decorations = valid.length === 0
        ? EMPTY_DECORATIONS
        : Object.freeze(valid)
      changed = true
    }

    if (changed) this.rebuildSnapshot()
  }

  /** Clears all owners and subscriptions and permanently revokes the controller. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const changed = this.snapshot.decorations.length > 0
    this.owners.clear()
    if (changed) {
      this.snapshot = Object.freeze({ decorations: EMPTY_DECORATIONS })
      this.notifyListeners()
    }
    this.listeners.clear()
  }

  private assertControllerActive(): void {
    if (this.disposed) {
      throw new Error('Source presentation controller is disposed')
    }
  }

  private rebuildSnapshot(): void {
    const decorations = Object.freeze(
      [...this.owners.values()].flatMap((owner) => owner.decorations),
    )
    this.snapshot = Object.freeze({ decorations })
    this.notifyListeners()
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

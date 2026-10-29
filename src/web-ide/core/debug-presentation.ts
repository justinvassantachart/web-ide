import type {
  DebugChildPage, DebugFormatContext, DebugPageRequest, DebugPresentation,
  DebugValueFormatter, DebugValueRef,
} from '../contracts/debug-presentation'
import type { DebugPauseState, RuntimeSession, VariableNode } from '../contracts/runtime'
import type { Disposable } from './disposable'

const firstPage: DebugPageRequest = { start: 0, count: 100 }
interface FormatterSource {
  getSnapshot(): readonly DebugValueFormatter[]
  subscribe(listener: () => void): Disposable
}

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function boundedDebugPage(page: DebugPageRequest = firstPage): DebugPageRequest {
  const start = Number.isSafeInteger(page.start) ? Math.max(0, page.start) : 0
  return {
    start,
    count: Math.min(Number.MAX_SAFE_INTEGER - start, Number.isSafeInteger(page.count) ? Math.max(0, Math.min(100, page.count)) : 100),
  }
}

/** One instance-owned resolver shared by Variables and Graph. */
export class DebugPresentationService implements Disposable {
  private readonly runtime: RuntimeSession
  private readonly formatters: FormatterSource
  private values = new Map<DebugValueRef, Readonly<VariableNode>>()
  private legacyHeap = new Map<number, VariableNode[]>()
  private readonly legacyRefs = new WeakMap<VariableNode, DebugValueRef>()
  private nextRef = 0
  private revision = 0
  private epoch = 0
  private snapshot: DebugPauseState | null = null
  private live = false
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, Promise<DebugPresentation>>()
  private readonly results = new Map<string, DebugPresentation>()
  private readonly pages = new Map<string, Promise<DebugChildPage>>()
  private registration?: Disposable

  constructor(
    runtime: RuntimeSession,
    formatters: FormatterSource | readonly DebugValueFormatter[],
  ) {
    this.runtime = runtime
    this.formatters = 'getSnapshot' in formatters ? formatters : {
      getSnapshot: () => formatters,
      subscribe: () => ({ dispose() {} }),
    }
  }

  readonly getSnapshot = (): number => this.revision
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Pass live=false when displaying history; no historical native requests are allowed. */
  setSnapshot(snapshot: DebugPauseState | null, live = true): void {
    // Mount-time subscription avoids leaking a listener from a discarded React
    // StrictMode render, while headless consumers use the same explicit lifecycle.
    this.registration ??= this.formatters.subscribe(() => this.invalidate())
    if (this.snapshot === snapshot && this.live === live) return
    this.snapshot = snapshot
    this.live = live
    this.values = new Map()
    this.legacyHeap = new Map((snapshot?.memorySnapshot?.heapAllocations ?? []).map(allocation => [allocation.ptr, allocation.members]))
    for (const frame of snapshot?.callStack ?? []) {
      for (const value of frame.variables) this.capture(value, this.values)
    }
    for (const allocation of snapshot?.memorySnapshot?.heapAllocations ?? []) {
      for (const value of allocation.members) this.capture(value, this.values)
    }
    this.invalidate()
  }

  getRef(value: VariableNode): DebugValueRef {
    if (value.debugRef) return value.debugRef
    let ref = this.legacyRefs.get(value)
    if (!ref) {
      ref = `captured:${++this.nextRef}` as DebugValueRef
      this.legacyRefs.set(value, ref)
    }
    return ref
  }

  readonly readValue = (ref: DebugValueRef): Readonly<VariableNode> | undefined => this.values.get(ref)

  getPresentation(ref: DebugValueRef, page = firstPage, mode: 'pretty' | 'raw' = 'pretty'): DebugPresentation | undefined {
    return this.results.get(this.key(ref, boundedDebugPage(page), mode))
  }

  present(ref: DebugValueRef, page = firstPage, mode: 'pretty' | 'raw' = 'pretty'): Promise<DebugPresentation> {
    page = boundedDebugPage(page)
    const key = this.key(ref, page, mode)
    const existing = this.pending.get(key)
    if (existing) return existing
    const epoch = this.epoch
    const values = new Map(this.values)
    const value = values.get(ref)
    const live = this.live
    let formattingActive = true
    const context: DebugFormatContext = {
      readValue: (child) => values.get(child),
      readChildren: (child, request) => this.children(child, request, values, live && formattingActive, epoch),
    }
    const promise = (async (): Promise<DebugPresentation> => {
      if (!value) return this.unavailable('This value was not captured.')
      let fallbackReason: string | undefined
      if (mode === 'pretty' && value.availability !== 'unavailable') {
        for (const formatter of this.formatters.getSnapshot()) {
          try {
            if (!formatter.matches(value)) continue
            const formatted = await this.withDeadline(() => formatter.format(value, context, page))
            if (formatted && this.validPresentation(formatted, page, values)) return formatted
            if (formatted) fallbackReason = 'The formatter returned an unsupported presentation; showing Raw.'
            else fallbackReason = 'This layout is not supported by the formatter; showing Raw.'
          } catch {
            fallbackReason = 'The formatter could not finish; showing Raw.'
            formattingActive = false
            break
          }
        }
      }
      const raw = await this.children(ref, page, values, live, epoch)
      return {
        kind: 'raw', summary: String(value.value), start: raw.start, total: raw.total,
        complete: raw.complete, availability: raw.availability, message: fallbackReason ?? raw.message,
        children: raw.children.map((child, index) => ({
          key: String(child.debugOrdinal ?? raw.start + index), label: child.name, value: this.getRef(child),
        })),
      }
    })().then((result) => {
      const immutable = Object.freeze({
        ...result,
        children: Object.freeze(result.children.map((child) => Object.freeze({ ...child }))),
        shape: result.shape && Object.freeze({ ...result.shape }),
      })
      if (epoch === this.epoch) {
        this.retain(this.results, key, immutable, 1000)
        for (const [child, metadata] of values) this.values.set(child, metadata)
        this.notify()
      }
      return immutable
    })
    this.retain(this.pending, key, promise, 1000)
    return promise
  }

  private async children(
    ref: DebugValueRef, request: DebugPageRequest,
    values: Map<DebugValueRef, Readonly<VariableNode>>, live: boolean, epoch: number,
  ): Promise<DebugChildPage> {
    const page = boundedDebugPage(request)
    const value = values.get(ref)
    if (!value) return { children: [], start: page.start, complete: false, availability: 'unavailable' }
    const total = value.childrenInfo?.total ?? (value.childrenInfo || value.members || value.isStruct ? undefined : 0)
    const children = (value.members ?? []).filter((child, index) => {
      const ordinal = child.debugOrdinal ?? index
      return ordinal >= page.start && ordinal < page.start + page.count
    })
    const expected = total === undefined ? page.count : Math.max(0, Math.min(page.count, total - page.start))
    const complete = page.count === 0 || children.length === expected && (total !== undefined || value.childrenInfo?.complete === true)
    if (complete || value.availability === 'unavailable' || page.count === 0) {
      return { children, start: page.start, total, complete, availability: value.availability === 'unavailable' ? 'unavailable' : complete ? 'available' : 'partial' }
    }
    if (!live || epoch !== this.epoch || !value.debugRef || !this.runtime.readDebugChildren) {
      return { children, start: page.start, total, complete: false, availability: 'partial', message: 'These children were not captured at this stop.' }
    }
    const key = `${epoch}:${ref}:${page.start}:${page.count}`
    let pending = this.pages.get(key)
    if (!pending) {
      pending = this.runtime.readDebugChildren(ref, page).catch((): DebugChildPage => ({
        children: [], start: page.start, total, complete: false,
        availability: 'unavailable', message: 'The debugger could not read these children.',
      }))
      this.retain(this.pages, key, pending, 250)
    }
    const result = await pending
    for (const child of result.children) this.capture(child, values)
    // Native reads can publish a new revision. A formatter still receives its own
    // immutable result; the newer revision is resolved separately by both views.
    return result
  }

  private capture(value: VariableNode, values: Map<DebugValueRef, Readonly<VariableNode>>, depth = 0): void {
    const ref = this.getRef(value)
    if (values.has(ref) || values.size >= 1000) return
    // Older providers report dereferenced members separately in the heap snapshot.
    // Preserve that captured relationship without making a new native request.
    const sourceMembers = value.members ?? (!value.debugRef && value.isPointer && value.pointsTo
      ? this.legacyHeap.get(value.pointsTo) : undefined)
    const total = value.childrenInfo?.total ?? (value.childrenInfo || sourceMembers || value.isStruct ? undefined : 0)
    const metadata = {
      ...value, debugRef: ref, name: value.name.slice(0, 1024), type: value.type.slice(0, 2048),
      value: typeof value.value === 'string' ? value.value.slice(0, 8192) : value.value,
      members: undefined,
    }
    // Install a leaf first: cyclic legacy trees never recurse indefinitely.
    values.set(ref, Object.freeze({ ...metadata, childrenInfo: { total, loaded: 0, complete: total === 0 } }))
    const members: VariableNode[] = []
    if (depth < 8) {
      for (const child of sourceMembers ?? []) {
        if (values.size >= 1000) break
        this.capture(child, values, depth + 1)
        const captured = values.get(this.getRef(child))
        if (captured) members.push(captured as VariableNode)
      }
    }
    const complete = total !== undefined && members.length === total
    values.set(ref, Object.freeze({
      ...metadata, members: sourceMembers && Object.freeze(members) as unknown as VariableNode[],
      childrenInfo: Object.freeze({ total, loaded: members.length, complete }),
      availability: value.availability === 'unavailable' ? 'unavailable' : complete ? value.availability ?? 'available' : 'partial',
    }))
  }

  private validPresentation(value: DebugPresentation, page: DebugPageRequest, values: Map<DebugValueRef, Readonly<VariableNode>>): boolean {
    if (!['raw', 'scalar', 'sequence', 'map', 'grid', 'record'].includes(value.kind)
      || typeof value.summary !== 'string' || value.summary.length > 8192
      || value.start !== page.start || typeof value.complete !== 'boolean'
      || !['available', 'partial', 'unavailable'].includes(value.availability)
      || value.total !== undefined && !nonnegativeInteger(value.total)
      || value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 2048)
      || !Array.isArray(value.children) || value.children.length > page.count) return false
    if (value.shape && (!nonnegativeInteger(value.shape.rows) || !nonnegativeInteger(value.shape.columns)
      || !Number.isSafeInteger(value.shape.rows * value.shape.columns))) return false
    if (value.complete && value.availability !== 'unavailable' && value.total !== undefined
      && value.children.length !== Math.max(0, Math.min(page.count, value.total - page.start))) return false
    const keys = new Set<string>()
    return value.children.every((child) => {
      if (!child || typeof child.key !== 'string' || child.key.length > 1024 || keys.has(child.key)
        || typeof child.label !== 'string' || child.label.length > 2048 || !values.has(child.value)
        || child.keyValue !== undefined && !values.has(child.keyValue)
        || child.detail !== undefined && (typeof child.detail !== 'string' || child.detail.length > 2048)) return false
      keys.add(child.key)
      return true
    })
  }

  private async withDeadline<T>(work: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Formatter timed out')), 1500) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private retain<T>(map: Map<string, T>, key: string, value: T, maximum: number): void {
    if (map.size >= maximum && !map.has(key)) map.delete(map.keys().next().value!)
    map.set(key, value)
  }

  private unavailable(message: string): DebugPresentation {
    return { kind: 'raw', summary: '<unavailable>', children: [], start: 0, complete: false, availability: 'unavailable', message }
  }

  private key(ref: DebugValueRef, page: DebugPageRequest, mode: string): string {
    return `${this.epoch}:${ref}:${page.start}:${page.count}:${mode}`
  }

  private invalidate(): void {
    this.epoch += 1
    this.pending.clear()
    this.results.clear()
    this.pages.clear()
    this.notify()
  }

  private notify(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.registration?.dispose()
    this.listeners.clear()
    this.values.clear()
    this.legacyHeap.clear()
    this.invalidate()
  }
}

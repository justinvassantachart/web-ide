import type { DebugChildPage, DebugPageRequest, DebugValueRef } from '../web-ide/contracts/debug-presentation'
import type { VariableNode } from '../web-ide/contracts/runtime'
import { boundedDebugPage } from '../web-ide/core/debug-presentation'

export interface DapVariable {
  name?: string
  type?: string
  value?: string | number
  memoryReference?: string
  variablesReference?: number
  indexedVariables?: number
  namedVariables?: number
}

interface CapturedValue {
  value: VariableNode
  handle: number
  depth: number
  total?: number
  children: Map<number, DebugValueRef>
  error?: string
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function address(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Template arguments do not change the outer value's pointer/reference kind. */
export function classifyDebugType(type: string): NonNullable<VariableNode['typeKind']> {
  let depth = 0
  let kind: NonNullable<VariableNode['typeKind']> = 'value'
  for (const char of type) {
    if (char === '<') depth += 1
    else if (char === '>') { if (--depth < 0) return 'unknown' }
    else if (depth === 0) {
      if (char === '*' ) kind = 'pointer'
      if (char === '&') kind = 'reference'
      if ('()[]'.includes(char)) return 'unknown'
    }
  }
  return depth === 0 ? kind : 'unknown'
}

/** Private native handles and budgets are owned by exactly one pause. */
export class DebugValueCapture {
  readonly id: string
  private readonly nativeMemory: boolean
  private readonly active: () => boolean
  private readonly send: (handle: number, page: DebugPageRequest) => { success?: boolean; body?: { variables?: DapVariable[] }; message?: string } | null
  private readonly updated: () => void
  private readonly values = new Map<DebugValueRef, CapturedValue>()
  private readonly pending = new Map<string, Promise<DebugChildPage>>()
  private readonly expanding = new Set<number>()
  private nextRef = 0
  private nodes = 0
  private requests = 0
  revision = 0
  lastScopeMessage?: string

  constructor(
    id: string, nativeMemory: boolean, active: () => boolean,
    send: DebugValueCapture['send'], updated: () => void,
  ) {
    this.id = id
    this.nativeMemory = nativeMemory
    this.active = active
    this.send = send
    this.updated = updated
  }

  captureScope(handle: number, eager = true): VariableNode[] {
    this.lastScopeMessage = undefined
    const limit = Math.min(100, 1000 - this.nodes)
    const result = this.request(handle, { start: 0, count: 100 })
    if (!result) {
      this.lastScopeMessage = 'Variables unavailable or inspection limit reached.'
      return []
    }
    if (result.length === limit) this.lastScopeMessage = `Scope capture is limited to ${limit} variables.`
    return result.map((value, index) => this.capture(value, 0, index, eager)).map((ref) => this.read(ref)!)
  }

  /** Reserve roots in every frame before container children consume the budget. */
  expandValues(values: readonly VariableNode[]): void {
    for (const value of values) {
      const record = value.debugRef && this.values.get(value.debugRef)
      if (record && record.handle > 0 && !this.pageComplete(record, { start: 0, count: 100 })) {
        this.expanding.add(record.handle)
        this.load(record, { start: 0, count: 100 })
        this.expanding.delete(record.handle)
      }
    }
  }

  read(ref: DebugValueRef): VariableNode | undefined {
    const record = this.values.get(ref)
    if (!record) return undefined
    const members = [...record.children].sort(([a], [b]) => a - b).map(([, child]) => this.read(child)!)
    const complete = record.total !== undefined && record.children.size === record.total
    return Object.freeze({
      ...record.value,
      members: record.handle > 0 ? Object.freeze(members) as unknown as VariableNode[] : undefined,
      childrenInfo: Object.freeze({ total: record.total, loaded: members.length, complete }),
      availability: record.value.availability === 'unavailable' ? 'unavailable' : record.error || !complete ? 'partial' : 'available',
    })
  }

  readChildren(ref: DebugValueRef, request: DebugPageRequest): Promise<DebugChildPage> {
    const page = boundedDebugPage(request)
    const key = `${ref}:${page.start}:${page.count}`
    let pending = this.pending.get(key)
    if (!pending) {
      pending = (async () => {
        // Never re-enter a synchronous native DAP callback, even if a consumer
        // immediately expands a value from a pause/update subscriber.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const record = this.values.get(ref)
        if (!record) return this.unavailable(page, 'This value was not captured.')
        if (!this.pageComplete(record, page) && record.handle > 0) {
          if (!this.active()) return this.page(record, page, 'This stop is no longer active.')
          const previous = { nodes: this.nodes, total: record.total, error: record.error }
          const end = Math.min(page.start + page.count, record.total ?? Number.MAX_SAFE_INTEGER)
          for (let index = page.start; index < end;) {
            if (record.children.has(index)) { index += 1; continue }
            let next = index + 1
            while (next < end && !record.children.has(next)) next += 1
            if (!this.load(record, { start: index, count: next - index })) break
            index = next
          }
          if (!this.active()) return this.unavailable(page, 'Execution resumed before these children were captured.')
          if (this.nodes !== previous.nodes || record.total !== previous.total || record.error !== previous.error) {
            this.revision += 1
            this.updated()
          }
        }
        return this.page(record, page)
      })().finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    return pending
  }

  private capture(raw: DapVariable, depth: number, ordinal: number, eager = true): DebugValueRef {
    const ref = `${this.id}:v${++this.nextRef}` as DebugValueRef
    const handle = count(raw.variablesReference) ?? 0
    const indexed = count(raw.indexedVariables)
    const named = count(raw.namedVariables)
    const total = handle === 0 ? 0 : indexed !== undefined || named !== undefined ? (indexed ?? 0) + (named ?? 0) : undefined
    const type = String(raw.type ?? '')
    const value = String(raw.value ?? '')
    const typeKind = this.nativeMemory ? classifyDebugType(type) : 'value'
    const node: VariableNode = {
      debugRef: ref, debugOrdinal: ordinal, name: String(raw.name ?? ''), type, value,
      typeKind, isStruct: handle > 0 && typeKind !== 'pointer',
      availability: /^<(?:error:|unavailable>|optimized out>)/i.test(value) ? 'unavailable' : 'available',
    }
    if (this.nativeMemory) {
      node.address = address(raw.memoryReference)
      node.isPointer = typeKind === 'pointer'
      if (node.isPointer) {
        node.pointsTo = address(value)
        node.pointeeType = type.replace(/\*\s*(?:(?:const|volatile)\s*)*$/, '').trim()
      } else if (typeKind === 'reference' && value.startsWith('@')) {
        // Native compound references display @<referent address>. Scalar and
        // pointer-valued references display values, which are not alias targets.
        node.pointsTo = address(value.slice(1))
      }
    }
    const record: CapturedValue = { value: node, handle, depth, total, children: new Map() }
    this.values.set(ref, record)
    if (eager && handle > 0 && depth < 8 && !this.expanding.has(handle)) {
      this.expanding.add(handle)
      this.load(record, { start: 0, count: 100 })
      this.expanding.delete(handle)
    }
    return ref
  }

  private request(handle: number, page: DebugPageRequest): DapVariable[] | undefined {
    const remaining = 1000 - this.nodes
    if (!this.active() || remaining <= 0 || this.requests >= 250 || page.count === 0) return undefined
    this.requests += 1
    const response = this.send(handle, { start: page.start, count: Math.min(page.count, remaining) })
    if (!this.active() || response?.success !== true || !Array.isArray(response.body?.variables)) return undefined
    const result = response.body.variables.slice(0, Math.min(page.count, remaining))
    this.nodes += result.length
    return result
  }

  private load(record: CapturedValue, page: DebugPageRequest): boolean {
    const remaining = 1000 - this.nodes
    if (record.depth >= 8) { record.error = 'Maximum inspection depth reached.'; return false }
    const result = this.request(record.handle, page)
    if (!result) { record.error = 'Children unavailable or inspection budget reached.'; return false }
    if (record.total === undefined && result.length < Math.min(page.count, remaining)) record.total = page.start + result.length
    for (const [index, raw] of result.entries()) {
      const ordinal = page.start + index
      if (record.children.has(ordinal)) continue
      // Eager capture remains depth-bounded. Lazy pages use the same bounded
      // recursion so wrapper fields and element scalars are ready together.
      record.children.set(ordinal, this.capture(raw, record.depth + 1, ordinal))
    }
    record.error = undefined
    return true
  }

  private pageComplete(record: CapturedValue, page: DebugPageRequest): boolean {
    if (page.count === 0) return true
    const end = record.total === undefined ? page.start + page.count : Math.min(record.total, page.start + page.count)
    for (let index = page.start; index < end; index += 1) if (!record.children.has(index)) return false
    return record.total !== undefined || page.count > 0
  }

  private page(record: CapturedValue, page: DebugPageRequest, message?: string): DebugChildPage {
    const children = [...record.children].filter(([index]) => index >= page.start && index < page.start + page.count)
      .sort(([a], [b]) => a - b).map(([, ref]) => this.read(ref)!)
    const complete = this.pageComplete(record, page)
    return {
      children, start: page.start, total: record.total, complete,
      availability: record.value.availability === 'unavailable' ? 'unavailable' : complete ? 'available' : 'partial',
      message: message ?? record.error,
    }
  }

  private unavailable(page: DebugPageRequest, message: string): DebugChildPage {
    return { children: [], start: page.start, complete: false, availability: 'unavailable', message }
  }
}

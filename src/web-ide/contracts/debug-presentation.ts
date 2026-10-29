import type { VariableNode } from './runtime'

/** An opaque value identity; native debugger handles never cross this boundary. */
export type DebugValueRef = string & { readonly __debugValueRef: unique symbol }

export type DebugAvailability = 'available' | 'partial' | 'unavailable'

export interface DebugPageRequest {
  readonly start: number
  readonly count: number
}

export interface DebugChildrenInfo {
  readonly total?: number
  readonly loaded: number
  readonly complete: boolean
}

export interface DebugChildPage {
  readonly children: readonly VariableNode[]
  readonly start: number
  readonly total?: number
  readonly complete: boolean
  readonly availability: DebugAvailability
  readonly message?: string
}

export interface DebugPresentationChild {
  readonly key: string
  readonly label: string
  readonly value: DebugValueRef
  /** Map keys retain their own identity and can be expanded like any other value. */
  readonly keyValue?: DebugValueRef
  readonly detail?: string
}

/** Logical children refer back to captured values, preserving native identity. */
export interface DebugPresentation {
  readonly kind: 'raw' | 'scalar' | 'sequence' | 'map' | 'grid' | 'record'
  readonly summary: string
  readonly children: readonly DebugPresentationChild[]
  readonly start: number
  readonly total?: number
  /** Whether this requested logical range was completely captured. */
  readonly complete: boolean
  readonly availability: DebugAvailability
  readonly message?: string
  readonly shape?: { readonly rows: number; readonly columns: number }
}

export interface DebugFormatContext {
  /** Reads immutable captured metadata without issuing a debugger request. */
  readValue(value: DebugValueRef): Readonly<VariableNode> | undefined
  /** Loads a bounded raw child range. Historical snapshots remain captured-only. */
  readChildren(value: DebugValueRef, page: DebugPageRequest): Promise<DebugChildPage>
}

/** A course-neutral presentation contribution. Return undefined for unknown layouts. */
export interface DebugValueFormatter {
  readonly id: string
  readonly order?: number
  matches(value: Readonly<VariableNode>): boolean
  format(
    value: Readonly<VariableNode>,
    context: DebugFormatContext,
    page: DebugPageRequest,
  ): DebugPresentation | undefined | Promise<DebugPresentation | undefined>
}

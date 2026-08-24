/** A visible source position in the editable `/workspace` file plane. */
export interface IDESourceLocation {
  /** Canonical absolute workspace path, for example `/workspace/main.py`. */
  readonly path: string
  /** One-based source line. */
  readonly line: number
  /** Optional one-based source column. */
  readonly column?: number
}

/** Activity-neutral visual meaning for a source decoration. */
export type IDESourceDecorationKind = 'current' | 'historical' | 'error'

/** A validated visible source position with its presentation meaning. */
export interface IDESourceDecoration extends IDESourceLocation {
  readonly kind: IDESourceDecorationKind
}

/** Immutable aggregate presentation consumed by an editor adapter. */
export interface IDESourcePresentationSnapshot {
  readonly decorations: readonly IDESourceDecoration[]
}

/**
 * Owner-bound source facade supplied to one plugin/activity instance. It does
 * not reveal editor state, stores, Monaco objects, or another owner's identity.
 */
export interface IDESourcePresentationOwner {
  /** Requests navigation to one validated, visible source position. */
  reveal(location: IDESourceLocation): void
  /** Atomically replaces every decoration owned by this facade. */
  replaceDecorations(decorations: readonly IDESourceDecoration[]): void
  /** Clears only this facade's decorations. */
  clearDecorations(): void
  /** Idempotently clears this facade and permanently revokes it. */
  dispose(): void
}

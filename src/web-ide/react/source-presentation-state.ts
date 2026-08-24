import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type {
  IDESourceDecoration,
  IDESourceLocation,
  IDESourcePresentationOwner,
} from '../contracts/source-presentation'
import type { SourcePresentationController } from '../core/source-presentation'

export interface SourceRevealRequest {
  readonly sequence: number
  readonly location: IDESourceLocation
}

export interface SourcePresentationContextValue {
  readonly controller: SourcePresentationController
  readonly revealRequest: SourceRevealRequest | null
}

export const SourcePresentationContext = createContext<SourcePresentationContextValue | null>(null)

function createLazyOwner(
  controller: SourcePresentationController,
): IDESourcePresentationOwner {
  let delegate: IDESourcePresentationOwner | undefined
  let disposed = false

  const requireOwner = (): IDESourcePresentationOwner => {
    if (disposed) throw new Error('Source presentation owner is no longer active')
    delegate ??= controller.createOwner()
    return delegate
  }

  // Creating the proxy is side-effect free. React Strict Mode may discard a
  // render-time memo value before any effect gets an opportunity to clean it.
  return Object.freeze({
    reveal(location: IDESourceLocation) {
      requireOwner().reveal(location)
    },
    replaceDecorations(decorations: readonly IDESourceDecoration[]) {
      requireOwner().replaceDecorations(decorations)
    },
    clearDecorations() {
      requireOwner().clearDecorations()
    },
    dispose() {
      if (disposed) return
      disposed = true
      delegate?.dispose()
    },
  })
}

function useSourcePresentationContext(): SourcePresentationContextValue {
  const value = useContext(SourcePresentationContext)
  if (!value) {
    throw new Error('Source presentation requires a mounted Web IDE workbench')
  }
  return value
}

/** Creates a lazily registered owner and revokes it on contribution unmount. */
export function useSourcePresentationOwner(): IDESourcePresentationOwner {
  const { controller } = useSourcePresentationContext()
  const owner = useMemo(() => createLazyOwner(controller), [controller])
  const pendingDisposal = useRef<
    { owner: IDESourcePresentationOwner; cancelled: boolean } | undefined
  >(undefined)

  useEffect(() => {
    if (pendingDisposal.current?.owner === owner) {
      pendingDisposal.current.cancelled = true
      pendingDisposal.current = undefined
    }

    return () => {
      const ticket = { owner, cancelled: false }
      pendingDisposal.current = ticket
      queueMicrotask(() => {
        if (!ticket.cancelled) ticket.owner.dispose()
      })
    }
  }, [owner])

  return owner
}

/** Editor-only aggregate; contribution owners never receive this snapshot. */
export function useSourcePresentationState() {
  const value = useSourcePresentationContext()
  const snapshot = useSyncExternalStore(
    value.controller.subscribe,
    value.controller.getSnapshot,
    value.controller.getSnapshot,
  )
  return { snapshot, revealRequest: value.revealRequest }
}

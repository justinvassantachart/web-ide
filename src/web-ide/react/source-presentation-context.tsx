import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { IDESourceLocation } from '../contracts/source-presentation'
import { SourcePresentationController } from '../core/source-presentation'
import {
  SourcePresentationContext,
  type SourceRevealRequest,
} from './source-presentation-state'
import { useWorkbenchInstance } from './workbench-instance-context'

/** Owns one source controller for one Web IDE mount/workspace identity. */
export function SourcePresentationProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string
  children: ReactNode
}) {
  const [revealRequest, setRevealRequest] = useState<SourceRevealRequest | null>(null)
  const instance = useWorkbenchInstance()
  const readVisibleSource = useCallback((path: string): string | undefined => {
    if (!instance.workspace.fileExists(path)) return undefined
    try {
      return instance.workspace.readFile(path)
    } catch {
      return undefined
    }
  }, [instance])
  const pendingDisposal = useRef<
    { controller: SourcePresentationController; cancelled: boolean } | undefined
  >(undefined)

  const reveal = useCallback((location: IDESourceLocation) => {
    if (!instance.workspace.fileExists(location.path)) {
      throw new TypeError(`Source path is no longer visible: ${JSON.stringify(location.path)}`)
    }
    instance.editorStore.getState().setActiveFile(location.path, instance.workspace.readFile(location.path))
    setRevealRequest((previous) => Object.freeze({
      sequence: (previous?.sequence ?? 0) + 1,
      location,
    }))
  }, [instance])

  const controller = useMemo(
    () => new SourcePresentationController({
      readVisibleSource,
      onReveal: reveal,
    }),
    // A new workspace identity must revoke every old owner even when the
    // embedding application reuses the same WebIDE React component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reveal, workspaceKey],
  )

  useEffect(() => {
    if (pendingDisposal.current?.controller === controller) {
      pendingDisposal.current.cancelled = true
      pendingDisposal.current = undefined
    }

    return () => {
      const ticket = { controller, cancelled: false }
      pendingDisposal.current = ticket
      queueMicrotask(() => {
        if (!ticket.cancelled) ticket.controller.dispose()
      })
    }
  }, [controller])

  useEffect(
    () => instance.workspace.subscribe(controller.pruneInvalid),
    [controller, instance],
  )

  const value = useMemo(
    () => ({ controller, revealRequest }),
    [controller, revealRequest],
  )

  return (
    <SourcePresentationContext.Provider value={value}>
      {children}
    </SourcePresentationContext.Provider>
  )
}

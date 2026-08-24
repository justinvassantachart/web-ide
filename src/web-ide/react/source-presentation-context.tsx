import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useEditorStore } from '@/store/editor-store'
import { fileExists, readFile, subscribeWorkspaceChange } from '@/vfs/volume'
import type { IDESourceLocation } from '../contracts/source-presentation'
import { SourcePresentationController } from '../core/source-presentation'
import {
  SourcePresentationContext,
  type SourceRevealRequest,
} from './source-presentation-state'

function readVisibleSource(path: string): string | undefined {
  if (!fileExists(path)) return undefined
  try {
    return readFile(path)
  } catch {
    // Directories and files removed between exists/read are not source files.
    return undefined
  }
}

/** Owns one source controller for one Web IDE mount/workspace identity. */
export function SourcePresentationProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string
  children: ReactNode
}) {
  const [revealRequest, setRevealRequest] = useState<SourceRevealRequest | null>(null)
  const pendingDisposal = useRef<
    { controller: SourcePresentationController; cancelled: boolean } | undefined
  >(undefined)

  const reveal = useCallback((location: IDESourceLocation) => {
    if (!fileExists(location.path)) {
      throw new TypeError(`Source path is no longer visible: ${JSON.stringify(location.path)}`)
    }
    useEditorStore.getState().setActiveFile(location.path, readFile(location.path))
    setRevealRequest((previous) => Object.freeze({
      sequence: (previous?.sequence ?? 0) + 1,
      location,
    }))
  }, [])

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
    () => subscribeWorkspaceChange(controller.pruneInvalid),
    [controller],
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

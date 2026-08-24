import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ResolvedWebIDEInitialLayout } from '../core/initial-layout'
import type { PanelLayoutController } from '../core/panel-layout'

export interface PanelLayoutContextValue {
  readonly controller: PanelLayoutController
  readonly initialLayout: ResolvedWebIDEInitialLayout
}

export const PanelLayoutContext = createContext<PanelLayoutContextValue | null>(null)

export function usePanelLayout(): PanelLayoutContextValue & {
  readonly selectedPanelId: string | undefined
} {
  const value = useContext(PanelLayoutContext)
  if (!value) throw new Error('Panel layout requires <WebIDE>')
  const selectedPanelId = useSyncExternalStore(
    value.controller.subscribe,
    value.controller.getSnapshot,
    value.controller.getSnapshot,
  )
  return { ...value, selectedPanelId }
}

import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  SidebarLayoutController,
  SidebarLayoutSnapshot,
} from '../core/sidebar-layout'

export const SidebarLayoutContext = createContext<SidebarLayoutController | null>(null)

export function useSidebarLayout(): Readonly<{
  controller: SidebarLayoutController
  snapshot: SidebarLayoutSnapshot
}> {
  const controller = useContext(SidebarLayoutContext)
  if (!controller) throw new Error('Sidebar layout requires <WebIDE>')
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  return { controller, snapshot }
}

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { DebugPresentationService } from '../core/debug-presentation'
import type { DebugPageRequest, DebugValueRef } from '../contracts/debug-presentation'
import { useWorkbenchDebugStore } from './workbench-instance-context'

export const DebugPresentationContext = createContext<DebugPresentationService | null>(null)

export function useDebugPresentationService(): DebugPresentationService {
  const service = useContext(DebugPresentationContext)
  if (!service) throw new Error('Debugger presentation requires <WebIDE>')
  return service
}

export function useDebugPresentation(ref: DebugValueRef, page: DebugPageRequest) {
  const service = useDebugPresentationService()
  const mode = useWorkbenchDebugStore(state => state.presentationMode)
  const revision = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  const result = service.getPresentation(ref, page, mode)
  useEffect(() => {
    if (!result) void service.present(ref, { start: page.start, count: page.count }, mode)
  }, [service, ref, page.start, page.count, mode, result, revision])
  return result
}

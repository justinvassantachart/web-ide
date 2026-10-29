import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useEngine } from '@/engine/engine-context'
import { DebugPresentationService } from '../core/debug-presentation'
import { useIDEContributions } from './contribution-context'
import { useWorkbenchDebugStore } from './workbench-instance-context'
import { DebugPresentationContext } from './debug-presentation-state'

export function DebugPresentationProvider({ children }: { children: ReactNode }) {
  const runtime = useEngine()
  const { debugFormatters } = useIDEContributions()
  const service = useMemo(() => new DebugPresentationService(runtime, debugFormatters), [runtime, debugFormatters])
  const pause = useWorkbenchDebugStore(state => state.activePause)
  const live = useWorkbenchDebugStore(state => state.debugMode === 'paused' && state.stepIndex < 0)
  const pendingDisposal = useRef<{ service: DebugPresentationService; cancelled: boolean } | undefined>(undefined)

  useLayoutEffect(() => { service.setSnapshot(pause, live) }, [service, pause, live])
  useEffect(() => {
    if (pendingDisposal.current?.service === service) pendingDisposal.current.cancelled = true
    return () => {
      const ticket = { service, cancelled: false }
      pendingDisposal.current = ticket
      queueMicrotask(() => { if (!ticket.cancelled) ticket.service.dispose() })
    }
  }, [service])

  return <DebugPresentationContext.Provider value={service}>{children}</DebugPresentationContext.Provider>
}

import { useEffect, useState, type ReactNode } from 'react'
import {
  createRunPipelineCoordinator,
  RunPipelineCoordinatorContext,
} from './run-pipeline-context'

export function RunPipelineCoordinatorProvider({
  children,
}: {
  children: ReactNode
}) {
  const [coordinator] = useState(createRunPipelineCoordinator)

  useEffect(() => () => {
    // Every pending pipeline checks this generation after asynchronous and
    // re-entrant boundaries. Invalidating it prevents an unmounted workbench
    // from starting a runtime after its owning EngineProvider has disposed.
    coordinator.beginTransition()
  }, [coordinator])

  return (
    <RunPipelineCoordinatorContext.Provider value={coordinator}>
      {children}
    </RunPipelineCoordinatorContext.Provider>
  )
}

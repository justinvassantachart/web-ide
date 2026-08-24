import { createContext, useContext } from 'react'

export interface RunPipelineCoordinator {
  beginTransition(): number
  clearPendingRun(task: Promise<void>): void
  getGeneration(): number
  getPendingRun(): Promise<void> | undefined
  isPreparing(task: Promise<void>): boolean
  isCurrent(generation: number): boolean
  markRuntimeStart(generation: number): void
  setPendingRun(task: Promise<void>): void
}

export function createRunPipelineCoordinator(): RunPipelineCoordinator {
  let generation = 0
  let pendingRun: Promise<void> | undefined
  let pendingRunIsPreparing = false
  return {
    beginTransition: () => {
      generation += 1
      return generation
    },
    clearPendingRun: (task) => {
      if (pendingRun === task) {
        pendingRun = undefined
        pendingRunIsPreparing = false
      }
    },
    getGeneration: () => generation,
    getPendingRun: () => pendingRun,
    isPreparing: (task) => pendingRun === task && pendingRunIsPreparing,
    isCurrent: (candidate) => generation === candidate,
    markRuntimeStart: (candidate) => {
      if (generation === candidate && pendingRun) {
        pendingRunIsPreparing = false
      }
    },
    setPendingRun: (task) => {
      pendingRun = task
      pendingRunIsPreparing = true
    },
  }
}

export const RunPipelineCoordinatorContext =
  createContext<RunPipelineCoordinator | null>(null)

export function useRunPipelineCoordinator(): RunPipelineCoordinator {
  const coordinator = useContext(RunPipelineCoordinatorContext)
  if (!coordinator) {
    throw new Error(
      'useRunPipeline must be used within RunPipelineCoordinatorProvider',
    )
  }
  return coordinator
}

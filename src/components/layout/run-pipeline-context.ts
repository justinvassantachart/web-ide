import { createContext, useContext } from 'react'

export interface RunPipelineCoordinator {
  acquireActivity(foreground?: boolean): (() => void) | undefined
  attachActivity(factory: (foreground: boolean) => (() => void) | undefined): () => void
  suspend(): void
  resume(): void
  beginTransition(): number
  clearPendingRun(task: Promise<void>): void
  getGeneration(): number
  hasForegroundIntent(): boolean
  getPendingRun(): Promise<void> | undefined
  isPreparing(task: Promise<void>): boolean
  isCurrent(generation: number): boolean
  markRuntimeStart(generation: number): void
  setPendingRun(task: Promise<void>): void
}

export function createRunPipelineCoordinator(): RunPipelineCoordinator {
  let generation = 0
  let suspended = false
  let foregroundIntent = false
  let acquireActivity: ((foreground: boolean) => (() => void) | undefined) | undefined
  let pendingRun: Promise<void> | undefined
  let pendingRunIsPreparing = false
  return {
    acquireActivity: (foreground = true) => {
      if (suspended) return undefined
      const release = acquireActivity ? acquireActivity(foreground) : (() => {})
      if (release && foreground) foregroundIntent = true
      return release
    },
    attachActivity(factory) {
      acquireActivity = factory
      return () => { if (acquireActivity === factory) acquireActivity = undefined }
    },
    suspend() { suspended = true; generation++ },
    resume() { suspended = false },
    beginTransition: () => {
      foregroundIntent = true
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
    hasForegroundIntent: () => foregroundIntent,
    getPendingRun: () => pendingRun,
    isPreparing: (task) => pendingRun === task && pendingRunIsPreparing,
    isCurrent: (candidate) => !suspended && generation === candidate,
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

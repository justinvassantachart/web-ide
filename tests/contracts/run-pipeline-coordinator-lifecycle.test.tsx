// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { RunPipelineCoordinatorProvider } from '../../src/components/layout/RunPipelineCoordinator'
import {
  useRunPipelineCoordinator,
  type RunPipelineCoordinator,
} from '../../src/components/layout/run-pipeline-context'

let root: Root | undefined
const observed: RunPipelineCoordinator[] = []

function CoordinatorProbe() {
  const coordinator = useRunPipelineCoordinator()
  useEffect(() => {
    observed.push(coordinator)
  }, [coordinator])
  return null
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = undefined
  }
  observed.length = 0
})

describe('run pipeline coordinator ownership', () => {
  it('shares one coordinator per mount and invalidates it on unmount', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <RunPipelineCoordinatorProvider>
          <CoordinatorProbe />
          <CoordinatorProbe />
        </RunPipelineCoordinatorProvider>,
      )
      await Promise.resolve()
    })

    expect(observed).toHaveLength(2)
    expect(observed[0]).toBe(observed[1])
    const coordinator = observed[0]!
    const mountedGeneration = coordinator.getGeneration()

    await act(async () => root?.unmount())
    root = undefined

    expect(coordinator.getGeneration()).toBe(mountedGeneration + 1)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { useTestStore } from '../../src/testing/test-store'

beforeEach(() => useTestStore.getState().reset())

describe('generic structured test result store', () => {
  it('reduces framework-neutral events into panel state', () => {
    const process = useTestStore.getState().processEvent
    process({ type: 'run-start', total: 1 })
    process({ type: 'test-start', testId: 'one', name: 'works' })
    process({
      type: 'test-assertion',
      testId: 'one',
      assertion: {
        status: 'fail',
        actual: { value: '3' },
        expected: { value: '4' },
      },
    })
    process({
      type: 'test-diagnostic',
      testId: 'one',
      diagnostic: { message: 'values differ' },
    })
    process({ type: 'test-end', testId: 'one', status: 'fail', durationMs: 4 })
    process({ type: 'run-end' })

    expect(useTestStore.getState()).toMatchObject({
      isTesting: false,
      completedCount: 1,
      totalCount: 1,
      tests: [{
        id: 'one',
        name: 'works',
        status: 'fail',
        durationMs: 4,
        assertions: [{
          status: 'fail',
          actual: { value: '3' },
          expected: { value: '4' },
        }],
        diagnostics: [{ message: 'values differ' }],
      }],
    })
  })

  it('turns unfinished cases into failures when a run exits unexpectedly', () => {
    const process = useTestStore.getState().processEvent
    process({ type: 'run-start', total: 1 })
    process({ type: 'test-start', testId: 'crash', name: 'crashes' })

    useTestStore.getState().finalize()

    expect(useTestStore.getState()).toMatchObject({
      isTesting: false,
      tests: [{ id: 'crash', status: 'fail' }],
    })
  })
})

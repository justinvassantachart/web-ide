import { expect, it } from 'vitest'
import { createTestStore } from '../../src/testing/test-store'
it('projects V2 rows for host snapshots without a second execution protocol', () => {
  const store = createTestStore()
  store.getState().update({ state: 'ready', tests: [{ id: 'a', name: 'First', origin: 'student' }], events: [
    { apiVersion: 2, kind: 'report_event', runId: 'run', sequence: 0, event: { type: 'test_started', testId: 'a' } },
    { apiVersion: 2, kind: 'report_event', runId: 'run', sequence: 1, event: { type: 'test_failed', testId: 'a', message: 'different', actual: { value: '1' }, expected: { value: '2' }, path: '/workspace/main.cpp', line: 3 } },
  ] })
  expect(store.getState()).toMatchObject({ isTesting: false, completedCount: 1, totalCount: 1, tests: [{ name: 'First', status: 'fail', location: { file: '/workspace/main.cpp', line: 3 }, assertions: [{ actual: { value: '1' }, expected: { value: '2' } }] }] })
  store.getState().reset()
  expect(store.getState().tests).toEqual([])
})

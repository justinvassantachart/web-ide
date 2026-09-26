import { createStore, type StoreApi } from 'zustand/vanilla'
import type { TestCaseStatus, TestAssertion, TestDiagnostic, TestLocation } from '@/web-ide/contracts/testing'
import type { IDETestingSnapshotV2 } from './testing-controller-v2'

/** Compact host-handle projection. The V2 controller is the authoritative state. */
export interface TestCase {
  id: string
  name: string
  status: TestCaseStatus
  location?: TestLocation
  assertions: TestAssertion[]
  diagnostics: TestDiagnostic[]
  durationMs?: number
}
export interface TestState {
  isTesting: boolean
  tests: TestCase[]
  completedCount: number
  totalCount: number
  reset(): void
  update(snapshot: IDETestingSnapshotV2): void
  finalize(): void
}
export function createTestStore(): StoreApi<TestState> {
  return createStore<TestState>((set) => ({
    isTesting: false, tests: [], completedCount: 0, totalCount: 0,
    reset: () => set({ isTesting: false, tests: [], completedCount: 0, totalCount: 0 }),
    update(snapshot) {
      const descriptors = new Map(snapshot.tests.map(test => [test.id, test]))
      const rows = new Map<string, TestCase>()
      for (const { event } of snapshot.events) {
        if (event.type === 'test_started') {
          const descriptor = descriptors.get(event.testId)
          rows.set(event.testId, { id: event.testId, name: descriptor?.name ?? event.testId, status: 'running', assertions: [], diagnostics: [] })
        } else if (event.type === 'test_passed' || event.type === 'test_failed' || event.type === 'test_errored' || event.type === 'test_skipped') {
          const row = rows.get(event.testId)
          if (!row) continue
          row.status = event.type === 'test_passed' ? 'pass' : event.type === 'test_failed' ? 'fail' : event.type === 'test_errored' ? 'error' : 'skip'
          row.durationMs = event.durationMs
          if (event.path) row.location = { file: event.path, line: event.line, column: event.column }
          if (event.actual || event.expected) row.assertions.push({ status: 'fail', message: event.message, actual: event.actual, expected: event.expected, location: row.location })
          else if (event.message) row.diagnostics.push({ message: event.message, details: event.details, location: row.location })
        } else if (event.type === 'run_terminated') {
          for (const row of rows.values()) if (row.status === 'running') row.status = 'error'
        }
      }
      const tests = [...rows.values()]
      set({ tests, isTesting: snapshot.state === 'running', completedCount: tests.filter(test => test.status !== 'running').length, totalCount: snapshot.tests.length })
    },
    finalize: () => set(state => state.isTesting ? { isTesting: false, tests: state.tests.map(test => test.status === 'running' ? { ...test, status: 'error' } : test) } : state),
  }))
}

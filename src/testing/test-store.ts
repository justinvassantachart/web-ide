import { create } from 'zustand'
import type {
  TestAssertion,
  TestCaseStatus,
  TestDiagnostic,
  TestEvent,
  TestLocation,
} from '@/web-ide/contracts/testing'

export interface TestCase {
  id: string
  name: string
  status: TestCaseStatus
  location?: TestLocation
  assertions: TestAssertion[]
  diagnostics: TestDiagnostic[]
  durationMs?: number
}

interface TestState {
  isTesting: boolean
  tests: TestCase[]
  completedCount: number
  totalCount: number
  reset(): void
  processEvent(event: TestEvent): void
  /** Marks cases left running by a crash or preparation failure as failed. */
  finalize(): void
}

function updateTest(
  tests: readonly TestCase[],
  testId: string,
  update: (test: TestCase) => TestCase,
): TestCase[] | undefined {
  const index = tests.findIndex(({ id }) => id === testId)
  if (index === -1) return undefined
  const next = tests.slice()
  next[index] = update(next[index])
  return next
}

export const useTestStore = create<TestState>((set) => ({
  isTesting: false,
  tests: [],
  completedCount: 0,
  totalCount: 0,

  reset: () => set({
    tests: [],
    completedCount: 0,
    totalCount: 0,
    isTesting: false,
  }),

  processEvent: (event) => set((state) => {
    if (event.type === 'run-start') {
      return {
        totalCount: event.total ?? 0,
        tests: [],
        completedCount: 0,
        isTesting: true,
      }
    }

    if (event.type === 'run-end') return { isTesting: false }

    if (event.type === 'test-start') {
      return {
        isTesting: true,
        tests: [
          ...state.tests.filter(({ id }) => id !== event.testId),
          {
            id: event.testId,
            name: event.name,
            status: 'running',
            location: event.location,
            assertions: [],
            diagnostics: [],
          },
        ],
      }
    }

    if (event.type === 'test-assertion') {
      const tests = updateTest(state.tests, event.testId, (test) => ({
        ...test,
        assertions: [...test.assertions, event.assertion],
      }))
      return tests ? { tests } : state
    }

    if (event.type === 'test-diagnostic') {
      const tests = updateTest(state.tests, event.testId, (test) => ({
        ...test,
        diagnostics: [...test.diagnostics, event.diagnostic],
      }))
      return tests ? { tests } : state
    }

    const current = state.tests.find(({ id }) => id === event.testId)
    const tests = updateTest(state.tests, event.testId, (test) => ({
      ...test,
      status: event.status,
      durationMs: event.durationMs,
    }))
    if (!tests) return state
    return {
      tests,
      completedCount: current?.status === 'running'
        ? state.completedCount + 1
        : state.completedCount,
    }
  }),

  finalize: () => set((state) => {
    if (!state.isTesting && state.tests.every(({ status }) => status !== 'running')) {
      return state
    }
    const tests = state.tests.map((test) =>
      test.status === 'running' ? { ...test, status: 'fail' as const } : test,
    )
    return { tests, isTesting: false }
  }),
}))

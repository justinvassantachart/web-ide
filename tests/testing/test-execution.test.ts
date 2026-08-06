import { describe, expect, it, vi } from 'vitest'
import {
  createTestStreamInterceptor,
  prepareWorkbenchExecution,
  resolveTestProvider,
} from '../../src/testing/test-execution'
import type {
  TestOutputParser,
  TestProvider,
} from '../../src/web-ide/contracts/testing'

function provider(id: string, languageIds: readonly string[]): TestProvider {
  return {
    id,
    label: id,
    languageIds,
    prepare: ({ files, mode }) => ({ execution: { files, mode } }),
  }
}

describe('test provider selection', () => {
  const cpp = provider('cpp-tests', ['cpp'])
  const alternateCpp = provider('alternate-cpp-tests', ['cpp'])
  const python = provider('python-tests', ['python'])
  const runtime = { languageIds: ['c', 'cpp'] as const }

  it('selects exactly one compatible provider without hidden ordering rules', () => {
    expect(resolveTestProvider([python, cpp], runtime)).toBe(cpp)
    expect(resolveTestProvider([cpp, alternateCpp], runtime)).toBeUndefined()
    expect(resolveTestProvider([python], runtime)).toBeUndefined()
  })

  it('honors an explicit compatible provider and rejects invalid selections', () => {
    expect(resolveTestProvider([alternateCpp, cpp], runtime, cpp.id)).toBe(cpp)
    expect(() => resolveTestProvider([cpp], runtime, 'missing')).toThrow(
      'No test provider contributed with id "missing"',
    )
    expect(() => resolveTestProvider([python], runtime, python.id)).toThrow(
      'does not support the selected runtime languages',
    )
  })
})

describe('test execution preparation', () => {
  it('adapts provider parsing into a generic runtime stream interceptor', async () => {
    const events = [
      { type: 'run-start' as const, total: 1 },
      { type: 'run-end' as const },
    ]
    const parser: TestOutputParser = {
      push: vi.fn((_stream, chunk) => ({
        output: chunk.replace('[control]', ''),
        events: [events[0]],
      })),
      finish: vi.fn(() => ({ output: 'tail', events: [events[1]] })),
    }
    const testProvider: TestProvider = {
      id: 'example.tests',
      label: 'Example',
      languageIds: ['example'],
      prepare: ({ files }) => ({
        execution: {
          files: { ...files, '/workspace/runner.example': 'runner' },
          mode: 'run',
          entrypoint: '/workspace/runner.example',
        },
        parser,
      }),
    }
    const onTestEvent = vi.fn()

    const plan = await prepareWorkbenchExecution({
      files: { '/workspace/main.example': 'source' },
      mode: 'debug',
      executeTests: true,
      testProvider,
      onTestEvent,
    })

    expect(plan).toMatchObject({
      mode: 'run',
      entrypoint: '/workspace/runner.example',
    })
    expect(plan.streamInterceptor?.push('stdout', 'a[control]b')).toBe('ab')
    expect(plan.streamInterceptor?.finish()).toBe('tail')
    expect(onTestEvent.mock.calls).toEqual([[events[0]], [events[1]]])
  })

  it('runs provider support preparation for ordinary executions', async () => {
    const prepare = vi.fn<TestProvider['prepare']>(({ files, mode }) => ({
      execution: {
        files: { ...files, '/workspace/support.hpp': 'support' },
        mode,
      },
    }))

    const plan = await prepareWorkbenchExecution({
      files: { '/workspace/main.cpp': 'int main() {}' },
      mode: 'debug',
      executeTests: false,
      testProvider: {
        id: 'cpp-tests',
        label: 'C++ Tests',
        languageIds: ['cpp'],
        prepare,
      },
      onTestEvent: vi.fn(),
    })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'debug',
      executeTests: false,
    }))
    expect(plan.files['/workspace/support.hpp']).toBe('support')
    expect(plan.streamInterceptor).toBeUndefined()
  })

  it('rejects test execution without a provider or parser', async () => {
    const request = {
      files: {},
      mode: 'run' as const,
      executeTests: true,
      onTestEvent: vi.fn(),
    }
    await expect(prepareWorkbenchExecution(request)).rejects.toThrow(
      'No unambiguous test provider',
    )
    await expect(prepareWorkbenchExecution({
      ...request,
      testProvider: provider('missing-parser', ['cpp']),
    })).rejects.toThrow('did not create an output parser')
  })

  it('dispatches every event returned in one parser frame', () => {
    const onEvent = vi.fn()
    const parser: TestOutputParser = {
      push: () => ({
        output: '',
        events: [
          { type: 'run-start', total: 0 },
          { type: 'run-end' },
        ],
      }),
      finish: () => ({ output: '', events: [] }),
    }
    const interceptor = createTestStreamInterceptor(parser, onEvent)
    interceptor.push('stdout', 'frame')
    expect(onEvent).toHaveBeenCalledTimes(2)
  })
})

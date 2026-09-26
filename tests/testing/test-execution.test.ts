import { describe, expect, it, vi } from 'vitest'
import { prepareWorkbenchExecution, resolveTestProvider } from '../../src/testing/test-execution'
import { cppTestProvider } from '../../src/cpp/testing/provider'
import type { TestProviderV2 } from '../../src/web-ide/contracts/testing'
describe('V2 provider selection and ordinary preparation', () => {
  const cpp = cppTestProvider
  const alternate: TestProviderV2 = { ...cpp, id: 'alternate' }
  const python: TestProviderV2 = { ...cpp, id: 'python', languageIds: ['python'] }
  it('selects only an unambiguous compatible provider', () => {
    expect(resolveTestProvider([python, cpp], { languageIds: ['cpp'] })).toBe(cpp)
    expect(resolveTestProvider([cpp, alternate], { languageIds: ['cpp'] })).toBeUndefined()
    expect(() => resolveTestProvider([cpp], { languageIds: ['cpp'] }, 'missing')).toThrow('No test provider')
    expect(() => resolveTestProvider([python], { languageIds: ['cpp'] }, 'python')).toThrow('does not support')
  })
  it('prepares support without a runner for ordinary execution and requires the controller for tests', async () => {
    const prepareExecution = vi.fn<NonNullable<TestProviderV2['prepareExecution']>>(({ files, mode }) => ({ files, mode }))
    const request = { files: {}, mode: 'debug' as const, executeTests: false, testProvider: { ...cpp, prepareExecution } }
    await expect(prepareWorkbenchExecution(request)).resolves.toEqual({ files: {}, mode: 'debug' })
    expect(prepareExecution).toHaveBeenCalledOnce()
    await expect(prepareWorkbenchExecution({ ...request, executeTests: true })).rejects.toThrow('Testing V2 controller')
  })
})

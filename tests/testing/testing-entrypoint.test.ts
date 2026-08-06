import { describe, expect, it } from 'vitest'
import * as runtimeEntry from '../../src/runtimes'
import * as testingEntry from '../../src/testing'

describe('testing package entrypoint', () => {
  it('exports UI and language providers without coupling them to runtimes', () => {
    expect(testingEntry).toMatchObject({
      testingPlugin: expect.objectContaining({ id: 'web-ide.testing-ui' }),
      cppTestingPlugin: expect.objectContaining({ id: 'web-ide.testing.cpp' }),
      cppTestProvider: expect.objectContaining({ id: 'web-ide.testing.cpp' }),
      pythonTestingPlugin: expect.objectContaining({
        id: 'web-ide.testing.python-unittest',
      }),
      pythonUnittestTestProvider: expect.objectContaining({
        id: 'web-ide.testing.python-unittest',
      }),
    })
    expect(runtimeEntry).not.toHaveProperty('cppTestingPlugin')
    expect(runtimeEntry).not.toHaveProperty('pythonTestingPlugin')
  })
})

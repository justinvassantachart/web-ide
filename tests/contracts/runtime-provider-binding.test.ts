import { describe, expect, it } from 'vitest'

import type {
  RuntimeProvider,
  RuntimeSession,
} from '../../src/web-ide/contracts/runtime'
import { createRuntimeSessionFactory } from '../../src/web-ide/core/runtime-provider'

describe('runtime provider session factory', () => {
  it('preserves the receiver for method-style providers', () => {
    const session = {} as RuntimeSession
    const provider: RuntimeProvider = {
      id: 'host.runtime.method-style',
      label: 'Method-style runtime',
      languageIds: ['custom'],
      capabilities: {
        debug: false,
        breakpoints: false,
        stdin: false,
        graphics: false,
      },
      createSession() {
        expect(this).toBe(provider)
        return session
      },
    }

    const createSession = createRuntimeSessionFactory(provider)

    expect(createSession()).toBe(session)
  })
})

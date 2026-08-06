import { describe, expect, it } from 'vitest'

import { isMonacoCancellation } from '../../src/lib/use-monaco'

describe('Monaco loader cancellation handling', () => {
  it('recognizes only the loader cancellation sentinel', () => {
    expect(
      isMonacoCancellation({
        type: 'cancelation',
        msg: 'operation is manually canceled',
      }),
    ).toBe(true)
    expect(isMonacoCancellation(new Error('network failure'))).toBe(false)
    expect(isMonacoCancellation(null)).toBe(false)
  })
})

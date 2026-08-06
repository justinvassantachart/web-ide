import { describe, expect, it } from 'vitest'

import { normalizeTerminalNewlines } from '../../src/components/terminal/normalize-terminal-text'

describe('terminal text formatting', () => {
  it('converts LF without doubling an existing CRLF', () => {
    expect(normalizeTerminalNewlines('one\ntwo\r\nthree')).toBe(
      'one\r\ntwo\r\nthree',
    )
  })

  it('leaves text without line endings unchanged', () => {
    expect(normalizeTerminalNewlines('\x1b[34mstatus\x1b[0m')).toBe(
      '\x1b[34mstatus\x1b[0m',
    )
  })
})

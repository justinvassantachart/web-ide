import { describe, expect, it } from 'vitest'
import { createTestReportDecoder, TEST_REPORT_PREFIX } from '../../src/testing/testing-protocol'
const nonce = '0123456789abcdef'
const marker = TEST_REPORT_PREFIX + nonce + ':'
const decoder = () => createTestReportDecoder({ nonce, runId: 'run', toTestId: key => 'id:' + key })

describe('shared bounded test report framing', () => {
  it('handles every chunk boundary, preserves ordinary bytes, and assigns contiguous sequences', () => {
    const wire = 'ordinary\r\n' + marker + '{"type":"run_started"}\r\n' + marker + '{"type":"run_finished"}'
    for (let i = 0; i <= wire.length; i++) {
      const parser = decoder()
      const frames = [parser.push('stdout', wire.slice(0, i)), parser.push('stdout', wire.slice(i)), parser.finish()]
      expect(frames.map(frame => frame.output).join('')).toBe('ordinary\r\n')
      expect(frames.flatMap(frame => frame.messages).map(message => message.sequence)).toEqual([0, 1])
    }
  })
  it('leaves wrong nonces, malformed JSON and unknown events visible', () => {
    const wire = TEST_REPORT_PREFIX + 'abcdef0123456789:{"type":"run_started"}\n' + marker + '{bad}\n' + marker + '{"type":"future"}\n'
    expect(decoder().push('stdout', wire)).toEqual({ output: wire, messages: [] })
    expect(decoder().push('stderr', marker + '{}')).toEqual({ output: marker + '{}', messages: [] })
  })
  it('bounds UTF8 bytes for unterminated and complete lines and recovers after them', () => {
    const parser = decoder()
    const oversized = marker + '😀'.repeat(20000)
    expect(parser.push('stdout', oversized).output).toBe(oversized)
    const frame = parser.push('stdout', '\n' + marker + '{"type":"run_started"}\n')
    expect(frame.output).toBe('\n'); expect(frame.messages).toHaveLength(1)
    expect(decoder().push('stdout', oversized + '\n').output).toBe(oversized + '\n')
  })
  it('translates descriptor metadata, strips protected clickable locations, rejects ID ambiguity', () => {
    const parser = decoder()
    const frame = parser.push('stdout', marker + JSON.stringify({ type: 'test_discovered', key: 'a', name: 'A', origin: 'provided', group: 'teacher.py', path: '/sysroot/teacher.py', line: 4 }) + '\n')
    expect(frame.messages[0]?.event).toEqual({ type: 'test_discovered', descriptor: { id: 'id:a', name: 'A', origin: 'provided', group: 'teacher.py' } })
    expect(() => parser.push('stdout', marker + '{"type":"run_started","unexpected":1}\n')).toThrow('Unknown')
    const colliding = createTestReportDecoder({ nonce, runId: 'run', toTestId: () => 'same' })
    colliding.push('stdout', marker + '{"type":"test_started","key":"one"}\n')
    expect(() => colliding.push('stdout', marker + '{"type":"test_started","key":"two"}\n')).toThrow('collision')
  })
})

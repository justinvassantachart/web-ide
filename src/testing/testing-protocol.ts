import type { TestDescriptorV2, TestReportDecoderV2, TestReportEventPayloadV2, TestReportEventV2 } from '@/web-ide/contracts/testing'
import { normalizeWorkspacePathV1 } from '@/web-ide/public/canonical-contract'

export const TEST_REPORT_MAX_FRAME_BYTES = 64 * 1024
export const TEST_REPORT_PREFIX = '__WEBIDE_TEST_V2__:'
const encoder = new TextEncoder()
const terminalTypes = new Set(['test_passed', 'test_failed', 'test_skipped', 'test_errored'])
const runTypes = new Set(['run_started', 'run_finished', 'run_terminated', 'discovery_finished'])

export interface TestReportDecoderOptions {
  nonce: string
  runId: string
  toTestId(key: string): string
}

/** Framing/translation only. Controller owns lifecycle, selection and execution outcomes. */
export function createTestReportDecoder({ nonce, runId, toTestId }: TestReportDecoderOptions): TestReportDecoderV2 {
  if (!/^[a-f0-9]{16,128}$/.test(nonce)) throw new TypeError('Invalid test report nonce')
  const marker = `${TEST_REPORT_PREFIX}${nonce}:`
  const ids = new Map<string, string>()
  let buffer = '', pendingEmptyLine = '', passthrough = false, sequence = 0
  const identify = (key: unknown): string => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4096) throw new TypeError('Invalid test key')
    const id = toTestId(key)
    if (!/^[A-Za-z0-9._:/@+-]{1,512}$/.test(id)) throw new TypeError('Invalid translated test ID')
    if (ids.has(id) && ids.get(id) !== key) throw new TypeError('Test ID collision')
    if (!ids.has(id) && ids.size >= 10_000) throw new TypeError('Too many tests in report')
    ids.set(id, key)
    return id
  }
  const translate = (value: unknown): TestReportEventPayloadV2 | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const event = value as Record<string, unknown>
    if (typeof event.type !== 'string') return undefined
    if (!runTypes.has(event.type) && !terminalTypes.has(event.type) && !['test_discovered', 'test_started', 'output'].includes(event.type)) return undefined
    const allowed = event.type === 'test_discovered'
      ? ['type', 'key', 'name', 'origin', 'kind', 'group', 'path', 'line', 'column']
      : terminalTypes.has(event.type)
        ? ['type', 'key', 'durationMs', 'message', 'details', 'expected', 'actual', 'path', 'line', 'column']
        : event.type === 'test_started'
          ? ['type', 'key']
          : event.type === 'output'
            ? ['type', 'key', 'message']
            : ['type', 'reason', 'message', 'durationMs']
    if (Object.keys(event).some(key => !allowed.includes(key))) throw new TypeError('Unknown test report field')
    const location: { path?: string; line?: number; column?: number } = {}
    if (event.path !== undefined) {
      if (typeof event.path !== 'string') throw new TypeError('Invalid report path')
      if (event.path.startsWith('/workspace/')) {
        location.path = normalizeWorkspacePathV1(event.path)
        for (const key of ['line', 'column'] as const) {
          if (event[key] !== undefined) {
            if (!Number.isSafeInteger(event[key]) || (event[key] as number) < 1) throw new TypeError('Invalid report location')
            location[key] = event[key] as number
          }
        }
      } else if (!event.path.startsWith('/sysroot/')) throw new TypeError('Unknown test source scope')
    }
    if (event.type === 'test_discovered') {
      if (typeof event.name !== 'string' || !event.name || [...event.name].length > 1024) throw new TypeError('Invalid test name')
      if (!['student', 'provided', 'external'].includes(String(event.origin))) throw new TypeError('Invalid test origin')
      if (event.group !== undefined && (typeof event.group !== 'string' || [...event.group].length > 512)) throw new TypeError('Invalid test group')
      if (event.kind !== undefined && event.kind !== 'fixture') throw new TypeError('Invalid test descriptor kind')
      const descriptor: TestDescriptorV2 = {
        id: identify(event.key), name: event.name, origin: event.origin as TestDescriptorV2['origin'],
        ...(event.kind === 'fixture' ? { kind: 'fixture' as const } : {}),
        ...(event.group !== undefined ? { group: event.group as string } : {}),
        ...(location.path && location.line ? { location: { path: location.path, line: location.line, ...(location.column ? { column: location.column } : {}) } } : {}),
      }
      return { type: 'test_discovered', descriptor }
    }
    const result: Record<string, unknown> = { type: event.type }
    if (event.type === 'test_started' || terminalTypes.has(event.type) || event.key !== undefined) result.testId = identify(event.key)
    for (const field of ['durationMs', 'message', 'details', 'reason', 'expected', 'actual']) {
      if (event[field] !== undefined) result[field] = event[field]
    }
    Object.assign(result, location)
    return result as unknown as TestReportEventPayloadV2
  }
  const parseLine = (line: string, newline: boolean): { output: string; messages: TestReportEventV2[] } => {
    const original = line + (newline ? '\n' : '')
    if (!line.startsWith(marker) || encoder.encode(line).length > TEST_REPORT_MAX_FRAME_BYTES) return { output: original, messages: [] }
    let parsed: unknown
    try { parsed = JSON.parse(line.slice(marker.length).replace(/\r$/, '')) } catch { return { output: original, messages: [] } }
    const event = translate(parsed)
    if (!event) return { output: original, messages: [] }
    return { output: '', messages: [{ apiVersion: 2, kind: 'report_event', runId, sequence: sequence++, event }] }
  }
  return {
    push(stream, chunk) {
      if (stream !== 'stdout') return { output: chunk, messages: [] }
      buffer += chunk
      let output = ''
      const messages: TestReportEventV2[] = []
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (passthrough) output += line + '\n'
        else if (line === '' || line === '\r') {
          output += pendingEmptyLine
          pendingEmptyLine = line + '\n'
        }
        else {
          const frame = parseLine(line, true)
          // Both runners establish a new line before a report. Consume only that
          // last empty separator, retaining student blank lines and malformed frames.
          output += (frame.messages.length ? '' : pendingEmptyLine) + frame.output
          pendingEmptyLine = ''
          messages.push(...frame.messages)
        }
        passthrough = false
      }
      if (encoder.encode(buffer).length > TEST_REPORT_MAX_FRAME_BYTES || passthrough ||
        (buffer !== '\r' && !marker.startsWith(buffer) && !buffer.startsWith(marker))) {
        // Keep a final surrogate half for a Unicode character split across chunks.
        const tail = buffer.length && /[\uD800-\uDBFF]/.test(buffer.at(-1)!) ? 1 : 0
        output += pendingEmptyLine + buffer.slice(0, buffer.length - tail)
        pendingEmptyLine = ''
        buffer = buffer.slice(buffer.length - tail)
        passthrough = true
      }
      return { output, messages }
    },
    finish() {
      const line = buffer
      buffer = ''
      const wasPassthrough = passthrough
      passthrough = false
      const frame = wasPassthrough ? { output: line, messages: [] } : parseLine(line, false)
      const output = (frame.messages.length ? '' : pendingEmptyLine) + frame.output
      pendingEmptyLine = ''
      return { output, messages: frame.messages }
    },
  }
}

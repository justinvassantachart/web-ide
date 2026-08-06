import type { TestEvent, TestOutputFrame } from '@/web-ide/contracts/testing'

// Protocol frames are deliberately small. Once an unterminated line exceeds
// this limit, treat the entire line as user output and stream it through until
// its newline arrives. This keeps a program that prints without newlines from
// growing parser state for the lifetime of the run.
export const TEST_PROTOCOL_MAX_LINE_LENGTH = 64 * 1024

type ParsePayload = (payload: string) => readonly TestEvent[] | undefined

function outputLine(line: string, terminated: boolean): string {
  if (!terminated) return line
  return `${line.endsWith('\r') ? line.slice(0, -1) : line}\r\n`
}

/** Shared framing only; providers still own their protocol vocabulary. */
export class BoundedLineProtocolParser {
  private buffer = ''
  private passthroughLine = false
  private readonly marker: string
  private readonly parsePayload: ParsePayload

  constructor(
    marker: string,
    parsePayload: ParsePayload,
  ) {
    this.marker = marker
    this.parsePayload = parsePayload
  }

  push(chunk: string): TestOutputFrame {
    this.buffer += chunk
    let output = ''
    const events: TestEvent[] = []

    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline !== -1) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)

        if (this.passthroughLine || line.length > TEST_PROTOCOL_MAX_LINE_LENGTH) {
          output += outputLine(line, true)
        } else {
          const protocolLine = line.endsWith('\r') ? line.slice(0, -1) : line
          const frame = this.parseLine(protocolLine, true)
          output += frame.output
          events.push(...frame.events)
        }
        this.passthroughLine = false
        continue
      }

      if (this.buffer.length > TEST_PROTOCOL_MAX_LINE_LENGTH) {
        // Retain a final carriage return in case the next chunk begins with
        // `\n`; this avoids turning a split CRLF into `\r\r\n`.
        const retainedLength = this.buffer.endsWith('\r') ? 1 : 0
        const flushUntil = this.buffer.length - retainedLength
        output += this.buffer.slice(0, flushUntil)
        this.buffer = this.buffer.slice(flushUntil)
        this.passthroughLine = true
      }
      break
    }

    return { output, events }
  }

  finish(): TestOutputFrame {
    if (this.buffer.length === 0) {
      this.passthroughLine = false
      return { output: '', events: [] }
    }

    const line = this.buffer
    this.buffer = ''
    if (this.passthroughLine || line.length > TEST_PROTOCOL_MAX_LINE_LENGTH) {
      this.passthroughLine = false
      return { output: line, events: [] }
    }
    return this.parseLine(line, false)
  }

  private parseLine(line: string, terminated: boolean): TestOutputFrame {
    if (!line.startsWith(this.marker)) {
      return { output: outputLine(line, terminated), events: [] }
    }

    const parsed = this.parsePayload(line.slice(this.marker.length))
    if (!parsed) {
      // Marker-like text belongs to the user unless it is a complete frame in
      // this provider's vocabulary. Unknown or malformed lines stay visible.
      return { output: outputLine(line, terminated), events: [] }
    }
    return { output: '', events: parsed }
  }
}

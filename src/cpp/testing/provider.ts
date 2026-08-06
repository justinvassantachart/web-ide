import type {
  TestEvent,
  TestOutputFrame,
  TestOutputParser,
  TestOutputStream,
  TestProvider,
} from '@/web-ide/contracts/testing'
import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import { BoundedLineProtocolParser } from '@/testing/bounded-line-protocol-parser'
import {
  NOVA_TEST_DELIMITER,
  NOVA_TEST_HEADER,
  NOVA_TEST_HEADER_PATH,
  NOVA_TEST_IMPL,
  NOVA_TEST_IMPL_PATH,
  NOVA_TEST_MARKER,
  NOVA_TEST_RUNNER,
  NOVA_TEST_RUNNER_PATH,
} from './resources'

export {
  NOVA_TEST_DELIMITER,
  NOVA_TEST_HEADER_PATH,
  NOVA_TEST_IMPL_PATH,
  NOVA_TEST_MARKER,
  NOVA_TEST_RUNNER_PATH,
} from './resources'

function unescapeField(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\' && index + 1 < value.length) {
      const next = value[index + 1]
      if (next === '\\') {
        output += '\\'
        index += 1
        continue
      }
      if (next === 'n') {
        output += '\n'
        index += 1
        continue
      }
      if (next === 'r') {
        output += '\r'
        index += 1
        continue
      }
      if (next === 'p') {
        output += '|'
        index += 1
        continue
      }
    }
    output += character
  }
  return output
}

interface SourceToken {
  value: string
  start: number
  end: number
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character)
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character)
}

function quotedLiteralEnd(source: string, start: number, quote: '"' | "'"): number {
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

function rawStringLiteralEnd(source: string, start: number): number | undefined {
  const prefixes = ['u8R"', 'uR"', 'UR"', 'LR"', 'R"'] as const
  const prefix = prefixes.find((candidate) => source.startsWith(candidate, start))
  if (!prefix) return undefined

  const delimiterStart = start + prefix.length
  const openingParen = source.indexOf('(', delimiterStart)
  if (openingParen === -1 || openingParen - delimiterStart > 16) return source.length

  const delimiter = source.slice(delimiterStart, openingParen)
  if (/[\s()\\]/.test(delimiter)) return source.length
  const terminator = `)${delimiter}"`
  const close = source.indexOf(terminator, openingParen + 1)
  return close === -1 ? source.length : close + terminator.length
}

function logicalLineEnd(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const newline = source.indexOf('\n', index)
    if (newline === -1) return source.length

    let beforeNewline = newline - 1
    if (beforeNewline >= start && source[beforeNewline] === '\r') beforeNewline -= 1
    if (beforeNewline < start || source[beforeNewline] !== '\\') return newline + 1
    index = newline + 1
  }
  return source.length
}

function isAtLogicalLineStart(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  return /^[\t\v\f ]*$/.test(source.slice(lineStart, index))
}

function tokenizeCpp(source: string): SourceToken[] {
  const tokens: SourceToken[] = []
  let index = 0

  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }

    if (source.startsWith('//', index)) {
      index = logicalLineEnd(source, index + 2)
      continue
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 2
      continue
    }
    if (character === '#' && isAtLogicalLineStart(source, index)) {
      index = logicalLineEnd(source, index + 1)
      continue
    }

    const rawStringEnd = rawStringLiteralEnd(source, index)
    if (rawStringEnd !== undefined) {
      index = rawStringEnd
      continue
    }
    if (character === '"' || character === "'") {
      index = quotedLiteralEnd(source, index, character)
      continue
    }

    if (isIdentifierStart(character)) {
      const start = index
      index += 1
      while (index < source.length && isIdentifierPart(source[index])) index += 1
      tokens.push({ value: source.slice(start, index), start, end: index })
      continue
    }

    tokens.push({ value: character, start: index, end: index + 1 })
    index += 1
  }

  return tokens
}

function hideUserMain(source: string): string {
  const tokens = tokenizeCpp(source)
  const mainTokens = tokens.filter((token, index) => (
    token.value === 'main'
    && (tokens[index - 1]?.value === 'int' || tokens[index - 1]?.value === 'void')
    && tokens[index + 1]?.value === '('
  ))
  if (mainTokens.length === 0) return source

  let renamed = source
  for (const token of mainTokens.reverse()) {
    renamed = `${renamed.slice(0, token.start)}nova_hidden_main${renamed.slice(token.end)}`
  }

  // C++ permits falling off main(), while the renamed ordinary function must
  // return explicitly. Preserve the user's valid source and diagnostic lines.
  return [
    '#pragma clang diagnostic push',
    '#pragma clang diagnostic ignored "-Wreturn-type"',
    '#line 1',
    renamed,
    '#pragma clang diagnostic pop',
  ].join('\n')
}

class NovaCppOutputParser implements TestOutputParser {
  private nextTestId = 1
  private currentTestId: string | undefined
  private readonly lines = new BoundedLineProtocolParser(
    NOVA_TEST_MARKER,
    (payload) => {
      const event = this.parsePayload(payload)
      return event ? [event] : undefined
    },
  )

  push(stream: TestOutputStream, chunk: string): TestOutputFrame {
    if (stream !== 'stdout') return { output: chunk, events: [] }
    return this.lines.push(chunk)
  }

  finish(): TestOutputFrame {
    return this.lines.finish()
  }

  private parsePayload(payload: string): TestEvent | undefined {
    const fields = payload.split(NOVA_TEST_DELIMITER)
    const kind = fields[0]

    if (kind === 'SUITE_START' && fields.length === 2) {
      if (!/^\d+$/.test(fields[1] ?? '')) return undefined
      const total = Number.parseInt(fields[1], 10)
      if (!Number.isSafeInteger(total)) return undefined
      this.nextTestId = 1
      this.currentTestId = undefined
      return { type: 'run-start', total }
    }

    if (kind === 'TEST_START' && fields.length === 2) {
      const testId = `nova-cpp:${this.nextTestId}`
      this.nextTestId += 1
      this.currentTestId = testId
      return {
        type: 'test-start',
        testId,
        name: unescapeField(fields[1] ?? ''),
      }
    }

    if (kind === 'ASSERT' && fields.length === 8 && this.currentTestId) {
      if (fields[3] !== 'PASS' && fields[3] !== 'FAIL') return undefined
      if (!/^\d+$/.test(fields[2] ?? '')) return undefined
      const line = Number.parseInt(fields[2] ?? '', 10)
      if (!Number.isSafeInteger(line) || line <= 0) return undefined
      return {
        type: 'test-assertion',
        testId: this.currentTestId,
        assertion: {
          status: fields[3] === 'PASS' ? 'pass' : 'fail',
          message: fields[3] === 'PASS' ? undefined : 'EXPECT_EQUALS failed',
          location: {
            file: fields[1] ?? '',
            ...(Number.isFinite(line) && line > 0 ? { line } : {}),
          },
          actual: {
            expression: unescapeField(fields[4] ?? ''),
            value: unescapeField(fields[6] ?? ''),
          },
          expected: {
            expression: unescapeField(fields[5] ?? ''),
            value: unescapeField(fields[7] ?? ''),
          },
        },
      }
    }

    if (kind === 'TEST_END' && fields.length === 2 && this.currentTestId) {
      if (fields[1] !== 'PASS' && fields[1] !== 'FAIL') return undefined
      const testId = this.currentTestId
      this.currentTestId = undefined
      return {
        type: 'test-end',
        testId,
        status: fields[1] === 'PASS' ? 'pass' : 'fail',
      }
    }

    if (kind === 'SUITE_END' && fields.length === 2 && fields[1] === '') {
      this.currentTestId = undefined
      return { type: 'run-end' }
    }

    return undefined
  }
}

export function createNovaCppOutputParser(): TestOutputParser {
  return new NovaCppOutputParser()
}

const NOVA_TEST_HEADER_REFERENCE = /(?:^|[\s/<"'])nova_test\.h(?=$|[\s>"'])/m

function usesNovaTestSupport(files: Readonly<Record<string, string>>): boolean {
  return Object.values(files).some((contents) => (
    NOVA_TEST_HEADER_REFERENCE.test(contents)
  ))
}

export const cppTestProvider: TestProvider = {
  id: 'web-ide.testing.cpp',
  label: 'C++ Tests',
  languageIds: ['c', 'cpp'],
  editorSupportFiles: Object.freeze({
    [NOVA_TEST_HEADER_PATH]: NOVA_TEST_HEADER,
  }),
  help: {
    message: 'Declare tests with',
    examples: [
      { code: 'STUDENT_TEST("name") { ... }' },
      { prefix: 'and assert with', code: 'EXPECT_EQUALS(actual, expected)' },
    ],
  },
  prepare({ files, mode, executeTests }) {
    const preparedFiles = Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        path,
        executeTests && path.endsWith('.cpp') ? hideUserMain(contents) : contents,
      ]),
    )

    // These copies exist only in the execution plan: they never enter the VFS,
    // OPFS persistence, file explorer, or host workspace snapshot. Ordinary
    // Run/Debug must not compile the test implementation unless the workspace
    // references its public header: every extra .cpp file is a complete,
    // sequential compiler invocation in the browser runtime.
    if (executeTests || usesNovaTestSupport(preparedFiles)) {
      preparedFiles[NOVA_TEST_HEADER_PATH] = NOVA_TEST_HEADER
      preparedFiles[NOVA_TEST_IMPL_PATH] = NOVA_TEST_IMPL
    }

    if (!executeTests) {
      return { execution: { files: preparedFiles, mode } }
    }

    preparedFiles[NOVA_TEST_RUNNER_PATH] = NOVA_TEST_RUNNER
    return {
      execution: {
        files: preparedFiles,
        mode: 'run',
        entrypoint: NOVA_TEST_RUNNER_PATH,
      },
      parser: createNovaCppOutputParser(),
    }
  },
}

export const cppTestingPlugin: IDEPlugin = {
  id: 'web-ide.testing.cpp',
  contributes: { testProviders: [cppTestProvider] },
}

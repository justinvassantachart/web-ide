import UNITTEST_RUNNER from './unittest_runner.py?raw'
import type {
  TestCaseStatus,
  TestDiagnostic,
  TestEvent,
  TestLocation,
  TestOutputFrame,
  TestOutputParser,
  TestOutputStream,
  TestProvider,
} from '@/web-ide/contracts/testing'
import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import { BoundedLineProtocolParser } from '@/testing/bounded-line-protocol-parser'

export const PYTHON_UNITTEST_RUNNER_PATH = '/workspace/__web_ide/unittest_runner.py'
export const PYTHON_USER_MAIN_PATH = '/workspace/__web_ide_user_main__.py'
export const PYTHON_UNITTEST_MARKER = '###WEB_IDE_UNITTEST###'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseLocation(value: unknown): TestLocation | undefined {
  if (!isObject(value) || typeof value.file !== 'string') return undefined
  if ('line' in value && typeof value.line !== 'number') return undefined
  if ('column' in value && typeof value.column !== 'number') return undefined
  return {
    file: value.file,
    ...(typeof value.line === 'number' ? { line: value.line } : {}),
    ...(typeof value.column === 'number' ? { column: value.column } : {}),
  }
}

function parseDiagnostic(value: unknown): TestDiagnostic | undefined {
  if (!isObject(value) || typeof value.message !== 'string') return undefined
  if ('details' in value && typeof value.details !== 'string') return undefined
  const location = parseLocation(value.location)
  if ('location' in value && !location) return undefined
  return {
    message: value.message,
    ...(typeof value.details === 'string' ? { details: value.details } : {}),
    ...(location ? { location } : {}),
  }
}

function parseStatus(value: unknown): Exclude<TestCaseStatus, 'running'> | undefined {
  return value === 'pass' || value === 'fail' || value === 'skip' || value === 'error'
    ? value
    : undefined
}

function parseEvent(value: unknown): TestEvent | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined

  if (value.type === 'run-start') {
    if ('total' in value) {
      if (
        typeof value.total !== 'number'
        || !Number.isSafeInteger(value.total)
        || value.total < 0
      ) return undefined
      return { type: 'run-start', total: value.total }
    }
    return { type: 'run-start' }
  }
  if (value.type === 'run-end') return { type: 'run-end' }

  if (
    value.type === 'test-start'
    && typeof value.testId === 'string'
    && typeof value.name === 'string'
  ) {
    const location = parseLocation(value.location)
    if ('location' in value && !location) return undefined
    return {
      type: 'test-start',
      testId: value.testId,
      name: value.name,
      ...(location ? { location } : {}),
    }
  }

  if (value.type === 'test-diagnostic' && typeof value.testId === 'string') {
    const diagnostic = parseDiagnostic(value.diagnostic)
    return diagnostic
      ? { type: 'test-diagnostic', testId: value.testId, diagnostic }
      : undefined
  }

  if (value.type === 'test-end' && typeof value.testId === 'string') {
    const status = parseStatus(value.status)
    if (!status) return undefined
    if (
      'durationMs' in value
      && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs))
    ) return undefined
    return {
      type: 'test-end',
      testId: value.testId,
      status,
      ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    }
  }

  return undefined
}

class PythonUnittestOutputParser implements TestOutputParser {
  private readonly lines = new BoundedLineProtocolParser(
    PYTHON_UNITTEST_MARKER,
    (payload) => {
      try {
        const event = parseEvent(JSON.parse(payload) as unknown)
        return event ? [event] : undefined
      } catch {
        return undefined
      }
    },
  )

  push(stream: TestOutputStream, chunk: string): TestOutputFrame {
    if (stream !== 'stdout') return { output: chunk, events: [] }
    return this.lines.push(chunk)
  }

  finish(): TestOutputFrame {
    return this.lines.finish()
  }
}

export function createPythonUnittestOutputParser(): TestOutputParser {
  return new PythonUnittestOutputParser()
}

export const pythonUnittestTestProvider: TestProvider = {
  id: 'web-ide.testing.python-unittest',
  label: 'Python unittest',
  languageIds: ['python'],
  help: {
    message: 'Create test*.py files with',
    examples: [{ code: 'unittest.TestCase' }],
  },
  prepare({ files, mode, executeTests }) {
    if (!executeTests) {
      return { execution: { files: { ...files }, mode } }
    }

    const preparedFiles = { ...files }
    const mainEntry = Object.entries(files).find(([path]) =>
      path === 'main.py' || path === '/main.py' || path === '/workspace/main.py',
    )
    if (mainEntry) {
      preparedFiles[PYTHON_USER_MAIN_PATH] = mainEntry[1]
      // The runtime owns /main.py as its fixed launcher. The runner preloads
      // this preserved copy as module `main`, so keeping the original path in
      // the execution plan would collide with the selected runner entrypoint.
      delete preparedFiles[mainEntry[0]]
    }
    preparedFiles[PYTHON_UNITTEST_RUNNER_PATH] = UNITTEST_RUNNER

    return {
      execution: {
        files: preparedFiles,
        mode: 'run',
        entrypoint: PYTHON_UNITTEST_RUNNER_PATH,
      },
      parser: createPythonUnittestOutputParser(),
    }
  },
}

export const pythonTestingPlugin: IDEPlugin = {
  id: 'web-ide.testing.python-unittest',
  contributes: { testProviders: [pythonUnittestTestProvider] },
}

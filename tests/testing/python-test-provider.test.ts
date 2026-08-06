import { describe, expect, it } from 'vitest'
import {
  createPythonUnittestOutputParser,
  PYTHON_UNITTEST_MARKER,
  PYTHON_UNITTEST_RUNNER_PATH,
  PYTHON_USER_MAIN_PATH,
  pythonUnittestTestProvider,
} from '../../src/python/testing/provider'
import type { TestEvent } from '../../src/web-ide/contracts/testing'

describe('Python unittest execution provider', () => {
  it('leaves ordinary Python executions untouched', async () => {
    const files = { '/workspace/main.py': 'print("hello")' }
    const prepared = await pythonUnittestTestProvider.prepare({
      files,
      mode: 'run',
      executeTests: false,
    })

    expect(prepared.execution).toEqual({ files, mode: 'run' })
    expect(prepared.execution.files).not.toBe(files)
    expect(prepared.parser).toBeUndefined()
  })

  it('creates an ephemeral unittest discovery entrypoint with no Karel behavior', async () => {
    const prepared = await pythonUnittestTestProvider.prepare({
      files: {
        '/workspace/main.py': 'def add(a, b): return a + b',
        '/workspace/test_main.py': 'import unittest',
      },
      mode: 'debug',
      executeTests: true,
    })

    expect(prepared.execution.mode).toBe('run')
    expect(PYTHON_UNITTEST_RUNNER_PATH).toBe('/workspace/__web_ide/unittest_runner.py')
    expect(prepared.execution.entrypoint).toBe(PYTHON_UNITTEST_RUNNER_PATH)
    const runner = prepared.execution.files[PYTHON_UNITTEST_RUNNER_PATH]
    expect(runner).toContain('unittest.defaultTestLoader.discover')
    expect(runner).toContain('ProtocolResult')
    expect(runner).toContain('sys.modules["main"]')
    expect(runner).toContain('USER_MAIN_SOURCE = "main.py"')
    expect(runner).toContain('if os.path.basename(filename) == USER_MAIN:')
    expect(runner).toMatch(
      /"details": self\._exc_info_to_string\(error, test\)\.replace\(\s*USER_MAIN,\s*USER_MAIN_SOURCE,\s*\)/,
    )
    expect(runner.toLowerCase()).not.toContain('karel')
    expect(prepared.execution.files[PYTHON_USER_MAIN_PATH]).toContain('def add')
    expect(prepared.execution.files).not.toHaveProperty('/workspace/main.py')
    expect(prepared.parser).toBeDefined()
  })
})

describe('Python unittest protocol translation', () => {
  it('translates framed JSON and filters it from normal output across chunks', () => {
    const parser = createPythonUnittestOutputParser()
    const events: TestEvent[] = []
    let output = ''
    const push = (chunk: string) => {
      const frame = parser.push('stdout', chunk)
      output += frame.output
      events.push(...frame.events)
    }

    push(`printed by test\n${PYTHON_UNITTEST_MARKER}{"type":"run-start","total":1}\n`)
    push(`${PYTHON_UNITTEST_MARKER}{"type":"test-st`)
    push('art","testId":"pkg.Sample.test_value","name":"test_value"}\r\n')
    push(
      `${PYTHON_UNITTEST_MARKER}{"type":"test-diagnostic","testId":"pkg.Sample.test_value","diagnostic":{"message":"3 != 4","details":"trace","location":{"file":"test_main.py","line":8}}}\n`,
    )
    push(
      `${PYTHON_UNITTEST_MARKER}{"type":"test-end","testId":"pkg.Sample.test_value","status":"fail","durationMs":2.5}\n`,
    )
    push(`${PYTHON_UNITTEST_MARKER}{"type":"run-end"}\n`)

    expect(output).toBe('printed by test\r\n')
    expect(events).toEqual([
      { type: 'run-start', total: 1 },
      {
        type: 'test-start',
        testId: 'pkg.Sample.test_value',
        name: 'test_value',
      },
      {
        type: 'test-diagnostic',
        testId: 'pkg.Sample.test_value',
        diagnostic: {
          message: '3 != 4',
          details: 'trace',
          location: { file: 'test_main.py', line: 8 },
        },
      },
      {
        type: 'test-end',
        testId: 'pkg.Sample.test_value',
        status: 'fail',
        durationMs: 2.5,
      },
      { type: 'run-end' },
    ])
  })

  it('passes stderr and malformed or marker-like user output through', () => {
    const parser = createPythonUnittestOutputParser()
    expect(parser.push('stderr', 'traceback')).toEqual({
      output: 'traceback',
      events: [],
    })
    const lines = [
      `${PYTHON_UNITTEST_MARKER}{bad json}`,
      `${PYTHON_UNITTEST_MARKER}{"type":"unknown"}`,
      `before${PYTHON_UNITTEST_MARKER}{"type":"run-end"}`,
    ]
    expect(parser.push('stdout', `${lines.join('\n')}\n`)).toEqual({
      output: `${lines.join('\r\n')}\r\n`,
      events: [],
    })
  })

  it('bounds an oversized unterminated marker-like stdout line', () => {
    const parser = createPythonUnittestOutputParser()
    const oversized = `${PYTHON_UNITTEST_MARKER}${'x'.repeat(70_000)}`

    expect(parser.push('stdout', oversized)).toEqual({
      output: oversized,
      events: [],
    })
    expect(parser.push(
      'stdout',
      `\n${PYTHON_UNITTEST_MARKER}{"type":"run-start","total":0}\n`,
    )).toEqual({
      output: '\r\n',
      events: [{ type: 'run-start', total: 0 }],
    })
    expect(parser.finish()).toEqual({ output: '', events: [] })
  })
})

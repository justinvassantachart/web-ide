import { describe, expect, it } from 'vitest'
import {
  cppTestProvider,
  createNovaCppOutputParser,
  NOVA_TEST_HEADER_PATH,
  NOVA_TEST_IMPL_PATH,
  NOVA_TEST_MARKER,
  NOVA_TEST_RUNNER_PATH,
} from '../../src/cpp/testing/provider'
import type { TestEvent } from '../../src/web-ide/contracts/testing'

describe('C++ test execution provider', () => {
  it('exposes only editor declarations for provider-neutral language tooling', () => {
    expect(cppTestProvider.editorSupportFiles).toEqual({
      [NOVA_TEST_HEADER_PATH]: expect.stringContaining('#define STUDENT_TEST'),
    })
    expect(cppTestProvider.editorSupportFiles).not.toHaveProperty(
      NOVA_TEST_IMPL_PATH,
    )
  })

  it('adds compatibility support ephemerally without changing ordinary sources', async () => {
    const files = {
      '/workspace/main.cpp': 'int main() { return 0; }',
      '/workspace/tests.cpp': '#include "nova_test.h"\nSTUDENT_TEST("works") {}',
    }

    const prepared = await cppTestProvider.prepare({
      files,
      mode: 'debug',
      executeTests: false,
    })

    expect(prepared.execution).toMatchObject({ mode: 'debug' })
    expect(prepared.execution.files['/workspace/main.cpp']).toBe(files['/workspace/main.cpp'])
    expect(prepared.execution.files[NOVA_TEST_HEADER_PATH]).toContain('#define STUDENT_TEST')
    expect(prepared.execution.files[NOVA_TEST_IMPL_PATH]).toContain('current_failed()')
    expect(prepared.execution.files).not.toHaveProperty(NOVA_TEST_RUNNER_PATH)
    expect(prepared.parser).toBeUndefined()
    expect(files).toEqual({
      '/workspace/main.cpp': 'int main() { return 0; }',
      '/workspace/tests.cpp': '#include "nova_test.h"\nSTUDENT_TEST("works") {}',
    })
  })

  it.each(['run', 'debug'] as const)(
    'does not compile test support for an ordinary %s',
    async (mode) => {
      const files = {
        '/workspace/main.cpp': '#include <iostream>\nint main() { return 0; }',
        '/workspace/helper.cpp': 'int helper() { return 1; }',
        '/workspace/unrelated.cpp': '#include "my_nova_test.h"',
      }

      const prepared = await cppTestProvider.prepare({
        files,
        mode,
        executeTests: false,
      })

      expect(prepared.execution.files).toEqual(files)
      expect(prepared.execution.files).not.toHaveProperty(NOVA_TEST_HEADER_PATH)
      expect(prepared.execution.files).not.toHaveProperty(NOVA_TEST_IMPL_PATH)
      expect(prepared.execution.files).not.toHaveProperty(NOVA_TEST_RUNNER_PATH)
    },
  )

  it.each([
    ['path include', '#include "./nova_test.h"'],
    ['comment-separated include', '#include /* compatibility */ "nova_test.h"'],
    ['macro include', '#define TEST_HEADER "nova_test.h"\n#include TEST_HEADER'],
  ])('preserves support for a %s', async (_name, source) => {
    const prepared = await cppTestProvider.prepare({
      files: { '/workspace/tests.cpp': source },
      mode: 'debug',
      executeTests: false,
    })

    expect(prepared.execution.files).toHaveProperty(NOVA_TEST_HEADER_PATH)
    expect(prepared.execution.files).toHaveProperty(NOVA_TEST_IMPL_PATH)
  })

  it('owns the hidden-main transform, runner entrypoint, and per-run parser', async () => {
    const prepared = await cppTestProvider.prepare({
      files: {
        '/workspace/main.cpp': 'int main() {\n}',
        '/workspace/helper.cpp': 'void main() {}',
        '/workspace/notes.txt': 'int main() stays text',
      },
      mode: 'debug',
      executeTests: true,
    })

    expect(prepared.execution.mode).toBe('run')
    expect(prepared.execution.entrypoint).toBe(NOVA_TEST_RUNNER_PATH)
    expect(prepared.execution.files[NOVA_TEST_RUNNER_PATH]).toContain('::nova_test::run_all()')
    expect(prepared.execution.files['/workspace/main.cpp']).toBe([
      '#pragma clang diagnostic push',
      '#pragma clang diagnostic ignored "-Wreturn-type"',
      '#line 1',
      'int nova_hidden_main() {',
      '}',
      '#pragma clang diagnostic pop',
    ].join('\n'))
    expect(prepared.execution.files['/workspace/helper.cpp']).toContain(
      'void nova_hidden_main()',
    )
    expect(prepared.execution.files['/workspace/notes.txt']).toBe('int main() stays text')
    expect(prepared.parser).toBeDefined()

    const second = await cppTestProvider.prepare({
      files: {},
      mode: 'run',
      executeTests: true,
    })
    expect(second.parser).not.toBe(prepared.parser)
  })

  it('renames only C++ main tokens outside comments, literals, and directives', async () => {
    const source = String.raw`// int main() { return 1; }
// void main() \
int main() { still part of the line comment }
/* void main() { return; } */
const char* normal = "int main() { not code; }";
const char* escaped = "escaped quote: \" int main()";
const char quote = '\'';
const char* raw = R"tag(
int main() { return 2; }
)tag";
const char* encoded_raw = u8R"x(void main() {})x";
#define FAKE_MAIN int main()
int /* comments may separate tokens */ main() {
  return 0;
}`

    const prepared = await cppTestProvider.prepare({
      files: { '/workspace/main.cpp': source },
      mode: 'run',
      executeTests: true,
    })
    const transformed = prepared.execution.files['/workspace/main.cpp']
    const bodyStart = transformed.indexOf('#line 1\n') + '#line 1\n'.length
    const bodyEnd = transformed.lastIndexOf('\n#pragma clang diagnostic pop')
    const body = transformed.slice(bodyStart, bodyEnd)

    expect(body).toContain('// int main() { return 1; }')
    expect(body).toContain('int main() { still part of the line comment }')
    expect(body).toContain('/* void main() { return; } */')
    expect(body).toContain('"int main() { not code; }"')
    expect(body).toContain('"escaped quote: \\" int main()"')
    expect(body).toContain('R"tag(\nint main() { return 2; }\n)tag"')
    expect(body).toContain('u8R"x(void main() {})x"')
    expect(body).toContain('#define FAKE_MAIN int main()')
    expect(body).toContain('int /* comments may separate tokens */ nova_hidden_main()')
    expect(body.match(/nova_hidden_main/g)).toHaveLength(1)

    const originalMainLine = source
      .slice(0, source.lastIndexOf('main() {\n  return 0;'))
      .split('\n').length
    const transformedMainLine = body
      .slice(0, body.indexOf('nova_hidden_main'))
      .split('\n').length
    expect(transformedMainLine).toBe(originalMainLine)
  })
})

describe('Nova C++ compatibility protocol translation', () => {
  it('handles chunk boundaries, preserves user stdout, and emits structured events', () => {
    const parser = createNovaCppOutputParser()
    const events: TestEvent[] = []
    let output = ''
    const push = (chunk: string) => {
      const frame = parser.push('stdout', chunk)
      output += frame.output
      events.push(...frame.events)
    }

    push('student output\n###NOVA_TEST###|~|SU')
    push('ITE_START|~|1\r\n')
    push('###NOVA_TEST###|~|TEST_START|~|value\\pwith\\nnewline\n')
    const markerLikeUserOutput =
      'prefix###NOVA_TEST###|~|ASSERT|~|tests.cpp|~|12|~|FAIL|~|ignored|~|ignored|~|0|~|0'
    push(`${markerLikeUserOutput}\n`)
    push(
      '###NOVA_TEST###|~|ASSERT|~|tests.cpp|~|12|~|FAIL|~|actual\\pvalue|~|expected|~|3|~|4\n',
    )
    push('###NOVA_TEST###|~|TEST_END|~|FAIL\n')
    push('###NOVA_TEST###|~|SUITE_END|~|\n')
    output += parser.push('stderr', 'runtime stderr').output

    expect(output).toBe(`student output\r\n${markerLikeUserOutput}\r\nruntime stderr`)
    expect(events).toEqual([
      { type: 'run-start', total: 1 },
      {
        type: 'test-start',
        testId: 'nova-cpp:1',
        name: 'value|with\nnewline',
      },
      {
        type: 'test-assertion',
        testId: 'nova-cpp:1',
        assertion: {
          status: 'fail',
          message: 'EXPECT_EQUALS failed',
          location: { file: 'tests.cpp', line: 12 },
          actual: { expression: 'actual|value', value: '3' },
          expected: { expression: 'expected', value: '4' },
        },
      },
      { type: 'test-end', testId: 'nova-cpp:1', status: 'fail' },
      { type: 'run-end' },
    ])
  })

  it('flushes a trailing non-protocol fragment', () => {
    const parser = createNovaCppOutputParser()
    expect(parser.push('stdout', 'partial').output).toBe('')
    expect(parser.finish()).toEqual({ output: 'partial', events: [] })
    expect(parser.finish()).toEqual({ output: '', events: [] })
  })

  it('passes embedded, malformed, and unknown marker-like lines through', () => {
    const parser = createNovaCppOutputParser()
    const lines = [
      `before${NOVA_TEST_MARKER}SUITE_START|~|1`,
      `${NOVA_TEST_MARKER}SUITE_START|~|not-a-number`,
      `${NOVA_TEST_MARKER}UNKNOWN|~|value`,
    ]

    expect(parser.push('stdout', `${lines.join('\n')}\n`)).toEqual({
      output: `${lines.join('\r\n')}\r\n`,
      events: [],
    })
  })

  it('bounds an oversized unterminated marker-like stdout line', () => {
    const parser = createNovaCppOutputParser()
    const oversized = `${NOVA_TEST_MARKER}${'x'.repeat(70_000)}`

    expect(parser.push('stdout', oversized)).toEqual({
      output: oversized,
      events: [],
    })
    expect(parser.push(
      'stdout',
      `\n${NOVA_TEST_MARKER}SUITE_START|~|0\n`,
    )).toEqual({
      output: '\r\n',
      events: [{ type: 'run-start', total: 0 }],
    })
    expect(parser.finish()).toEqual({ output: '', events: [] })
  })
})

import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cppTestProvider, CPP_TEST_HEADER_PATH, CPP_TEST_IMPL_PATH, CPP_TEST_RUNNER_PATH, prepareCppTestingSupport, validateCppTestSupportFiles } from '../../src/cpp/testing/provider'
import { workspaceDigestV1 } from '../../src/web-ide/public/canonical-contract'
import type { TestReportEventPayloadV2 } from '../../src/web-ide/contracts/testing'

async function native(files: Record<string,string>, select?: number[]) {
  const catalog = await cppTestProvider.discover({ files, workspaceDigest: await workspaceDigestV1(Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('/workspace/')))) })
  const prepared = await cppTestProvider.prepareRun({ apiVersion: 2, kind: 'run_request', mode: 'run', workspaceDigest: catalog.workspaceDigest, catalogDigest: catalog.catalogDigest, selection: select ? { kind: 'tests', testIds: select.map(i => catalog.tests[i].id) } : { kind: 'all' } }, { files, runId: 'a'.repeat(32) })
  const dir = mkdtempSync(join(tmpdir(), 'webide-cpp-tests-'))
  try {
    for (const [path, source] of Object.entries(prepared.execution.files)) { const target = join(dir, path.replace(/^\/(workspace|sysroot)\//, '')); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source) }
    const sources = Object.keys(prepared.execution.files).filter(path => path.endsWith('.cpp')).map(path => join(dir, path.replace(/^\/(workspace|sysroot)\//, '')))
    execFileSync('clang++', ['-std=c++17', '-I', dir, ...sources, '-o', join(dir, 'tests')], { encoding: 'utf8' })
    const process = spawnSync(join(dir, 'tests'), { encoding: 'utf8', timeout: 10_000 })
    const frame = prepared.decoder.push('stdout', process.stdout)
    return { catalog, prepared, events: [...frame.messages, ...prepared.decoder.finish().messages].map(message => message.event), output: frame.output, status: process.status }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const file = (source: string) => ({ '/workspace/main.cpp': `#include "webide_test.h"\n${source}` })
describe('C++ testing V2', () => {
  it('discovers comments/raw strings/multiline/same-line tests without executing', async () => {
    const source = '// STUDENT_TEST("fake") {}\nconst char* text = R"x(PROVIDED_TEST("fake"))x";\nSTUDENT_TEST(\n "real"\n) {} PROVIDED_TEST(R"(raw name)") {} STUDENT_TEST("last") {}'
    const catalog = await cppTestProvider.discover({ files: file(source), workspaceDigest: 'a'.repeat(64) })
    expect(catalog.tests.map(test => test.name)).toEqual(['real', 'raw name', 'last'])
    expect(new Set(catalog.tests.map(test => test.id)).size).toBe(3)
    expect(catalog.tests[1].origin).toBe('provided')
    expect(catalog.tests[0].location?.line).toBe(4)
  })
  it('owns support only in execution plans and rejects reserved path collisions/tampering', () => {
    const files = file('int main() {}')
    const prepared = prepareCppTestingSupport(files, false)
    expect(prepared[CPP_TEST_HEADER_PATH]).toContain('namespace webide_test')
    expect(prepared[CPP_TEST_IMPL_PATH]).toContain('Registrar::Registrar')
    expect(prepared[CPP_TEST_RUNNER_PATH]).toBeUndefined()
    expect(files).toEqual(file('int main() {}'))
    expect(() => prepareCppTestingSupport({ '/sysroot/webide_test.h': 'bad' }, true, 'x')).toThrow('Reserved')
    expect(() => validateCppTestSupportFiles({ ...prepared, [CPP_TEST_IMPL_PATH]: 'bad' })).toThrow('modified')
    expect(() => validateCppTestSupportFiles({ [CPP_TEST_HEADER_PATH]: prepared[CPP_TEST_HEADER_PATH] })).toThrow('Missing')
    validateCppTestSupportFiles(prepareCppTestingSupport(files, true, 'b'.repeat(32)))
  })
  it('supports exact/string/tolerant numeric checks and evaluates each operand once', async () => {
    const result = await native(file(`
#include <limits>
#include <stdexcept>
int main() { throw 3; }
STUDENT_TEST("values") {
 int calls = 0; EXPECT_EQUAL(++calls, 1); EXPECT_EQUAL(calls, 1);
 char a[] = "same", b[] = "same"; EXPECT_EQUAL(a,b);
 EXPECT_EQUAL(0.1 + 0.2, 0.3); EXPECT_EQUAL(1e8 + .01, 1e8);
 EXPECT_EQUAL(std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity());
 EXPECT_ERROR(throw std::runtime_error("yes")); EXPECT_NO_ERROR(int x = 1; (void)x);
}
PROVIDED_TEST("provided") { EXPECT(true); }`))
    expect(result.status).toBe(0)
    expect(result.events.filter(event => event.type === 'test_passed')).toHaveLength(2)
    expect(result.events.filter(event => event.type === 'test_discovered')).toHaveLength(2)
  })
  it('unwinds first failure, protects assertion exceptions, catches unexpected errors, and continues', async () => {
    const result = await native(file(`
#include <stdexcept>
#include <iostream>
STUDENT_TEST("fail first") { EXPECT_EQUAL(3,4); std::cout << "SHOULD_NOT_RUN"; }
STUDENT_TEST("nested") { EXPECT_ERROR(EXPECT(false)); }
STUDENT_TEST("unexpected") { throw std::runtime_error("boom"); }
STUDENT_TEST("after") { EXPECT(true); }`))
    expect(result.status).toBe(1)
    expect(result.output).not.toContain('SHOULD_NOT_RUN')
    expect(result.events.filter(event => event.type === 'test_failed')).toHaveLength(2)
    expect(result.events.filter(event => event.type === 'test_errored')).toHaveLength(1)
    expect(result.events.filter(event => event.type === 'test_passed')).toHaveLength(1)
    expect(result.events.find(event => event.type === 'test_failed' && event.actual?.value === '3')).toMatchObject({ path: '/workspace/main.cpp', line: 5, actual: { expression: '3', value: '3' }, expected: { expression: '4', value: '4' } })
  })
  it('selects stable same-line tests and replaces provisional inactive tests with runtime discovery', async () => {
    const files = file('#if 0\nSTUDENT_TEST("inactive") {}\n#endif\nSTUDENT_TEST("first") { EXPECT(false); } STUDENT_TEST("second") { EXPECT(true); }')
    const result = await native(files, [2])
    expect(result.catalog.tests).toHaveLength(3)
    expect(result.events.filter(event => event.type === 'test_discovered')).toHaveLength(2)
    expect(result.events.filter(event => event.type === 'test_passed')).toHaveLength(1)
    expect(result.status).toBe(0)
    const stale = await native(files, [0])
    expect(stale.events.at(-1)).toMatchObject({ type: 'run_terminated', reason: 'selection_stale' })
  })
  it('deduplicates header registrations, reports wrapper macros, and bounds difficult values', async () => {
    const result = await native({
      '/workspace/shared.h': '#include "webide_test.h"\nSTUDENT_TEST("header") {}',
      '/workspace/main.cpp': '#include "shared.h"\n#include <string>\n#define WRAPPED(name) STUDENT_TEST(name)\nWRAPPED("runtime only") { EXPECT_EQUAL(std::string(100000, \'x\'), "y"); }\nint main() {}',
      '/workspace/other.cpp': '#include "shared.h"',
    })
    expect(result.catalog.tests).toHaveLength(1)
    expect(result.events.filter(event => event.type === 'test_discovered')).toHaveLength(2)
    const failure = result.events.find(event => event.type === 'test_failed') as Extract<TestReportEventPayloadV2,{ type: 'test_passed' | 'test_failed' | 'test_skipped' | 'test_errored' }>
    expect(failure.actual?.value.length).toBeLessThan(2200)
  })
})

it('hides the global entrypoint while preserving class and namespace functions named main', async () => {
  const result = await native(file('struct Example { int main() { return 7; } };\nnamespace helper { int main() { return 8; } }\nextern "C" { int main() { return 9; } }\nSTUDENT_TEST("member main") { Example e; EXPECT_EQUAL(e.main(), 7); EXPECT_EQUAL(helper::main(), 8); }'))
  expect(result.status).toBe(0)
  expect(result.events.some(event => event.type === 'test_passed')).toBe(true)
})


it('preserves untouched runtime support bytes while preparing tests', () => {
  const files = { '/workspace/main.cpp': '#include "webide_test.h"\nSTUDENT_TEST("one") { EXPECT(true); }\nint main() { return 0; }', '/sysroot/vector.h': '// trusted source\ntemplate<class T> class Vector {};\n', '/sysroot/support.cpp': '#include "vector.h"\nvoid support() {}\n' }
  const prepared = prepareCppTestingSupport(files, true, 'a'.repeat(32))
  expect(prepared['/sysroot/vector.h']).toBe(files['/sysroot/vector.h'])
  expect(prepared['/sysroot/support.cpp']).toBe(files['/sysroot/support.cpp'])
  expect(prepared['/workspace/main.cpp']).toContain('webide_hidden_main')
})


it('handles numeric digit separators and bounds long names while executing in source order', async () => {
  const name = 'n'.repeat(1500)
  const result = await native(file(`const int limit = 10'000;\nSTUDENT_TEST("first") { EXPECT_EQUAL(limit, 10000); }\nSTUDENT_TEST("${name}") { EXPECT(true); }\nint main() { return 0; }`))
  expect(result.status).toBe(0)
  const discovered = result.events.filter(event => event.type === 'test_discovered')
  expect(discovered[0].descriptor.name).toBe('first')
  expect(discovered[1].descriptor.name.length).toBeLessThanOrEqual(1024)
})

it('does not link a runtime-only assertion helper to an invented workspace file', async () => {
  const result = await native({ ...file('#include "helper.h"\nSTUDENT_TEST("helper") { checkHelper(); }'), '/sysroot/helper.h': '#line 1 "/helper.h"\n#include "webide_test.h"\ninline void checkHelper() { EXPECT(false); }' })
  const failed = result.events.find(event => event.type === 'test_failed')
  expect(failed).not.toHaveProperty('path')
  expect(failed).toHaveProperty('details', 'Runtime resource /sysroot/helper.h:2')
})


it('does not reuse another test identity when an edit moves a declaration onto its old line', async () => {
  const before = await cppTestProvider.discover({ files: file('STUDENT_TEST("first") {}\nSTUDENT_TEST("second") {}'), workspaceDigest: 'a'.repeat(64) })
  const after = await cppTestProvider.discover({ files: file('// inserted\nSTUDENT_TEST("first") {}\nSTUDENT_TEST("second") {}'), workspaceDigest: 'b'.repeat(64) })
  expect(after.tests[0].id).not.toBe(before.tests[1].id)
})

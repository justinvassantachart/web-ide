import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverPythonTests, pythonTestKey, PYTHON_UNITTEST_RUNNER_PATH, PYTHON_USER_MAIN_PATH,
  pythonUnittestTestProvider,
} from '../../src/python/testing/provider'
import type { TestRunRequestV2, TestReportEventPayloadV2 } from '../../src/web-ide/contracts/testing'
import { TEST_REPORT_PREFIX } from '../../src/testing/testing-protocol'

const request = (ids?: string[]): TestRunRequestV2 => ({
  apiVersion: 2, kind: 'run_request', mode: 'run', workspaceDigest: 'a'.repeat(64), catalogDigest: 'b'.repeat(64),
  selection: ids === undefined ? { kind: 'all' } : { kind: 'tests', testIds: ids },
})

async function execute(files: Record<string, string>, ids?: string[]) {
  const prepared = await pythonUnittestTestProvider.prepareRun(request(ids), { files, runId: 'native-python-test' })
  const directory = mkdtempSync(join(tmpdir(), 'webide-unittest-'))
  try {
    for (const [path, content] of Object.entries(prepared.execution.files)) {
      const target = join(directory, path.replace(/^\/(?:workspace|sysroot)\//, ''))
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content)
    }
    let output: string
    try { output = execFileSync('python3', [join(directory, '__web_ide/unittest_runner.py')], { cwd: directory, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) {
      if (!error || typeof error !== 'object' || !('stdout' in error)) throw error
      output = String(error.stdout)
    }
    const frame = prepared.decoder.push('stdout', output)
    const final = prepared.decoder.finish()
    return { events: [...frame.messages, ...final.messages].map(item => item.event), output: frame.output + final.output, raw: output }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
const endEvents = (events: TestReportEventPayloadV2[]) => events.filter(event => ['test_passed', 'test_failed', 'test_errored', 'test_skipped'].includes(event.type))

describe('Python static catalog and execution plan', () => {
  it('finds aliased multiline and inherited tests without interpreting strings or nested definitions', async () => {
    const tests = await discoverPythonTests({ '/workspace/test_cases.py': `import unittest as ut
from unittest import TestCase as TC
fake = """
class Fake(ut.TestCase):
    def test_fake(self): pass
"""
class Base(
    TC
):
    def test_base(self): pass
    def helper(self):
        def test_nested(): pass
class Derived(Base):
    def test_own(self): pass
class Async(ut.IsolatedAsyncioTestCase):
    async def test_async(self): pass
` })
    expect(tests.map(test => test.name)).toEqual(['test_cases.Base.test_base', 'test_cases.Derived.test_base', 'test_cases.Derived.test_own', 'test_cases.Async.test_async'])
    expect(tests[0]?.location?.line).toBe(10)
    expect(new Set(tests.map(test => test.id)).size).toBe(4)
  })
  it('requires package markers for nested tests and labels execution-only sources', async () => {
    const tests = await discoverPythonTests({
      '/workspace/tests/test_ignored.py': 'from unittest import TestCase\nclass T(TestCase):\n def test_x(self): pass',
      '/sysroot/checks/__init__.py': '',
      '/sysroot/checks/test_provided.py': 'import unittest\nclass T(unittest.TestCase):\n def test_x(self): pass',
    })
    expect(tests).toHaveLength(1)
    expect(tests[0]).toMatchObject({ name: 'checks.test_provided.T.test_x', origin: 'provided' })
    expect(tests[0]).not.toHaveProperty('location')
  })
  it('uses bounded deterministic IDs and freezes preserved main source aliases for debug', async () => {
    const files = { '/workspace/main.py': 'value = 3', '/workspace/test_main.py': 'import unittest' }
    const prepared = await pythonUnittestTestProvider.prepareRun({ ...request(), mode: 'debug' }, { files, runId: 'debug-python' })
    expect(prepared.execution.mode).toBe('debug')
    expect(prepared.execution.entrypoint).toBe(PYTHON_UNITTEST_RUNNER_PATH)
    expect(prepared.execution.files[PYTHON_USER_MAIN_PATH]).toBe('value = 3')
    expect(prepared.execution.files).not.toHaveProperty('/workspace/main.py')
    expect(prepared.execution.sourceAliases).toEqual({ [PYTHON_USER_MAIN_PATH]: '/workspace/main.py' })
    expect(files).toHaveProperty('/workspace/main.py')
    expect(await pythonTestKey('/workspace/' + 'ü'.repeat(600), 'Some.test')).toMatch(/^[a-f0-9]{64}$/)
    await expect(pythonUnittestTestProvider.prepareRun(request(), { files: { [PYTHON_USER_MAIN_PATH]: '' }, runId: 'x' })).rejects.toThrow('reserves')
  })
})

describe('real native unittest runner (browser execution covered separately)', () => {
  it('keeps main.py imports and canonical failure locations; frames after no-newline output', async () => {
    const result = await execute({
      '/workspace/main.py': 'def fail():\n    raise ValueError("from main")\n',
      '/workspace/test_main.py': 'import unittest, main\nclass T(unittest.TestCase):\n def test_main(self):\n  print("student", end="")\n  main.fail()\n',
    })
    expect(result.output).toContain('student')
    expect(result.output).not.toContain(TEST_REPORT_PREFIX)
    expect(result.events[0]?.type).toBe('run_started')
    expect(endEvents(result.events)).toEqual([expect.objectContaining({ type: 'test_errored', path: '/workspace/main.py', line: 2, message: 'from main' })])
    const error = endEvents(result.events)[0]
    expect(error && 'details' in error ? error.details : '').not.toContain('__web_ide_user_main__')
    expect(result.events.at(-1)?.type).toBe('run_finished')
  })
  it('emits one terminal event after subtests, cleanup and skipped-subtest completion', async () => {
    const result = await execute({ '/workspace/test_lifecycle.py': `import unittest
class T(unittest.TestCase):
 def test_cleanup(self):
  self.addCleanup(lambda: 1/0)
  with self.subTest(part=1): self.fail('first')
 def test_skip(self):
  with self.subTest(part=1): self.skipTest('skip one')
 def test_good(self): pass
 @unittest.expectedFailure
 def test_expected(self): self.fail('expected')
 @unittest.expectedFailure
 def test_unexpected(self): pass
` })
    const terminals = endEvents(result.events)
    expect(terminals).toHaveLength(5)
    expect(terminals.map(item => item.type).sort()).toEqual(['test_errored', 'test_failed', 'test_passed', 'test_skipped', 'test_skipped'])
    expect(new Set(terminals.map(item => 'testId' in item ? item.testId : '')).size).toBe(5)
    expect(result.events.filter(item => item.type === 'test_started')).toHaveLength(5)
  })
  it('announces fixture errors and import failures with starts and canonical source', async () => {
    const result = await execute({
      '/workspace/test_import.py': 'raise ValueError("bad import")',
      '/workspace/test_fixture.py': 'import unittest\nclass T(unittest.TestCase):\n @classmethod\n def setUpClass(cls): raise ValueError("bad fixture")\n def test_never(self): pass',
    })
    const terminals = endEvents(result.events)
    expect(terminals).toHaveLength(3)
    expect(terminals.filter(item => item.type === 'test_errored')).toHaveLength(2)
    expect(terminals.filter(item => item.type === 'test_skipped')).toHaveLength(1)
    for (const terminal of terminals) {
      const id = 'testId' in terminal ? terminal.testId : undefined
      expect(result.events.some(item => item.type === 'test_started' && item.testId === id)).toBe(true)
      expect(result.events.some(item => item.type === 'test_discovered' && item.descriptor.id === id)).toBe(true)
    }
  })
  it('reconciles skipped fixtures and repeated class cleanup errors without duplicate IDs', async () => {
    const result = await execute({ '/workspace/test_fixture.py': `import unittest
class Broken(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.addClassCleanup(lambda: 1/0)
  cls.addClassCleanup(lambda: 1/0)
  raise ValueError('setup failed')
 def test_blocked(self): pass
class Skipped(unittest.TestCase):
 @classmethod
 def setUpClass(cls): raise unittest.SkipTest('skip class')
 def test_blocked(self): pass
` })
    const discovered = result.events.flatMap(item => item.type === 'test_discovered' ? [item.descriptor.id] : [])
    const completed = endEvents(result.events).flatMap(item => 'testId' in item ? [item.testId] : [])
    expect(new Set(discovered).size).toBe(discovered.length)
    expect(new Set(completed)).toEqual(new Set(discovered))
    expect(endEvents(result.events).filter(item => item.type === 'test_errored')).toHaveLength(3)
    expect(endEvents(result.events).filter(item => item.type === 'test_skipped')).toHaveLength(3)
  })

  it('uses authoritative load_tests suites and exact selection, never empty means all', async () => {
    const files = { '/workspace/test_dynamic.py': `import unittest
class T(unittest.TestCase):
 def test_a(self): print('A_ONLY')
 def test_b(self): print('B_ONLY')
def load_tests(loader, tests, pattern):
 return unittest.TestSuite([T('test_b')])
` }
    const keyA = 'py:' + await pythonTestKey('/workspace/test_dynamic.py', 'test_dynamic.T.test_a')
    const keyB = 'py:' + await pythonTestKey('/workspace/test_dynamic.py', 'test_dynamic.T.test_b')
    const all = await execute(files)
    expect(all.output).toContain('B_ONLY'); expect(all.output).not.toContain('A_ONLY')
    const selected = await execute(files, [keyB])
    expect(endEvents(selected.events)).toHaveLength(1)
    for (const ids of [[keyA], []]) {
      const missing = await execute(files, ids)
      expect(endEvents(missing.events)).toHaveLength(0)
      expect(missing.events.at(-1)).toMatchObject({ type: 'run_terminated', reason: 'selection_stale' })
    }
    const empty = await execute({ '/workspace/test_none.py': '' })
    expect(empty.events.at(-1)).toMatchObject({ type: 'run_finished', message: 'No tests ran' })
  })
  it('reports preload and module fixture failures within a completed discovery lifecycle', async () => {
    const fixtures: Record<string, string>[] = [
      { '/workspace/main.py': 'raise ValueError("preload failed")' },
      { '/workspace/test_setup.py': 'import unittest\ndef setUpModule(): raise ValueError("setup module")\nclass T(unittest.TestCase):\n def test_never(self): pass' },
      { '/workspace/test_teardown.py': 'import unittest\ndef tearDownModule(): raise ValueError("teardown module")\nclass T(unittest.TestCase):\n def test_good(self): pass' },
    ]
    for (const files of fixtures) {
      const result = await execute(files)
      const finished = result.events.findIndex(item => item.type === 'discovery_finished')
      expect(finished).toBeGreaterThan(0)
      expect(result.events.findIndex(item => item.type === 'test_started')).toBeGreaterThan(finished)
      expect(endEvents(result.events).some(item => item.type === 'test_errored')).toBe(true)
      expect(result.events.at(-1)?.type).toBe('run_finished')
    }
  })

  it('keeps generated FunctionTestCase sources and clips oversized display metadata', async () => {
    const name = 'test_' + 'x'.repeat(1400)
    const result = await execute({ '/workspace/test_function.py': `import unittest
def ${name}(): pass
def load_tests(loader, tests, pattern):
 return unittest.TestSuite([unittest.FunctionTestCase(${name})])
` })
    const discovered = result.events.find(item => item.type === 'test_discovered')
    expect(discovered).toMatchObject({ descriptor: { origin: 'student', location: { path: '/workspace/test_function.py', line: 2 } } })
    expect(discovered?.type === 'test_discovered' ? [...discovered.descriptor.name].length : 0).toBe(1024)
    expect(endEvents(result.events)).toMatchObject([{ type: 'test_passed' }])
  })

  it('keeps provided metadata and bounds huge Unicode tracebacks', async () => {
    const result = await execute({ '/sysroot/test_provided.py': 'import unittest\nclass T(unittest.TestCase):\n def test_error(self): raise ValueError("😀" * 90000)\n' })
    expect(result.events.find(item => item.type === 'test_discovered')).toMatchObject({ descriptor: { origin: 'provided' } })
    const terminal = endEvents(result.events)[0]
    expect(terminal).toMatchObject({ type: 'test_errored' })
    expect(terminal).not.toHaveProperty('path')
    expect(result.raw.split('\n').every(line => Buffer.byteLength(line) <= 65536)).toBe(true)
    expect('details' in terminal! ? terminal.details : '').toContain('truncated')
  })
})

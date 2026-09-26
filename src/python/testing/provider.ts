import UNITTEST_RUNNER from './unittest_runner.py?raw'
import type { TestDescriptorV2, TestProviderV2 } from '@/web-ide/contracts/testing'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import { canonicalStringifyV1, sha256Hex } from '@/web-ide/public/canonical-contract'
import { normalizeRuntimeFiles, runtimeRelativeFilePath } from '@/web-ide/core/workspace-path'
import { createTestReportDecoder } from '@/testing/testing-protocol'

export const PYTHON_UNITTEST_RUNNER_PATH = '/workspace/__web_ide/unittest_runner.py'
export const PYTHON_USER_MAIN_PATH = '/workspace/__web_ide_user_main__.py'

interface PythonSource {
  path: string
  runtimePath: string
  module: string
  origin: 'student' | 'provided'
}

function sourcesFor(files: WorkspaceFiles): PythonSource[] {
  return Object.keys(files).filter(path => path.endsWith('.py')).sort().map(path => ({
    path,
    runtimePath: '/' + runtimeRelativeFilePath(path),
    module: runtimeRelativeFilePath(path).slice(0, -3).replaceAll('/', '.').replace(/\.__init__$/, ''),
    origin: path.startsWith('/sysroot/') ? 'provided' : 'student',
  }))
}

/** Remove literal/comment contents while retaining whitespace and line positions. */
function maskedPython(source: string): string {
  let output = '', index = 0
  while (index < source.length) {
    const ch = source[index]!
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') { output += ' '; index++ }
    } else if (ch === '"' || ch === "'") {
      const quote = source.slice(index, index + 3) === ch.repeat(3) ? ch.repeat(3) : ch
      output += ' '.repeat(quote.length); index += quote.length
      while (index < source.length) {
        if (source.slice(index, index + quote.length) === quote) {
          output += ' '.repeat(quote.length); index += quote.length; break
        }
        if (source[index] === '\\' && index + 1 < source.length) {
          output += ' ' + (source[index + 1] === '\n' ? '\n' : ' '); index += 2
        } else { output += source[index] === '\n' ? '\n' : ' '; index++ }
      }
    } else { output += ch; index++ }
  }
  return output
}

interface ClassPreview { name: string; bases: string[]; methods: Map<string, number>; indent: number; line: number }

function classPreviews(text: string): ClassPreview[] {
  const lines = maskedPython(text).replaceAll('\r\n', '\n').split('\n')
  const classes: ClassPreview[] = []
  const stack: { indent: number; class?: ClassPreview }[] = []
  const aliases = new Set(['TestCase', 'unittest.TestCase', 'IsolatedAsyncioTestCase', 'unittest.IsolatedAsyncioTestCase'])
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!
    if (!line.trim()) continue
    const start = index + 1
    const indent = line.match(/^\s*/)?.[0].replaceAll('\t', '        ').length ?? 0
    let balance = (line.match(/[([{]/g)?.length ?? 0) - (line.match(/[)\]}]/g)?.length ?? 0)
    while ((balance > 0 || /\\\s*$/.test(line)) && index + 1 < lines.length) {
      const next = lines[++index]!
      balance += (next.match(/[([{]/g)?.length ?? 0) - (next.match(/[)\]}]/g)?.length ?? 0)
      line = line.replace(/\\\s*$/, '') + ' ' + next.trim()
    }
    const importAlias = line.match(/^\s*import\s+unittest\s+as\s+(\w+)/)
    if (importAlias) {
      aliases.add(importAlias[1] + '.TestCase'); aliases.add(importAlias[1] + '.IsolatedAsyncioTestCase')
    }
    if (/^\s*from\s+unittest\s+import\s/.test(line)) {
      for (const match of line.matchAll(/\b(TestCase|IsolatedAsyncioTestCase)(?:\s+as\s+(\w+))?/g)) aliases.add(match[2] ?? match[1]!)
    }
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
    const cls = line.match(/^\s*class\s+([\p{ID_Start}_][\p{ID_Continue}]*)\s*(?:\((.*?)\))?\s*:/u)
    if (cls) {
      const item = { name: cls[1]!, bases: (cls[2] ?? '').split(',').map(s => s.trim()), methods: new Map<string, number>(), indent, line: start }
      // Nested classes/functions are not module-level unittest attributes.
      if (stack.length === 0 && indent === 0) classes.push(item)
      stack.push({ indent, class: item }); continue
    }
    const method = line.match(/^\s*(?:async\s+)?def\s+([\p{ID_Start}_][\p{ID_Continue}]*)\s*\(/u)
    if (method) {
      const owner = stack.at(-1)?.class
      if (owner && method[1]!.startsWith('test')) owner.methods.set(method[1]!, start)
      stack.push({ indent })
    }
  }
  const byName = new Map(classes.map(cls => [cls.name, cls]))
  const memo = new Map<string, Map<string, number> | undefined>()
  const resolve = (cls: ClassPreview, visiting = new Set<string>()): Map<string, number> | undefined => {
    if (memo.has(cls.name)) return memo.get(cls.name)
    if (visiting.has(cls.name)) return undefined
    visiting.add(cls.name)
    let valid = cls.bases.some(base => aliases.has(base))
    const methods = new Map<string, number>()
    for (const name of cls.bases) {
      const base = byName.get(name)
      const inherited = base ? resolve(base, visiting) : undefined
      if (inherited) { valid = true; for (const [method, line] of inherited) if (!methods.has(method)) methods.set(method, line) }
    }
    visiting.delete(cls.name)
    for (const [method, line] of cls.methods) methods.set(method, line)
    memo.set(cls.name, valid ? methods : undefined)
    return memo.get(cls.name)
  }
  return classes.flatMap(cls => {
    const methods = resolve(cls)
    return methods ? [{ ...cls, methods }] : []
  })
}

export async function pythonTestKey(path: string, unittestId: string): Promise<string> {
  return sha256Hex(path + '\n' + unittestId)
}

export async function discoverPythonTests(filesInput: WorkspaceFiles): Promise<TestDescriptorV2[]> {
  const files = normalizeRuntimeFiles(filesInput)
  const sources = sourcesFor(files)
  const runtimeFiles = new Set(Object.keys(files).map(runtimeRelativeFilePath))
  const tests: TestDescriptorV2[] = []
  for (const source of sources) {
    const relative = runtimeRelativeFilePath(source.path)
    const parts = relative.split('/')
    if (!/^test[^/]*\.py$/.test(parts.at(-1)!) || !/^[_a-z]\w*\.py$/i.test(parts.at(-1)!)) continue
    if (parts.slice(0, -1).some((_, i) => !runtimeFiles.has(parts.slice(0, i + 1).join('/') + '/__init__.py'))) continue
    for (const cls of classPreviews(files[source.path]!)) {
      for (const [method, line] of [...cls.methods].sort(([a], [b]) => a.localeCompare(b))) {
        const rawId = `${source.module}.${cls.name}.${method}`
        tests.push({
          id: 'py:' + await pythonTestKey(source.path, rawId), name: [...rawId].slice(0, 1024).join(''), origin: source.origin,
          group: [...relative].slice(0, 512).join(''),
          ...(source.origin === 'student' ? { location: { path: source.path, line } } : {}),
        })
      }
    }
  }
  return tests
}

export const pythonUnittestTestProvider: TestProviderV2 = {
  apiVersion: 2,
  id: 'web-ide.testing.python-unittest',
  label: 'Python unittest',
  languageIds: ['python'],
  help: { message: 'Create test*.py files with', examples: [{ code: 'unittest.TestCase' }] },
  async discover({ files, workspaceDigest }) {
    const tests = await discoverPythonTests(files)
    return { apiVersion: 2, kind: 'catalog', workspaceDigest, catalogDigest: await sha256Hex(canonicalStringifyV1(tests)), tests }
  },
  prepareExecution({ files, mode }) { return { files: { ...files }, mode } },
  async prepareRun(request, { files, runId }) {
    const preparedFiles = normalizeRuntimeFiles(files)
    const sources = sourcesFor(preparedFiles)
    for (const reserved of [PYTHON_UNITTEST_RUNNER_PATH, PYTHON_USER_MAIN_PATH]) {
      if (Object.keys(preparedFiles).some(path => runtimeRelativeFilePath(path) === runtimeRelativeFilePath(reserved))) {
        throw new Error(`Python testing reserves ${reserved}`)
      }
    }
    const main = sources.find(source => source.runtimePath === '/main.py')
    const sourceAliases: Record<string, string> = {}
    if (main) {
      preparedFiles[PYTHON_USER_MAIN_PATH] = preparedFiles[main.path]!
      delete preparedFiles[main.path]
      sourceAliases[PYTHON_USER_MAIN_PATH] = main.path
      main.runtimePath = '/' + runtimeRelativeFilePath(PYTHON_USER_MAIN_PATH)
    }
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const selection = request.selection.kind === 'all' ? null : request.selection.testIds.map(id => {
      if (!/^py:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Python test selection')
      return id.slice(3)
    })
    const config = new TextEncoder().encode(JSON.stringify({ nonce, sources, selection }))
    const hex = Array.from(config, byte => byte.toString(16).padStart(2, '0')).join('')
    preparedFiles[PYTHON_UNITTEST_RUNNER_PATH] = UNITTEST_RUNNER.replace('__WEB_IDE_CONFIG_HEX__', hex)
    return {
      execution: { files: preparedFiles, mode: request.mode, entrypoint: PYTHON_UNITTEST_RUNNER_PATH, sourceAliases },
      decoder: createTestReportDecoder({ nonce, runId, toTestId: key => {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid Python test key')
        return 'py:' + key
      } }),
    }
  },
}

export const pythonTestingPlugin: IDEPlugin = {
  id: 'web-ide.testing.python-unittest',
  contributes: { testProviders: [pythonUnittestTestProvider] },
}

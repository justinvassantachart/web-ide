import type { TestDescriptorV2, TestProviderV2 } from '@/web-ide/contracts/testing'
import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import { normalizeRuntimeFiles } from '@/web-ide/core/workspace-path'
import { canonicalStringifyV1, sha256Hex } from '@/web-ide/public/canonical-contract'
import { createTestReportDecoder } from '@/testing/testing-protocol'
import { CPP_TEST_SUPPORT_FILES, CPP_TEST_RESERVED_PATHS, CPP_TEST_HEADER_PATH, CPP_TEST_RUNNER_PATH, CPP_TEST_RUNNER_SOURCE, CPP_TEST_CONFIG_PATH, makeCppTestConfig } from './resources'
export { CPP_TEST_SUPPORT_FILES, CPP_TEST_RESERVED_PATHS, CPP_TEST_HEADER_PATH, CPP_TEST_IMPL_PATH, CPP_TEST_RUNNER_PATH, CPP_TEST_RUNNER_SOURCE, CPP_TEST_CONFIG_PATH, validateCppTestSupportFiles } from './resources'
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

export function tokenizeCpp(source: string): SourceToken[] {
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
      tokens.push({ value: source.slice(index, rawStringEnd), start: index, end: rawStringEnd })
      index = rawStringEnd
      continue
    }
    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index++
      while (index < source.length) {
        const next = source[index]
        if (/[A-Za-z0-9_.]/.test(next) || (next === "'" && /[A-Za-z0-9]/.test(source[index + 1] ?? ''))
          || ((next === '+' || next === '-') && /[eEpP]/.test(source[index - 1]))) index++
        else break
      }
      tokens.push({ value: source.slice(start, index), start, end: index })
      continue
    }
    if (character === '"' || character === "'") {
      const end = quotedLiteralEnd(source, index, character)
      tokens.push({ value: source.slice(index, end), start: index, end })
      index = end
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
  const scopes: boolean[] = []
  const mainTokens: SourceToken[] = []
  tokens.forEach((token, index) => {
    if (token.value === '{') scopes.push(tokens[index - 2]?.value === 'extern' && ['"C"', '"C++"'].includes(tokens[index - 1]?.value))
    else if (token.value === '}') scopes.pop()
    else if (token.value === 'main' && scopes.every(linkage => linkage)
      && ['int', 'void', 'auto', 'signed'].includes(tokens[index - 1]?.value)
      && tokens[index + 1]?.value === '(') mainTokens.push(token)
  })
  if (mainTokens.length === 0) return source

  let renamed = source
  for (const token of mainTokens.reverse()) {
    renamed = `${renamed.slice(0, token.start)}webide_hidden_main${renamed.slice(token.end)}`
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

function testKey(value: string): string {
  let a = 2166136261, b = 3339675911
  for (const byte of new TextEncoder().encode(value)) { a = Math.imul(a ^ byte, 16777619) >>> 0; b = Math.imul(b ^ byte, 16777619) >>> 0 }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
function literalName(tokens: readonly SourceToken[]): string | undefined {
  let result = ''
  for (const token of tokens) {
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(([\s\S]*)\)\1"$/.exec(token.value)
    if (raw) { result += raw[2]; continue }
    if (!/^"[\s\S]*"$/.test(token.value)) return undefined
    try { result += JSON.parse(token.value) as string } catch { return undefined }
  }
  return result || undefined
}
interface CppDeclaration { descriptor: TestDescriptorV2; key: string; edits: { start: number; end: number; text: string }[] }
function declarations(path: string, source: string): CppDeclaration[] {
  const tokens = tokenizeCpp(source)
  const ordinals = new Map<number, number>()
  const found: CppDeclaration[] = []
  for (let i = 0; i < tokens.length; i++) {
    const macro = tokens[i]
    if (!['STUDENT_TEST', 'PROVIDED_TEST'].includes(macro.value) || tokens[i + 1]?.value !== '(') continue
    let depth = 1, end = i + 2
    for (; end < tokens.length; end++) { if (tokens[end].value === '(') depth++; if (tokens[end].value === ')' && --depth === 0) break }
    if (end >= tokens.length) continue
    const line = source.slice(0, macro.start).split('\n').length
    const ordinal = ordinals.get(line) ?? 0; ordinals.set(line, ordinal + 1)
    const origin = macro.value === 'STUDENT_TEST' ? 'student' : 'provided'
    const name = literalName(tokens.slice(i + 2, end)) ?? `Test at ${path.split('/').pop()}:${line}`
    const key = testKey(`${path}\n${line}\n${ordinal}\n${origin}\n${name}`)
    const descriptor: TestDescriptorV2 = { id: `cpp:${key}`, name: [...name].slice(0, 1024).join(''), origin, group: [...path].slice(-512).join(''), ...(path.startsWith('/workspace/') ? { location: { path, line } } : {}) }
    found.push({ descriptor, key, edits: [
      { start: macro.start, end: macro.end, text: 'WEBIDE_TEST_KEY' },
      { start: tokens[i + 1].end, end: tokens[i + 1].end, text: `"${key}",` },
      { start: tokens[end].start, end: tokens[end].start, text: `,"${origin}"` },
    ] })
    i = end
  }
  return found
}
function assertAvailable(files: WorkspaceFiles) {
  for (const path of Object.keys(files)) if (CPP_TEST_RESERVED_PATHS.some(reserved => path.replace(/^\/(workspace|sysroot)\//, '') === reserved.slice('/workspace/'.length))) throw new TypeError(`Reserved testing support path: ${path}`)
}
function cppSource(path: string) { return /\.(?:cpp|cc|cxx|c|h|hh|hpp|hxx)$/.test(path) }
export function prepareCppTestingSupport(files: WorkspaceFiles, executeTests: boolean, runId?: string, selectionKeys?: readonly string[]): WorkspaceFiles {
  const prepared = normalizeRuntimeFiles(files)
  assertAvailable(prepared)
  const needsSupport = executeTests || Object.values(prepared).some(contents => /\bwebide_test\.h\b/.test(contents))
  if (!needsSupport) return prepared
  if (executeTests) for (const [path, source] of Object.entries(prepared)) {
    if (!cppSource(path)) continue
    const edits = declarations(path, source).flatMap(found => found.edits).sort((a, b) => b.start - a.start)
    let transformed = source
    for (const edit of edits) transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end)
    if (/\.(?:cpp|cc|cxx|c)$/.test(path)) transformed = hideUserMain(transformed)
    // Host-owned runtime resources are verified by exact bytes. Untouched
    // support sources need no test or debugger transformation.
    if (transformed === source) continue
    const compilerPath = path.startsWith('/workspace/') ? path.slice('/workspace'.length) : path
    prepared[path] = `#line 1 ${JSON.stringify(compilerPath)}\n${transformed}`
  }
  Object.assign(prepared, CPP_TEST_SUPPORT_FILES)
  if (executeTests) {
    if (!runId) throw new TypeError('A C++ test run requires a run ID')
    prepared[CPP_TEST_RUNNER_PATH] = CPP_TEST_RUNNER_SOURCE
    prepared[CPP_TEST_CONFIG_PATH] = makeCppTestConfig(runId, selectionKeys)
  }
  return prepared
}
export const cppTestProvider: TestProviderV2 = {
  apiVersion: 2,
  id: 'web-ide.testing.cpp', label: 'C++ Tests', languageIds: ['cpp'],
  editorSupportFiles: Object.freeze({ [CPP_TEST_HEADER_PATH]: CPP_TEST_SUPPORT_FILES[CPP_TEST_HEADER_PATH] }),
  help: { message: 'Include webide_test.h and declare tests with STUDENT_TEST or PROVIDED_TEST.', examples: [{ code: 'EXPECT_EQUAL(actual, expected)' }] },
  async discover({ files, workspaceDigest }) {
    const normalized = normalizeRuntimeFiles(files); assertAvailable(normalized)
    const tests = Object.entries(normalized).sort(([a], [b]) => a < b ? -1 : 1).flatMap(([path, source]) => cppSource(path) ? declarations(path, source).map(found => found.descriptor) : [])
    if (new Set(tests.map(test => test.id)).size !== tests.length) throw new TypeError('C++ test identity collision')
    return { apiVersion: 2, kind: 'catalog', workspaceDigest, catalogDigest: await sha256Hex(canonicalStringifyV1({ workspaceDigest, tests })), tests }
  },
  prepareExecution: ({ files, mode }) => ({ files: prepareCppTestingSupport(files, false), mode }),
  async prepareRun(request, { files, runId }) {
    const selected = request.selection.kind === 'all' ? undefined : request.selection.testIds.map(id => {
      if (!/^cpp:[a-f0-9]{16}$/.test(id)) throw new TypeError('Invalid selected C++ test ID')
      return id.slice(4)
    })
    const decoder = createTestReportDecoder({ nonce: runId, runId, toTestId: key => `cpp:${key}` })
    const resourcePaths = new Set(Object.keys(normalizeRuntimeFiles(files)).filter(path => path.startsWith('/sysroot/')).map(path => '/workspace/' + path.slice('/sysroot/'.length)))
    const hideResourceLocations = (frame: ReturnType<typeof decoder.push>) => ({ ...frame, messages: frame.messages.map(report => {
      const event = report.event
      if (event.type === 'test_discovered' && event.descriptor.location && resourcePaths.has(event.descriptor.location.path)) {
        const { location, ...descriptor } = event.descriptor
        return { ...report, event: { ...event, descriptor: { ...descriptor, group: '/sysroot/' + location.path.slice('/workspace/'.length) } } }
      }
      if ('path' in event && event.path && resourcePaths.has(event.path)) {
        const { path, line } = event
        const rest = { ...event }; delete rest.path; delete rest.line; delete rest.column
        return { ...report, event: { ...rest, ...(['test_failed', 'test_errored'].includes(event.type) ? { details: `Runtime resource /sysroot/${path.slice('/workspace/'.length)}:${line ?? '?'}` } : {}) } }
      }
      return report
    }) })
    return {
      execution: { files: prepareCppTestingSupport(files, true, runId, selected), mode: request.mode, entrypoint: CPP_TEST_RUNNER_PATH },
      decoder: { push: (stream, chunk) => hideResourceLocations(decoder.push(stream, chunk)), finish: () => hideResourceLocations(decoder.finish()) },
    }
  },
}
export const cppTestingPlugin: IDEPlugin = { id: 'web-ide.testing.cpp', contributes: { testProviders: [cppTestProvider] } }

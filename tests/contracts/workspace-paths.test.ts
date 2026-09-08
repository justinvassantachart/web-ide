import { describe, expect, it } from 'vitest'

import {
  assertNoFlattenedRuntimePathCollisions,
  canonicalExecutionFilePath,
  canonicalRuntimeFilePath,
  canonicalWorkspaceFilePath,
  normalizeRuntimeFiles,
  normalizeWorkspaceFiles,
  runtimeRelativeFilePath,
} from '../../src/web-ide/core/workspace-path'

const workspacePathAtLimit = `/workspace/${'w'.repeat(1024 - '/workspace/'.length)}`
const workspacePathOverLimit = `${workspacePathAtLimit}w`
const sysrootPathAtLimit = `/sysroot/${'s'.repeat(1024 - '/sysroot/'.length)}`
const sysrootPathOverLimit = `${sysrootPathAtLimit}s`

describe('workspace path boundary', () => {
  it('canonicalizes relative and rooted host paths into /workspace', () => {
    expect(canonicalWorkspaceFilePath('src/main.py')).toBe('/workspace/src/main.py')
    expect(canonicalWorkspaceFilePath('/src/main.py')).toBe('/workspace/src/main.py')
    expect(canonicalWorkspaceFilePath('/workspace/src/main.py')).toBe('/workspace/src/main.py')
  })

  it('uses the public NFC and well-formed-Unicode path contract', () => {
    expect(canonicalWorkspaceFilePath('/workspace/cafe\u0301.py'))
      .toBe('/workspace/caf\u00e9.py')
    expect(canonicalExecutionFilePath('/sysroot/cafe\u0301.py'))
      .toBe('/sysroot/caf\u00e9.py')
    expect(runtimeRelativeFilePath('/workspace/cafe\u0301.py'))
      .toBe('caf\u00e9.py')

    for (const invalid of [
      '/workspace/bad\ud800.py',
      '/workspace/lib\\support.py',
    ]) {
      expect(() => canonicalWorkspaceFilePath(invalid)).toThrow()
      expect(() => runtimeRelativeFilePath(invalid)).toThrow()
    }
    expect(() => canonicalExecutionFilePath('/sysroot/bad\ud800.py')).toThrow()
    expect(() => canonicalExecutionFilePath('/sysroot/lib\\support.py')).toThrow()
  })

  it('applies the frozen post-NFC 1,024-code-point ceiling to every legacy scope', () => {
    const legacyAtLimit = workspacePathAtLimit.slice('/workspace/'.length)
    const normalizedAtLimit = `/workspace/${'e\u0301'.repeat(1024 - '/workspace/'.length)}`

    expect([...canonicalWorkspaceFilePath(workspacePathAtLimit)]).toHaveLength(1024)
    expect(canonicalWorkspaceFilePath(legacyAtLimit)).toBe(workspacePathAtLimit)
    expect(canonicalRuntimeFilePath(legacyAtLimit)).toBe(workspacePathAtLimit)
    expect(runtimeRelativeFilePath(workspacePathAtLimit)).toBe(legacyAtLimit)
    expect([...canonicalWorkspaceFilePath(normalizedAtLimit)]).toHaveLength(1024)
    expect(() => canonicalWorkspaceFilePath(workspacePathOverLimit)).toThrow(/oversized/)
    expect(() => canonicalRuntimeFilePath(workspacePathOverLimit)).toThrow(/oversized/)
    expect(() => runtimeRelativeFilePath(workspacePathOverLimit)).toThrow(/oversized/)

    expect([...canonicalExecutionFilePath(sysrootPathAtLimit)]).toHaveLength(1024)
    expect(canonicalExecutionFilePath(sysrootPathAtLimit.slice('/sysroot/'.length)))
      .toBe(sysrootPathAtLimit)
    expect(canonicalRuntimeFilePath(sysrootPathAtLimit)).toBe(sysrootPathAtLimit)
    expect(() => canonicalExecutionFilePath(sysrootPathOverLimit)).toThrow(/oversized/)
    expect(() => canonicalExecutionFilePath(
      sysrootPathOverLimit.slice('/sysroot/'.length),
    )).toThrow(/oversized/)
    expect(() => canonicalRuntimeFilePath(sysrootPathOverLimit)).toThrow(/oversized/)
  })

  it.each([
    '',
    '/',
    '/workspace',
    '/workspace/',
    '/workspace/../escape.py',
    '/workspace/./main.py',
    '/workspace/src//main.py',
    'src/../escape.py',
    'bad\0path.py',
  ])('rejects unsafe or ambiguous path %j', (path) => {
    expect(() => canonicalWorkspaceFilePath(path)).toThrow()
  })

  it('normalizes into a fresh prototype-safe map', () => {
    const input = JSON.parse('{"/__proto__.py":"safe","main.py":"print(1)"}') as Record<string, string>
    const normalized = normalizeWorkspaceFiles(input)

    expect(normalized).toEqual({
      '/workspace/__proto__.py': 'safe',
      '/workspace/main.py': 'print(1)',
    })
    expect(Object.getPrototypeOf(normalized)).toBeNull()
  })

  it('canonicalizes execution resources into /sysroot from legacy and scoped spellings', () => {
    expect(canonicalExecutionFilePath('lib/support.py')).toBe('/sysroot/lib/support.py')
    expect(canonicalExecutionFilePath('/lib/support.py')).toBe('/sysroot/lib/support.py')
    expect(canonicalExecutionFilePath('/workspace/lib/support.py')).toBe('/sysroot/lib/support.py')
    expect(canonicalExecutionFilePath('/sysroot/lib/support.py')).toBe('/sysroot/lib/support.py')
  })

  it.each([
    '',
    '/',
    '/workspace',
    '/sysroot',
    '/sysroot/',
    '/workspace/../escape.py',
    '/sysroot/./support.py',
    '/sysroot/lib//support.py',
    'lib/../escape.py',
    'bad\0path.py',
  ])('rejects unsafe or ambiguous execution path %j', (path) => {
    expect(() => canonicalExecutionFilePath(path)).toThrow()
  })

  it('models runtime flattening consistently for all accepted path spellings', () => {
    expect(runtimeRelativeFilePath('/workspace/lib/support.py')).toBe('lib/support.py')
    expect(runtimeRelativeFilePath('/sysroot/lib/support.py')).toBe('lib/support.py')
    expect(runtimeRelativeFilePath('/lib/support.py')).toBe('lib/support.py')
    expect(runtimeRelativeFilePath('lib/support.py')).toBe('lib/support.py')
  })

  it('detects flattened collisions deterministically regardless of insertion order', () => {
    const leftFirst = {
      '/workspace/lib/support.py': 'student',
      '/sysroot/lib/support.py': 'runtime',
    }
    const rightFirst = {
      '/sysroot/lib/support.py': 'runtime',
      '/workspace/lib/support.py': 'student',
    }
    const expected = 'Runtime file paths "/sysroot/lib/support.py" and "/workspace/lib/support.py" both flatten to "lib/support.py"'

    expect(() => assertNoFlattenedRuntimePathCollisions(leftFirst)).toThrow(expected)
    expect(() => assertNoFlattenedRuntimePathCollisions(rightFirst)).toThrow(expected)
  })

  it('canonicalizes a complete runtime map without exposing partial or aliased keys', () => {
    const normalized = normalizeRuntimeFiles({
      'cafe\u0301.py': 'workspace',
      '/sysroot/support.py': 'runtime',
    })

    expect(normalized).toEqual({
      '/workspace/caf\u00e9.py': 'workspace',
      '/sysroot/support.py': 'runtime',
    })
    expect(Object.getPrototypeOf(normalized)).toBeNull()
    expect(() => normalizeRuntimeFiles({
      [workspacePathAtLimit]: 'accepted first',
      [workspacePathOverLimit]: 'reject transaction',
    })).toThrow(/oversized/)
  })
})

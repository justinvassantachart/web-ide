import { describe, expect, it } from 'vitest'

import {
  assertNoFlattenedRuntimePathCollisions,
  canonicalExecutionFilePath,
  canonicalWorkspaceFilePath,
  normalizeWorkspaceFiles,
  runtimeRelativeFilePath,
} from '../../src/web-ide/core/workspace-path'

describe('workspace path boundary', () => {
  it('canonicalizes relative and rooted host paths into /workspace', () => {
    expect(canonicalWorkspaceFilePath('src/main.py')).toBe('/workspace/src/main.py')
    expect(canonicalWorkspaceFilePath('/src/main.py')).toBe('/workspace/src/main.py')
    expect(canonicalWorkspaceFilePath('/workspace/src/main.py')).toBe('/workspace/src/main.py')
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
})

import { describe, expect, it } from 'vitest'

import {
  canonicalWorkspaceFilePath,
  normalizeWorkspaceFiles,
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
})

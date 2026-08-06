import { describe, expect, it } from 'vitest'

import {
  monacoLanguageForPath,
  monacoLanguageInfoForPath,
  monacoLanguageLabelForPath,
} from '../../src/web-ide/core/monaco-language'

describe('workspace path to Monaco language mapping', () => {
  it.each([
    ['/workspace/main.c', 'cpp', 'C++'],
    ['/workspace/main.CPP', 'cpp', 'C++'],
    ['/workspace/include/value.hpp', 'cpp', 'C++'],
    ['/workspace/main.py', 'python', 'Python'],
    ['/workspace/types.PYI', 'python', 'Python'],
  ])('maps %s to %s', (path, id, label) => {
    expect(monacoLanguageForPath(path)).toBe(id)
    expect(monacoLanguageLabelForPath(path)).toBe(label)
  })

  it('uses plaintext without a language label for unknown files', () => {
    expect(monacoLanguageInfoForPath('/workspace/README')).toEqual({
      id: 'plaintext',
    })
  })
})

export interface MonacoLanguageInfo {
  id: string
  label?: string
}

const PLAINTEXT: MonacoLanguageInfo = Object.freeze({ id: 'plaintext' })

const EXTENSION_LANGUAGES: Readonly<Record<string, MonacoLanguageInfo>> =
  Object.freeze({
    '.c': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.cc': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.cp': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.cpp': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.cxx': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.c++': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.h': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.hh': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.hpp': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.hxx': Object.freeze({ id: 'cpp', label: 'C++' }),
    '.py': Object.freeze({ id: 'python', label: 'Python' }),
    '.pyi': Object.freeze({ id: 'python', label: 'Python' }),
    '.pyw': Object.freeze({ id: 'python', label: 'Python' }),
  })

function extensionOf(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot)
}

export function monacoLanguageInfoForPath(path: string): MonacoLanguageInfo {
  return EXTENSION_LANGUAGES[extensionOf(path)] ?? PLAINTEXT
}

export function monacoLanguageForPath(path: string): string {
  return monacoLanguageInfoForPath(path).id
}

export function monacoLanguageLabelForPath(path: string): string | undefined {
  return monacoLanguageInfoForPath(path).label
}

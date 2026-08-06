import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const providerNeutralFiles = [
  '../../src/web-ide/WebIDE.tsx',
  '../../src/web-ide/react/WorkbenchLayout.tsx',
  '../../src/components/editor/Editor.tsx',
  '../../src/components/layout/StatusBar.tsx',
  '../../src/components/sidebar/SettingsMenu.tsx',
]

describe('language tooling package boundary', () => {
  it.each(providerNeutralFiles)('%s has no clangd dependency', (relativePath) => {
    const source = readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      'utf8',
    )

    expect(source).not.toMatch(/clangd/i)
    expect(source).not.toContain('@/clangd')
    expect(source).not.toMatch(/C\+\+|isCppPath/)
  })
})

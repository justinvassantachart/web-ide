import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('optional capability entrypoint isolation', () => {
  it('keeps optional implementations out of the core workbench entrypoint', () => {
    const core = [
      source('../../src/web-ide/index.ts'),
      source('../../src/web-ide/WebIDE.tsx'),
      source('../../src/web-ide/core/workspace-controller.ts'),
    ].join('\n')

    expect(core).not.toContain('/host-service')
    expect(core).not.toContain('/testing-controller-v2')
    expect(core).not.toMatch(/from ['"](?:@\/|\.\.\/|\.\/)*clangd\//)
    expect(core).not.toContain('@/vfs/volume')
  })

  it('keeps runtime, testing, and language-tooling implementations on separate subpaths', () => {
    const runtimes = source('../../src/runtimes.ts')
    const testing = source('../../src/testing.ts')
    const languageTools = source('../../src/language-tools.ts')

    expect(runtimes).not.toMatch(/testing-controller-v2|clangd\//)
    expect(testing).not.toMatch(/host-service|clangd\//)
    expect(languageTools).not.toMatch(/host-service|testing-controller-v2/)
  })

  it('keeps instance OPFS reads independent of the legacy singleton volume', () => {
    const opfs = source('../../src/vfs/opfs-sync.ts')

    expect(opfs).not.toMatch(/^import[^\n]*['"]\.\/volume['"]/m)
    expect(opfs).toContain("await import('./volume')")
  })
})

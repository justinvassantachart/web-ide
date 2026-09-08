import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { rewriteDeclarationModuleSpecifiers } from '../../scripts/release/declaration-specifiers.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = path.join(repositoryRoot, 'src')
const outputRoot = path.join(repositoryRoot, 'dist')

function rewrite(file, content) {
  return rewriteDeclarationModuleSpecifiers({
    filePath: path.join(outputRoot, file),
    content,
    sourceRoot,
    outputRoot,
  })
}

describe('declaration module specifiers', () => {
  it('maps source files and directory barrels to explicit JavaScript paths', () => {
    expect(rewrite('index.d.ts', [
      "export * from './web-ide';",
      "export { cppRuntimePlugin } from './runtimes/providers';",
      "type Host = import('./web-ide/contracts/host').WebIDEHost;",
    ].join('\n'))).toBe([
      "export * from './web-ide/index.js';",
      "export { cppRuntimePlugin } from './runtimes/providers.js';",
      "type Host = import('./web-ide/contracts/host.js').WebIDEHost;",
    ].join('\n'))
  })

  it('leaves package and explicit runtime specifiers unchanged', () => {
    expect(rewrite('index.d.ts', [
      "import type { ReactNode } from 'react';",
      "export * from './web-ide/index.js';",
    ].join('\n'))).toBe([
      "import type { ReactNode } from 'react';",
      "export * from './web-ide/index.js';",
    ].join('\n'))
  })

  it('rejects private loader queries and missing targets', () => {
    expect(() => rewrite(
      'testing/resources.d.ts',
      "import source from './nova_test.h?raw';",
    )).toThrow(/non-runtime module specifier/u)
    expect(() => rewrite('index.d.ts', "export * from './missing';"))
      .toThrow(/no source target/u)
  })
})

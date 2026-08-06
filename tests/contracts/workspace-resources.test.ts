import { describe, expect, it } from 'vitest'

import type { IDEWorkspaceResourceContribution } from '../../src/web-ide/contracts/contributions'
import {
  mergeWorkspaceFiles,
  workspaceFilesFingerprint,
} from '../../src/web-ide/core/workspace-resources'

describe('workspace resource composition', () => {
  it('merges ordered plugin bundles and gives host-owned files final authority', () => {
    const resources: IDEWorkspaceResourceContribution[] = [
      {
        id: 'first.resources',
        files: {
          '/activity/library.hpp': 'first library',
          '/activity/world.json': 'first world',
        },
      },
      {
        id: 'replacement.resources',
        files: {
          '/activity/world.json': 'replacement world',
          '/activity/readme.txt': 'plugin instructions',
        },
      },
    ]
    const hostFiles = {
      '/activity/world.json': 'host-selected world',
      '/workspace/main.cpp': 'int main() {}',
    }

    const merged = mergeWorkspaceFiles(resources, hostFiles)
    expect(merged).toEqual({
      '/workspace/activity/library.hpp': 'first library',
      '/workspace/activity/world.json': 'host-selected world',
      '/workspace/activity/readme.txt': 'plugin instructions',
      '/workspace/main.cpp': 'int main() {}',
    })
    expect(Object.getPrototypeOf(merged)).toBeNull()
  })

  it('returns a fresh seed and preserves the no-seed standalone case', () => {
    const hostFiles = { '/workspace/main.cpp': 'original' }
    const merged = mergeWorkspaceFiles([], hostFiles)

    expect(mergeWorkspaceFiles([])).toBeUndefined()
    expect(merged).toEqual(hostFiles)
    expect(merged).not.toBe(hostFiles)
  })

  it('stabilizes semantically identical seeds without hiding content changes', () => {
    expect(
      workspaceFilesFingerprint({ '/b.txt': 'b', '/a.txt': 'a' }),
    ).toBe(
      workspaceFilesFingerprint({ '/a.txt': 'a', '/b.txt': 'b' }),
    )
    expect(workspaceFilesFingerprint({ '/a.txt': 'first' })).not.toBe(
      workspaceFilesFingerprint({ '/a.txt': 'second' }),
    )
    expect(workspaceFilesFingerprint()).toBe('')
  })

  it('rejects traversal and safely carries special object-property names', () => {
    expect(() => mergeWorkspaceFiles([], {
      '/workspace/../outside.txt': 'no',
    })).toThrow('not canonical')

    const special = JSON.parse('{"/__proto__/resource.txt":"safe"}') as Record<string, string>
    const merged = mergeWorkspaceFiles([], special)!
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(Object.hasOwn(merged, '/workspace/__proto__/resource.txt')).toBe(true)
    expect(merged['/workspace/__proto__/resource.txt']).toBe('safe')
  })
})

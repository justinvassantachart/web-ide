import { afterEach, describe, expect, it, vi } from 'vitest'

import { hydrateFromOPFS } from '../../src/vfs/opfs-sync'
import { vol } from '../../src/vfs/volume'

const stalePath = '/workspace/stale-hydration.txt'

afterEach(() => {
  vi.unstubAllGlobals()
  if (vol.existsSync(stalePath)) vol.unlinkSync(stalePath)
})

describe('VFS hydration cancellation', () => {
  it('does not materialize an OPFS file after a newer workspace owns the volume', async () => {
    let resolveText!: (text: string) => void
    const text = new Promise<string>((resolve) => {
      resolveText = resolve
    })
    const fileHandle = {
      kind: 'file',
      getFile: async () => ({ text: () => text }),
    }
    const projectDirectory = {
      async *entries() {
        yield ['stale-hydration.txt', fileHandle]
      },
    }
    const projectsDirectory = {
      getDirectoryHandle: async () => projectDirectory,
    }
    const rootDirectory = {
      getDirectoryHandle: async () => projectsDirectory,
    }
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => rootDirectory },
    })

    let current = true
    const hydration = hydrateFromOPFS('old-workspace', () => current)
    await Promise.resolve()
    await Promise.resolve()
    current = false
    resolveText('must not reach the new workspace')
    await hydration

    expect(vol.existsSync(stalePath)).toBe(false)
  })
})

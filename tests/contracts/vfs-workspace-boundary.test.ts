import { describe, expect, it } from 'vitest'

import {
  bootstrapWorkspace,
  getProjectId,
  initVFS,
  readFile,
  setProjectId,
} from '../../src/vfs/volume'

describe('VFS workspace seed boundary', () => {
  it('validates a replacement snapshot before erasing the active workspace', () => {
    const pathAtLimit = `/workspace/${'v'.repeat(1024 - '/workspace/'.length)}`
    const pathOverLimit = `${pathAtLimit}v`
    bootstrapWorkspace({ [pathAtLimit]: 'keep me' })

    expect(() => bootstrapWorkspace({
      '/workspace/replacement.txt': 'must not be written',
      [pathOverLimit]: 'must reject the transaction',
    })).toThrow(/oversized/)
    expect(readFile(pathAtLimit)).toBe('keep me')

    expect(() => bootstrapWorkspace({
      '/workspace/../outside.txt': 'must not be written',
    })).toThrow('not canonical')
    expect(readFile(pathAtLimit)).toBe('keep me')
  })

  it('rejects invalid initialization before switching the persistence namespace', async () => {
    bootstrapWorkspace({ 'safe.txt': 'still here' })
    setProjectId('current-project')

    await expect(initVFS({
      projectId: 'untrusted-project',
      initialFiles: { '../outside.txt': 'must not be written' },
    })).rejects.toThrow('not canonical')

    expect(getProjectId()).toBe('current-project')
    expect(readFile('/workspace/safe.txt')).toBe('still here')
  })
})

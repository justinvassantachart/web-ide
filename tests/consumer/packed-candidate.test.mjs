import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PACKED_CANDIDATE_REFERENCE,
  withVerifiedPackedCandidate,
} from './packed-candidate.mjs'

const temporaryRoots = []

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

async function fixture({
  candidateBytes,
  expectedBytes,
  dependency = PACKED_CANDIDATE_REFERENCE,
  resolved = PACKED_CANDIDATE_REFERENCE,
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'web-ide-candidate-test-'))
  temporaryRoots.push(root)
  const consumerRoot = path.join(root, 'consumer')
  const candidatePath = path.join(root, 'candidate.tgz')
  await mkdir(consumerRoot)
  await Promise.all([
    writeFile(candidatePath, candidateBytes),
    writeFile(
      path.join(consumerRoot, 'package.json'),
      `${JSON.stringify({ dependencies: { 'web-ide': dependency } })}\n`,
    ),
    writeFile(
      path.join(consumerRoot, 'package-lock.json'),
      `${JSON.stringify({
        packages: {
          'node_modules/web-ide': {
            resolved,
            integrity: integrity(expectedBytes),
          },
        },
      })}\n`,
    ),
  ])
  return { candidatePath, consumerRoot }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('packed candidate pre-install verification', () => {
  it('rejects a non-tar candidate before invoking the installer', async () => {
    const options = await fixture({
      candidateBytes: Buffer.from('not a tarball'),
      expectedBytes: Buffer.from('expected release tarball'),
    })
    const install = vi.fn()

    await expect(withVerifiedPackedCandidate(options, install)).rejects.toThrow(
      'Packed candidate integrity mismatch',
    )
    expect(install).not.toHaveBeenCalled()
    await expect(readFile(path.join(options.consumerRoot, 'web-ide.tgz'))).rejects.toThrow()
  })

  it('rejects one-byte candidate corruption before invoking the installer', async () => {
    const expectedBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01])
    const candidateBytes = Buffer.from(expectedBytes)
    candidateBytes[candidateBytes.length - 1] ^= 0x01
    const options = await fixture({ candidateBytes, expectedBytes })
    const install = vi.fn()

    await expect(withVerifiedPackedCandidate(options, install)).rejects.toThrow(
      'Packed candidate integrity mismatch',
    )
    expect(install).not.toHaveBeenCalled()
  })

  it.each([
    ['manifest dependency', { dependency: 'file:other.tgz' }, 'dependency'],
    ['lock resolution', { resolved: 'file:other.tgz' }, 'lock resolution'],
  ])('rejects a non-exact %s before invoking the installer', async (_name, metadata, message) => {
    const candidateBytes = Buffer.from('candidate bytes')
    const options = await fixture({ candidateBytes, expectedBytes: candidateBytes, ...metadata })
    const install = vi.fn()

    await expect(withVerifiedPackedCandidate(options, install)).rejects.toThrow(message)
    expect(install).not.toHaveBeenCalled()
  })

  it('accepts exact metadata and bytes before invoking the installer once', async () => {
    const candidateBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x02])
    const options = await fixture({ candidateBytes, expectedBytes: candidateBytes })
    const install = vi.fn(() => 'installed')

    await expect(withVerifiedPackedCandidate(options, install)).resolves.toBe('installed')
    expect(install).toHaveBeenCalledOnce()
    await expect(readFile(path.join(options.consumerRoot, 'web-ide.tgz'))).resolves.toEqual(
      candidateBytes,
    )
  })

  it('rejects a symlink candidate before invoking the installer', async () => {
    const candidateBytes = Buffer.from('candidate bytes')
    const options = await fixture({ candidateBytes, expectedBytes: candidateBytes })
    const linkPath = path.join(path.dirname(options.candidatePath), 'candidate-link.tgz')
    await symlink(options.candidatePath, linkPath)
    const install = vi.fn()

    await expect(withVerifiedPackedCandidate(
      { ...options, candidatePath: linkPath },
      install,
    )).rejects.toThrow(/non-symlink/u)
    expect(install).not.toHaveBeenCalled()
  })
})

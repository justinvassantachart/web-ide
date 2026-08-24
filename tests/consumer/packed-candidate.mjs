import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { copyFile, lstat, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

export const PACKED_CANDIDATE_REFERENCE = 'file:web-ide.tgz'

function parseJSON(text, source) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Could not parse packed consumer metadata at ${source}`, {
      cause: error,
    })
  }
}

function assertSha512Integrity(integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error('Packed consumer lock must record a SHA-512 candidate integrity')
  }

  const encoded = integrity.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  if (digest.length !== 64 || digest.toString('base64') !== encoded) {
    throw new Error('Packed consumer lock contains an invalid SHA-512 integrity')
  }
  return integrity
}

export async function readPackedCandidateExpectation(consumerRoot) {
  const packagePath = path.join(consumerRoot, 'package.json')
  const lockPath = path.join(consumerRoot, 'package-lock.json')
  const [manifestText, lockText] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(lockPath, 'utf8'),
  ])
  const manifest = parseJSON(manifestText, packagePath)
  const lock = parseJSON(lockText, lockPath)

  if (manifest.dependencies?.['web-ide'] !== PACKED_CANDIDATE_REFERENCE) {
    throw new Error(
      `Packed consumer dependency must be exactly ${PACKED_CANDIDATE_REFERENCE}`,
    )
  }

  const lockedCandidate = lock.packages?.['node_modules/web-ide']
  if (lockedCandidate?.resolved !== PACKED_CANDIDATE_REFERENCE) {
    throw new Error(
      `Packed consumer lock resolution must be exactly ${PACKED_CANDIDATE_REFERENCE}`,
    )
  }

  return assertSha512Integrity(lockedCandidate.integrity)
}

export async function sha512FileIntegrity(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return `sha512-${hash.digest('base64')}`
}

export async function withVerifiedPackedCandidate(
  { candidatePath, consumerRoot },
  consume,
) {
  if (typeof consume !== 'function') {
    throw new TypeError('A packed candidate consumer callback is required')
  }

  const expectedIntegrity = await readPackedCandidateExpectation(consumerRoot)
  const destination = path.join(consumerRoot, 'web-ide.tgz')
  const candidateInfo = await lstat(candidatePath)
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
    throw new Error('Packed candidate must be a regular non-symlink file')
  }
  await copyFile(candidatePath, destination, fsConstants.COPYFILE_EXCL)

  const actualIntegrity = await sha512FileIntegrity(destination)
  if (actualIntegrity !== expectedIntegrity) {
    await rm(destination, { force: true })
    throw new Error(
      `Packed candidate integrity mismatch: expected ${expectedIntegrity}, received ${actualIntegrity}`,
    )
  }

  return consume()
}

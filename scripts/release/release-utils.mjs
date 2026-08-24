import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJSONString } from './canonical-json.mjs'

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

export async function readJSON(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Could not read JSON file ${filePath}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Could not parse JSON file ${filePath}`, { cause: error })
  }
}

export async function readCanonicalJSON(filePath, location = filePath) {
  const bytes = await readFile(filePath)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`Could not parse canonical JSON file ${location}`, { cause: error })
  }
  if (!bytes.equals(Buffer.from(canonicalJSONString(value)))) {
    throw new TypeError(`${location} is not canonical JSON`)
  }
  return value
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha512IntegrityBytes(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export async function hashFile(filePath, algorithm = 'sha256') {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TypeError(`Hashed evidence path must be a regular non-symlink file: ${filePath}`)
  }
  const hash = createHash(algorithm)
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, digest: hash.digest('hex') }
}

export async function readRegularFileSnapshot(filePath, label, maximumBytes = 64 * 1024 * 1024) {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink file`)
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new TypeError(`${label} has an invalid or excessive size`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.length) !== after.size
    ) {
      throw new TypeError(`${label} changed while it was being read`)
    }
    return {
      path: filePath,
      bytes,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
    }
  } finally {
    await handle.close()
  }
}

export async function readExternalRegularFile(filePath, label, maximumBytes = 64 * 1024 * 1024) {
  if (!path.isAbsolute(filePath)) throw new TypeError(`${label} must be absolute`)
  const requested = path.resolve(filePath)
  const requestedInfo = await lstat(requested)
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink file`)
  }
  const canonical = await assertExternalOutputPath(requested, label)
  return await readRegularFileSnapshot(canonical, label, maximumBytes)
}

export function assertExactKeys(value, required, optional, location) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${location} has unknown field ${key}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${location} is missing required field ${key}`)
  }
}

export function assertNonEmptyString(value, location) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${location} must be a non-empty string`)
  }
  return value
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/')
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export async function assertExternalOutputPath(outputPath, label = 'Release output path') {
  if (!path.isAbsolute(outputPath)) throw new TypeError(`${label} must be absolute`)
  const resolved = path.resolve(outputPath)
  if (resolved === repositoryRoot || isPathInside(repositoryRoot, resolved)) {
    throw new TypeError(`${label} must be outside the repository`)
  }
  let existingAncestor = resolved
  for (;;) {
    try {
      await stat(existingAncestor)
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(existingAncestor)
      if (parent === existingAncestor) throw new TypeError(`${label} has no existing ancestor`)
      existingAncestor = parent
    }
  }
  const canonicalAncestor = await realpath(existingAncestor)
  const canonicalResolved = path.resolve(canonicalAncestor, path.relative(existingAncestor, resolved))
  if (canonicalResolved === repositoryRoot || isPathInside(repositoryRoot, canonicalResolved)) {
    throw new TypeError(`${label} resolves inside the repository`)
  }
  return canonicalResolved
}

export async function ensureExternalOutputDirectory(outputDirectory) {
  const resolved = await assertExternalOutputPath(outputDirectory, 'Release output directory')
  await mkdir(resolved, { recursive: true })
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new TypeError(`Release output is not a directory: ${resolved}`)
  const canonical = await realpath(resolved)
  if (canonical === repositoryRoot || isPathInside(repositoryRoot, canonical)) {
    throw new TypeError('Release output directory resolves inside the repository')
  }
  return canonical
}

export async function writeCanonicalJSON(filePath, value) {
  await writeFile(filePath, canonicalJSONString(value), { encoding: 'utf8', flag: 'wx' })
}

export function sortStrings(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

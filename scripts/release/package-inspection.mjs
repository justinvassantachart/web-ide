import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  assertExactKeys,
  assertNonEmptyString,
  sha256Bytes,
  sha512IntegrityBytes,
  sortStrings,
} from './release-utils.mjs'
import { assertNoSecretLikeText } from './secret-patterns.mjs'

const MAX_COMPRESSED_TARBALL_BYTES = 16 * 1024 * 1024
const MAX_UNCOMPRESSED_TARBALL_BYTES = 64 * 1024 * 1024
const MAX_TAR_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_TAR_ENTRIES = 512
const MAX_ARCHIVE_PATH_BYTES = 99
const NPM_PACK_MTIME = '3560116604'
const PACKED_TEXT_FILE_PATTERN = /\.(?:css|d\.ts|js|json|md|txt)$/u
const PACKED_FORBIDDEN_TEXT = [
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//u, 'absolute developer path'],
  [/[A-Za-z]:\\Users\\/u, 'absolute Windows developer path'],
  [/<repository>\//u, 'release provenance placeholder'],
  [/(?:from\s*|import\s*\()\s*['"]@\//u, 'unresolved internal alias import'],
]

function decodeTarText(bytes, location) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`Tar ${location} is not valid UTF-8`, { cause: error })
  }
}

function assertZeroBytes(bytes, location) {
  if (!bytes.every((byte) => byte === 0)) {
    throw new TypeError(`Tar ${location} must contain only zero bytes`)
  }
}

function assertExactBytes(bytes, start, expected, location) {
  const actual = bytes.subarray(start, start + expected.length)
  if (!actual.equals(expected)) throw new TypeError(`Tar ${location} is not canonical`)
}

function tarString(bytes, start, length, location, { allowEmpty = true } = {}) {
  const field = bytes.subarray(start, start + length)
  const nul = field.indexOf(0)
  if (nul === -1) throw new TypeError(`Tar ${location} has no required NUL terminator`)
  assertZeroBytes(field.subarray(nul + 1), `${location} bytes after its NUL terminator`)
  const value = decodeTarText(field.subarray(0, nul), location)
  if (!allowEmpty && value === '') throw new TypeError(`Tar ${location} must not be empty`)
  return value
}

function tarOctal(bytes, start, digits, location, expectedText) {
  const field = bytes.subarray(start, start + digits + 2)
  const digitBytes = field.subarray(0, digits)
  if (
    !digitBytes.every((byte) => byte >= 0x30 && byte <= 0x37)
    || field[digits] !== 0x20
    || field[digits + 1] !== 0
  ) throw new TypeError(`Invalid canonical tar ${location}`)
  const value = digitBytes.toString('ascii')
  if (expectedText !== undefined && value !== expectedText) {
    throw new TypeError(`Tar ${location} differs from the pinned npm pack policy`)
  }
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`Tar ${location} is not a safe integer`)
  return parsed
}

function verifyHeaderChecksum(header, offset) {
  const expected = tarOctal(header, 148, 6, `checksum at byte ${offset}`)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== expected) throw new TypeError(`Tar header checksum mismatch at byte ${offset}`)
}

function assertNoForbiddenText(text, location) {
  assertNoSecretLikeText(text, location)
  for (const [pattern, label] of PACKED_FORBIDDEN_TEXT) {
    if (pattern.test(text)) throw new TypeError(`${location} contains a ${label}`)
  }
}

function assertSafeArchivePath(archivePath) {
  const hasControlCharacter = [...archivePath].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
  if (
    hasControlCharacter
    || Buffer.byteLength(archivePath, 'utf8') > MAX_ARCHIVE_PATH_BYTES
    || archivePath.includes('\\')
    || archivePath.startsWith('/')
  ) {
    throw new TypeError(`Unsafe tar path ${JSON.stringify(archivePath)}`)
  }
  const parts = archivePath.split('/')
  if (parts[0] !== 'package' || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`Tar entry is outside package/: ${JSON.stringify(archivePath)}`)
  }
  if (archivePath.normalize('NFC') !== archivePath) {
    throw new TypeError(`Tar path is not NFC normalized: ${JSON.stringify(archivePath)}`)
  }
  assertNoForbiddenText(archivePath, 'Tar path')
}

export function readPackageTarball(tarballBytes) {
  if (!Buffer.isBuffer(tarballBytes)) throw new TypeError('Package tarball must be a Buffer')
  if (tarballBytes.length === 0 || tarballBytes.length > MAX_COMPRESSED_TARBALL_BYTES) {
    throw new TypeError('Package tarball compressed size exceeds the reviewed limit')
  }
  assertExactBytes(
    tarballBytes,
    0,
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]),
    'gzip header',
  )
  const tar = gunzipSync(tarballBytes, { maxOutputLength: MAX_UNCOMPRESSED_TARBALL_BYTES })
  const canonicalGzip = gzipSync(tar, { level: 9, mtime: 0 })
  canonicalGzip[9] = 0xff
  if (!canonicalGzip.equals(tarballBytes)) {
    throw new TypeError('Package tarball must be one exact canonical npm gzip member')
  }
  if (tar.length % 512 !== 0) throw new TypeError('Tarball byte length is not block-aligned')
  const entries = []
  let offset = 0
  let sawEnd = false
  let headerCount = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset, offset + 1024).every((byte) => byte === 0)) {
        throw new TypeError('Tarball must contain two zero end-marker blocks')
      }
      sawEnd = true
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new TypeError('Tarball contains data after its end marker')
      }
      break
    }
    headerCount += 1
    if (headerCount > MAX_TAR_ENTRIES) {
      throw new TypeError(`Tarball exceeds the reviewed ${MAX_TAR_ENTRIES}-entry limit`)
    }
    verifyHeaderChecksum(header, offset)
    const name = tarString(header, 0, 100, `name at byte ${offset}`, { allowEmpty: false })
    const mode = tarOctal(header, 100, 6, `mode at byte ${offset}`, '000644')
    assertZeroBytes(header.subarray(108, 116), `uid at byte ${offset}`)
    assertZeroBytes(header.subarray(116, 124), `gid at byte ${offset}`)
    const size = tarOctal(header, 124, 10, `size at byte ${offset}`)
    if (size > MAX_TAR_ENTRY_BYTES) {
      throw new TypeError(`Tar entry exceeds the reviewed per-entry size limit at byte ${offset}`)
    }
    tarOctal(header, 136, 10, `mtime at byte ${offset}`, NPM_PACK_MTIME)
    if (header[156] !== 0x30) {
      throw new TypeError(`Forbidden tar entry type ${JSON.stringify(String.fromCharCode(header[156]))} at ${name}`)
    }
    assertZeroBytes(header.subarray(157, 257), `linkname at byte ${offset}`)
    assertExactBytes(header, 257, Buffer.from('ustar\0', 'ascii'), `magic at byte ${offset}`)
    assertExactBytes(header, 263, Buffer.from('00', 'ascii'), `version at byte ${offset}`)
    assertZeroBytes(header.subarray(265, 297), `uname at byte ${offset}`)
    assertZeroBytes(header.subarray(297, 329), `gname at byte ${offset}`)
    tarOctal(header, 329, 6, `devmajor at byte ${offset}`, '000000')
    tarOctal(header, 337, 6, `devminor at byte ${offset}`, '000000')
    assertZeroBytes(header.subarray(345, 500), `prefix at byte ${offset}`)
    assertZeroBytes(header.subarray(500, 512), `reserved header bytes at byte ${offset}`)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new TypeError(`Tar entry exceeds archive at byte ${offset}`)
    const data = tar.subarray(dataStart, dataEnd)
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512
    if (paddedEnd > tar.length) throw new TypeError(`Tar entry padding exceeds archive at byte ${offset}`)
    assertZeroBytes(tar.subarray(dataEnd, paddedEnd), `data padding at byte ${offset}`)
    assertSafeArchivePath(name)
    entries.push({
      archivePath: name,
      path: name.slice('package/'.length),
      type: 'file',
      size,
      mode,
      sha256: sha256Bytes(data),
      bytes: Buffer.from(data),
    })
    offset = paddedEnd
  }
  if (!sawEnd) throw new TypeError('Tarball has no zero end marker')

  const exact = new Set()
  const folded = new Map()
  for (const entry of entries) {
    if (exact.has(entry.path)) throw new TypeError(`Duplicate tar path ${entry.path}`)
    exact.add(entry.path)
    const key = entry.path.normalize('NFC').toLocaleLowerCase('en-US')
    const prior = folded.get(key)
    if (prior && prior !== entry.path) {
      throw new TypeError(`Case-colliding tar paths: ${prior} and ${entry.path}`)
    }
    folded.set(key, entry.path)
  }
  return entries
}

function collectExportTargets(value, location = 'exports') {
  if (typeof value === 'string') return [{ location, target: value }]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${location} contains an unsupported export target`)
  }
  return Object.entries(value).flatMap(([key, nested]) => collectExportTargets(nested, `${location}.${key}`))
}

export function scanPackedEntry(entry) {
  if (!PACKED_TEXT_FILE_PATTERN.test(entry.path)) {
    throw new TypeError(`Packed file type is outside the reviewed text allowlist: ${entry.path}`)
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)
  } catch (error) {
    throw new TypeError(`Packed text file is not valid UTF-8: ${entry.path}`, { cause: error })
  }
  assertNoForbiddenText(text, `Packed ${entry.path}`)
}

export function validateNpmPackResult(packResult, tarballBytes) {
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new TypeError('npm pack JSON must describe exactly one package')
  }
  const item = packResult[0]
  assertExactKeys(
    item,
    ['id', 'name', 'version', 'size', 'unpackedSize', 'shasum', 'integrity', 'filename', 'files', 'entryCount', 'bundled'],
    [],
    'npm pack result',
  )
  for (const field of ['id', 'name', 'version', 'shasum', 'integrity', 'filename']) {
    assertNonEmptyString(item[field], `npm pack result.${field}`)
  }
  if (item.id !== `${item.name}@${item.version}`) throw new TypeError('npm pack id does not match name/version')
  if (item.filename !== pathSafeBasename(item.filename)) throw new TypeError('npm pack filename is unsafe')
  if (!Number.isSafeInteger(item.size) || !Number.isSafeInteger(item.unpackedSize) || !Number.isSafeInteger(item.entryCount)) {
    throw new TypeError('npm pack sizes and entry count must be safe integers')
  }
  if (!/^[a-f0-9]{40}$/u.test(item.shasum)) throw new TypeError('npm pack shasum is malformed')
  if (!Array.isArray(item.files) || !Array.isArray(item.bundled)) {
    throw new TypeError('npm pack files and bundled fields must be arrays')
  }
  if (item.bundled.length !== 0) throw new TypeError('npm pack unexpectedly contains bundledDependencies')
  if (item.size !== tarballBytes.length) throw new TypeError('npm pack byte size does not match tarball')
  const sha1 = createHash('sha1').update(tarballBytes).digest('hex')
  if (item.shasum !== sha1) throw new TypeError('npm pack SHA-1 does not match tarball')
  if (item.integrity !== sha512IntegrityBytes(tarballBytes)) {
    throw new TypeError('npm pack SHA-512 integrity does not match tarball')
  }
  return item
}

function pathSafeBasename(value) {
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return null
  return value
}

export function reinspectPackedPackage(tarballBytes, filename) {
  if (typeof filename !== 'string' || filename !== pathSafeBasename(filename)) {
    throw new TypeError('Candidate package filename is unsafe')
  }
  const entries = readPackageTarball(tarballBytes)
  const files = entries.filter((entry) => entry.type === 'file')
  const manifestEntry = files.find((entry) => entry.path === 'package.json')
  if (!manifestEntry) throw new TypeError('Packed package has no package.json')
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'))
  const packResult = [{
    id: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    size: tarballBytes.length,
    unpackedSize: files.reduce((total, entry) => total + entry.size, 0),
    shasum: createHash('sha1').update(tarballBytes).digest('hex'),
    integrity: sha512IntegrityBytes(tarballBytes),
    filename,
    files: files.map(({ path: filePath, size, mode }) => ({ path: filePath, size, mode })),
    entryCount: files.length,
    bundled: [],
  }]
  return inspectPackedPackage(packResult, tarballBytes)
}

export function inspectPackedPackage(packResult, tarballBytes) {
  const pack = validateNpmPackResult(packResult, tarballBytes)
  const entries = readPackageTarball(tarballBytes)
  const files = entries.filter((entry) => entry.type === 'file')
  const byPath = new Map(files.map((entry) => [entry.path, entry]))
  if (pack.entryCount !== files.length) throw new TypeError('npm pack entry count does not match tar inventory')
  if (pack.unpackedSize !== files.reduce((total, entry) => total + entry.size, 0)) {
    throw new TypeError('npm pack unpacked size does not match tar inventory')
  }
  const npmFiles = pack.files.map((file, index) => {
    assertExactKeys(file, ['path', 'size', 'mode'], [], `npm pack files[${index}]`)
    assertNonEmptyString(file.path, `npm pack files[${index}].path`)
    return file
  })
  const npmPaths = sortStrings(npmFiles.map((file) => file.path))
  const tarPaths = sortStrings(files.map((file) => file.path))
  if (JSON.stringify(npmPaths) !== JSON.stringify(tarPaths)) {
    throw new TypeError('npm pack JSON file list does not match extracted tar inventory')
  }
  for (const file of npmFiles) {
    const entry = byPath.get(file.path)
    if (entry.size !== file.size || entry.mode !== file.mode) {
      throw new TypeError(`npm pack metadata mismatch for ${file.path}`)
    }
  }

  const manifestEntry = byPath.get('package.json')
  if (!manifestEntry) throw new TypeError('Packed package has no package.json')
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'))
  if (manifest.name !== pack.name || manifest.version !== pack.version || manifest.private !== true) {
    throw new TypeError('Packed package identity/private flag does not match npm pack output')
  }
  if (manifest.license !== 'MIT') throw new TypeError('Packed package license must remain MIT')
  if ('publishConfig' in manifest) throw new TypeError('Packed private package must not configure npm publication')
  if ('bundledDependencies' in manifest || 'bundleDependencies' in manifest) {
    throw new TypeError('Packed package must not declare bundled dependencies')
  }
  const expectedFiles = [
    'dist',
    'docs',
    'README.md',
    'LICENSE.md',
    'THIRD_PARTY_LICENSES.txt',
    'THIRD_PARTY_NOTICES.md',
  ]
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw new TypeError('Packed package files allowlist changed from the reviewed release contract')
  }
  const allowedTopLevelFiles = new Set(['package.json', ...expectedFiles.filter((entry) => !['dist', 'docs'].includes(entry))])
  for (const file of files) {
    if (!file.path.startsWith('dist/') && !file.path.startsWith('docs/') && !allowedTopLevelFiles.has(file.path)) {
      throw new TypeError(`Packed file is outside the reviewed allowlist: ${file.path}`)
    }
  }
  for (const required of ['LICENSE.md', 'THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.md']) {
    if (!byPath.has(required)) throw new TypeError(`Packed package is missing ${required}`)
  }
  for (const { location, target } of collectExportTargets(manifest.exports)) {
    if (!target.startsWith('./') || target.includes('..') || target.includes('\\')) {
      throw new TypeError(`${location} has unsafe target ${JSON.stringify(target)}`)
    }
    if (!byPath.has(target.slice(2))) throw new TypeError(`${location} targets missing packed file ${target}`)
  }
  for (const entry of files) scanPackedEntry(entry)

  return {
    schemaVersion: 1,
    package: `${pack.name}@${pack.version}`,
    result: 'pass',
    tarball: {
      filename: pack.filename,
      size: tarballBytes.length,
      sha256: sha256Bytes(tarballBytes),
      sha512Integrity: pack.integrity,
    },
    checks: {
      npmPackJsonMatched: true,
      regularFilesOnly: true,
      pathsSafeAndCaseUnique: true,
      privatePackage: true,
      exportsResolved: true,
      licenseFilesPresent: true,
      internalPathAndSecretScanPassed: true,
      bundledDependenciesAbsent: true,
    },
    files: files
      .map(({ path, size, mode, sha256 }) => ({ path, size, mode, sha256 }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  }
}

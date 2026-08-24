import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertNoSecretLikeText } from './secret-patterns.mjs'

const PLACEHOLDERS = Object.freeze({
  repository: '<repository-root>',
  home: '<home>',
  candidate: '<web-candidate>',
  temporary: '<execution-root>',
})

const SUPPORTED_PATH_PLACEHOLDERS = new Set([
  ...Object.values(PLACEHOLDERS),
  '<gate-staging-root>',
  '<karel-candidate>',
  '<karel-candidate-state>',
  '<web-artifact-manifest>',
  '<web-candidate-state>',
  '<workspace-root>',
])

const LOCAL_PATH_PATTERNS = Object.freeze([
  /\/(?:Users|home|root|tmp|Volumes)(?:\/|$)/gimu,
  /\/(?:private\/(?:tmp|var)|var\/folders)(?:\/|$)/gimu,
  /(?:^|[\s("'`=:\u005b{@,])[A-Za-z]:[\\/]/gimu,
  /(?:^|[\s("'`=:\u005b{@,])(?:\\\\|\/\/)[^\s\\/<>:"'`]+[\\/][^\s<>:"'`]+/gimu,
  /(?:^|[\s("'`=:\u005b{@,])~[\\/]/gimu,
  /file:(?:[\\/]|%(?:2f|5c))/gimu,
  /[A-Za-z]%3a%(?:2f|5c)/gimu,
  /%(?:2f|5c)/gimu,
])

const PATH_PLACEHOLDER_PATTERN = /<[a-z][a-z0-9-]*>/gu
const FILE_PLACEHOLDER_PATTERN = /file:(?:\/\/)?(<[a-z][a-z0-9-]*>)/giu

const TERMINAL_OSC_PATTERN = new RegExp(
  String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  'gu',
)
const TERMINAL_CSI_PATTERN = new RegExp(
  String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
  'gu',
)

function decodeUtf8(bytes, location) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`${location} must be UTF-8 text`, { cause: error })
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function stripTerminalEscapes(text) {
  return text
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
}

function inspectableText(text) {
  return stripTerminalEscapes(text).replaceAll('\\/', '/')
}

function rootAliases(root) {
  const aliases = new Set([root])
  if (root.startsWith('/var/') || root === '/var') aliases.add(`/private${root}`)
  if (root.startsWith('/tmp/') || root === '/tmp') aliases.add(`/private${root}`)
  if (root.startsWith('/private/var/')) aliases.add(root.slice('/private'.length))
  if (root.startsWith('/private/tmp/')) aliases.add(root.slice('/private'.length))
  return aliases
}

function rootRepresentations(root) {
  const representations = new Map()
  const add = (value, fileEncoding = false) => {
    const existing = representations.get(value)
    if (existing !== undefined && existing !== fileEncoding) {
      throw new TypeError('Validation-log path representation has conflicting encodings')
    }
    representations.set(value, fileEncoding)
  }
  const addPercentEncoded = (value, fileEncoding = false) => {
    const encoded = encodeURIComponent(value)
    add(encoded, fileEncoding)
    add(encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()), fileEncoding)
  }
  for (const alias of rootAliases(root)) {
    const slashForm = alias.replaceAll('\\', '/')
    add(alias)
    add(slashForm)
    add(slashForm.replaceAll('/', '\\/'))
    addPercentEncoded(slashForm)
    const fileUrl = pathToFileURL(alias).href.replace(/\/$/u, '')
    add(fileUrl, true)
    add(fileUrl.replaceAll('/', '\\/'), true)
    const encodedFilePath = encodeURIComponent(fileUrl.slice('file:'.length))
    add(`file:${encodedFilePath}`, true)
    add(`file:${encodedFilePath.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase())}`, true)
    addPercentEncoded(fileUrl, true)
  }
  return representations
}

function validateRoots(roots) {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new TypeError('Validation-log normalization roots must be an object')
  }
  const expectedKeys = Object.keys(PLACEHOLDERS)
  const actualKeys = Object.keys(roots)
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => !expectedKeys.includes(key))
  ) throw new TypeError('Validation-log normalization roots must contain the exact supported root kinds')

  const records = []
  for (const kind of expectedKeys) {
    const values = roots[kind]
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError(`Validation-log ${kind} roots must be a nonempty array`)
    }
    for (const value of values) {
      if (
        typeof value !== 'string'
        || value.length === 0
        || value.includes('\0')
        || !path.isAbsolute(value)
      ) throw new TypeError(`Validation-log ${kind} root must be an absolute path`)
      const resolved = path.resolve(value)
      if (resolved === path.parse(resolved).root) {
        throw new TypeError(`Validation-log ${kind} root must not be a filesystem root`)
      }
      const caseInsensitive = process.platform === 'win32'
      for (const [representation, fileEncoding] of rootRepresentations(resolved)) {
        records.push({
          kind,
          placeholder: PLACEHOLDERS[kind],
          representation,
          fileEncoding,
          caseInsensitive,
        })
      }
    }
  }
  records.sort((left, right) => (
    right.representation.length - left.representation.length
    || expectedKeys.indexOf(left.kind) - expectedKeys.indexOf(right.kind)
    || (left.representation < right.representation ? -1 : left.representation > right.representation ? 1 : 0)
  ))
  return records.filter((record, index) => !records.slice(0, index).some((prior) => (
    prior.representation === record.representation
  )))
}

function replaceKnownRoots(text, records) {
  let normalized = text
  for (const record of records) {
    const replacement = record.fileEncoding
      ? `file:${record.placeholder}`
      : record.placeholder
    normalized = normalized.replace(
      new RegExp(
        `(?<![A-Za-z0-9._~%+\\/\\\\-])${escapeRegExp(record.representation)}(?![A-Za-z0-9._~%+-])`,
        record.caseInsensitive ? 'giu' : 'gu',
      ),
      replacement,
    )
  }
  return normalized
}

function isPathBoundaryBefore(character) {
  return character === undefined || !/[A-Za-z0-9._~%+\\/-]/u.test(character)
}

function isPathBoundaryAfter(character) {
  return character === undefined
    || /\s/u.test(character)
    || `"'\`,:;?()[]{}<>\\/`.includes(character)
}

function assertPlaceholderBoundaries(text) {
  for (const match of text.matchAll(PATH_PLACEHOLDER_PATTERN)) {
    if (!SUPPORTED_PATH_PLACEHOLDERS.has(match[0])) continue
    const before = match.index === 0 ? undefined : text[match.index - 1]
    const afterIndex = match.index + match[0].length
    const after = afterIndex === text.length ? undefined : text[afterIndex]
    if (!isPathBoundaryBefore(before) || !isPathBoundaryAfter(after)) {
      throw new TypeError('Validation log embeds a path placeholder in another token')
    }
  }
  for (const match of text.matchAll(FILE_PLACEHOLDER_PATTERN)) {
    if (!SUPPORTED_PATH_PLACEHOLDERS.has(match[1])) {
      throw new TypeError('Validation log contains an unknown file-path placeholder')
    }
    const before = match.index === 0 ? undefined : text[match.index - 1]
    if (!isPathBoundaryBefore(before)) {
      throw new TypeError('Validation log embeds a file-path placeholder in another token')
    }
  }
}

function assertNoUnsafeLocalPaths(text, records = []) {
  const inspectable = inspectableText(text)
  for (const record of records) {
    if (inspectable.includes(inspectableText(record.representation))) {
      throw new TypeError(`Normalized validation log retains an unsafe ${record.kind} path`)
    }
  }
  for (const pattern of LOCAL_PATH_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(inspectable)) {
      throw new TypeError('Normalized validation log retains an unsafe local path form')
    }
  }
  assertPlaceholderBoundaries(inspectable)
  return inspectable
}

function fileIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
  }
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
  )
}

function assertExpectedFileIdentity(identity, location) {
  if (
    !identity
    || typeof identity !== 'object'
    || Array.isArray(identity)
    || typeof identity.dev !== 'bigint'
    || typeof identity.ino !== 'bigint'
    || typeof identity.size !== 'bigint'
    || typeof identity.mtimeNs !== 'bigint'
  ) throw new TypeError(`${location} identity is invalid`)
}

async function pathState(target) {
  try {
    return await lstat(target, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertRegularFileIdentity(info, expected, location) {
  if (
    !info
    || !info.isFile()
    || info.isSymbolicLink()
    || !sameFileIdentity(fileIdentity(info), expected)
  ) throw new TypeError(`${location} identity changed during normalized-log publication`)
}

function assertTrustedDirectory(info, location) {
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${location} must be a plain directory`)
  }
  if (process.platform !== 'win32') {
    if ((info.mode & 0o022n) !== 0n) {
      throw new TypeError(`${location} must not be group- or world-writable`)
    }
    if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
      throw new TypeError(`${location} must be owned by the current user`)
    }
  }
}

function normalizationHooks(hooks = {}) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('Validation-log normalization hooks must be an object')
  }
  const keys = Object.keys(hooks)
  if (keys.some((key) => key !== 'beforePublish')) {
    throw new TypeError(`Validation-log normalization hooks contain an unknown field: ${keys.join(', ')}`)
  }
  if (hooks.beforePublish !== undefined && typeof hooks.beforePublish !== 'function') {
    throw new TypeError('Validation-log before-publish hook must be a function')
  }
  return hooks
}

async function unlinkOwnedPath(target, expected, location, { allowAbsent = false } = {}) {
  const current = await pathState(target)
  if (!current && allowAbsent) return
  assertRegularFileIdentity(current, expected, location)
  await unlink(target)
}

async function closeHandle(handle, errors, location) {
  if (!handle) return
  try {
    await handle.close()
  } catch (error) {
    errors.push(new Error(`${location} close failed`, { cause: error }))
  }
}

async function assertPinnedDirectory(directory, handle, expected) {
  const [fromHandle, fromPath] = await Promise.all([
    handle.stat({ bigint: true }),
    pathState(directory),
  ])
  if (
    !fromPath
    || fromHandle.dev !== expected.dev
    || fromHandle.ino !== expected.ino
    || fromPath.dev !== expected.dev
    || fromPath.ino !== expected.ino
  ) throw new TypeError('Validation-log publication directory identity changed')
  assertTrustedDirectory(fromHandle, 'Validation-log publication directory')
  assertTrustedDirectory(fromPath, 'Validation-log publication directory')
}

export function normalizeValidationGateLog(bytes, { roots, receiptFooter }) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Validation gate log bytes must be a Uint8Array')
  }
  if (typeof receiptFooter !== 'string' || receiptFooter.length === 0) {
    throw new TypeError('Validation gate receipt footer must be a nonempty string')
  }
  const text = decodeUtf8(bytes, 'Validation gate log')
  if (!text.endsWith(receiptFooter)) {
    throw new TypeError('Validation gate receipt footer is missing, changed, or not final')
  }
  const records = validateRoots(roots)
  const body = text.slice(0, -receiptFooter.length)
  const normalizedBody = replaceKnownRoots(body, records)
  assertNoUnsafeLocalPaths(normalizedBody, records)
  const normalized = `${normalizedBody}${receiptFooter}`
  if (!normalized.endsWith(receiptFooter)) {
    throw new TypeError('Validation gate receipt footer changed during log normalization')
  }
  return Buffer.from(normalized)
}

export async function normalizeValidationGateLogFile({
  rawLogPath,
  outputPath,
  expectedRawIdentity,
  maximumBytes,
  roots,
  receiptFooter,
  hooks,
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('Validation gate normalized-log byte limit must be a positive safe integer')
  }
  if (
    typeof rawLogPath !== 'string'
    || typeof outputPath !== 'string'
    || !path.isAbsolute(rawLogPath)
    || !path.isAbsolute(outputPath)
    || path.dirname(rawLogPath) !== path.dirname(outputPath)
    || rawLogPath === outputPath
  ) throw new TypeError('Validation gate raw and output logs must be distinct paths in one directory')
  assertExpectedFileIdentity(expectedRawIdentity, 'Validation gate raw log')
  const validatedHooks = normalizationHooks(hooks)
  const directory = path.dirname(rawLogPath)
  const directoryPathInfo = await lstat(directory, { bigint: true })
  assertTrustedDirectory(directoryPathInfo, 'Validation-log publication directory')
  let directoryHandle = await open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const directoryHandleInfo = await directoryHandle.stat({ bigint: true })
    if (
      directoryHandleInfo.dev !== directoryPathInfo.dev
      || directoryHandleInfo.ino !== directoryPathInfo.ino
    ) throw new TypeError('Validation-log publication directory identity changed while it was opened')
  } catch (error) {
    const failedDirectoryHandle = directoryHandle
    directoryHandle = undefined
    await failedDirectoryHandle.close()
    throw error
  }

  let readHandle
  let normalizedHandle
  let normalizedIdentity
  let outputIdentity
  let completed = false
  const normalizedPath = path.join(
    directory,
    `.${path.basename(outputPath)}.normalized-${randomUUID()}`,
  )
  let result
  let operationError
  try {
    readHandle = await open(
      rawLogPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const before = await readHandle.stat({ bigint: true })
    assertRegularFileIdentity(before, expectedRawIdentity, 'Validation gate raw log')
    if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new TypeError('Validation gate raw log must be a bounded regular file')
    }
    const bytes = await readHandle.readFile()
    const after = await readHandle.stat({ bigint: true })
    assertRegularFileIdentity(after, expectedRawIdentity, 'Validation gate raw log')
    if (BigInt(bytes.length) !== expectedRawIdentity.size) {
      throw new TypeError('Validation gate raw log changed while it was read')
    }

    const normalized = normalizeValidationGateLog(bytes, { roots, receiptFooter })
    if (normalized.length <= 0 || normalized.length > maximumBytes) {
      throw new TypeError('Normalized validation gate log exceeds its byte limit')
    }
    const text = decodeValidationLog(normalized, path.basename(outputPath))
    normalizedHandle = await open(normalizedPath, 'wx', 0o600)
    await normalizedHandle.writeFile(normalized)
    await normalizedHandle.sync()
    const normalizedInfo = await normalizedHandle.stat({ bigint: true })
    if (!normalizedInfo.isFile() || normalizedInfo.size !== BigInt(normalized.length)) {
      throw new TypeError('Normalized validation gate log write was incomplete')
    }
    normalizedIdentity = fileIdentity(normalizedInfo)

    if (validatedHooks.beforePublish) {
      await validatedHooks.beforePublish({
        rawLogPath,
        normalizedPath,
        outputPath,
      })
    }

    await assertPinnedDirectory(directory, directoryHandle, directoryPathInfo)
    assertRegularFileIdentity(
      await readHandle.stat({ bigint: true }),
      expectedRawIdentity,
      'Open validation gate raw log',
    )
    assertRegularFileIdentity(
      await pathState(rawLogPath),
      expectedRawIdentity,
      'Validation gate raw log path',
    )
    assertRegularFileIdentity(
      await normalizedHandle.stat({ bigint: true }),
      normalizedIdentity,
      'Open normalized validation gate log',
    )
    assertRegularFileIdentity(
      await pathState(normalizedPath),
      normalizedIdentity,
      'Normalized validation gate log path',
    )

    await link(normalizedPath, outputPath)
    outputIdentity = normalizedIdentity
    assertRegularFileIdentity(
      await pathState(outputPath),
      outputIdentity,
      'Published validation gate log',
    )
    assertRegularFileIdentity(
      await pathState(normalizedPath),
      normalizedIdentity,
      'Normalized validation gate log source',
    )
    assertRegularFileIdentity(
      await normalizedHandle.stat({ bigint: true }),
      normalizedIdentity,
      'Open normalized validation gate log',
    )
    await assertPinnedDirectory(directory, directoryHandle, directoryPathInfo)

    const closeErrors = []
    await closeHandle(readHandle, closeErrors, 'Validation gate raw log')
    readHandle = undefined
    await closeHandle(normalizedHandle, closeErrors, 'Normalized validation gate log')
    normalizedHandle = undefined
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'Validation gate log handles failed to close')
    }
    await unlinkOwnedPath(rawLogPath, expectedRawIdentity, 'Validation gate raw log')
    await unlinkOwnedPath(normalizedPath, normalizedIdentity, 'Normalized validation gate log source')
    assertRegularFileIdentity(
      await pathState(outputPath),
      outputIdentity,
      'Published validation gate log',
    )
    await assertPinnedDirectory(directory, directoryHandle, directoryPathInfo)
    const completedDirectoryHandle = directoryHandle
    directoryHandle = undefined
    await completedDirectoryHandle.close()
    completed = true
    result = {
      bytes: normalized,
      size: normalized.length,
      text,
      fileIdentity: outputIdentity,
    }
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  await closeHandle(readHandle, cleanupErrors, 'Validation gate raw log')
  await closeHandle(normalizedHandle, cleanupErrors, 'Normalized validation gate log')
  if (!completed) {
    if (outputIdentity) {
      try {
        await unlinkOwnedPath(
          outputPath,
          outputIdentity,
          'Incomplete published validation gate log',
          { allowAbsent: true },
        )
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (normalizedIdentity) {
      try {
        await unlinkOwnedPath(
          normalizedPath,
          normalizedIdentity,
          'Incomplete normalized validation gate log',
          { allowAbsent: true },
        )
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await unlinkOwnedPath(
        rawLogPath,
        expectedRawIdentity,
        'Incomplete validation gate raw log',
        { allowAbsent: true },
      )
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  await closeHandle(directoryHandle, cleanupErrors, 'Validation-log publication directory')
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      'Validation gate normalized-log publication and cleanup failed',
    )
  }
  if (operationError) throw operationError
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Validation gate normalized-log cleanup failed')
  }
  return result
}

export async function removeOwnedValidationGateLog(logPath, expectedIdentity) {
  assertExpectedFileIdentity(expectedIdentity, 'Published validation gate log')
  const directory = path.dirname(logPath)
  const info = await lstat(directory, { bigint: true })
  assertTrustedDirectory(info, 'Validation-log publication directory')
  await unlinkOwnedPath(
    logPath,
    expectedIdentity,
    'Published validation gate log',
    { allowAbsent: true },
  )
}

export async function assertTrustedValidationLogDirectory(logPath) {
  if (typeof logPath !== 'string' || !path.isAbsolute(logPath)) {
    throw new TypeError('Validation gate log path must be absolute')
  }
  const info = await lstat(path.dirname(logPath), { bigint: true })
  assertTrustedDirectory(info, 'Validation-log publication directory')
}

export function decodeValidationLog(bytes, fileName) {
  const text = decodeUtf8(bytes, `Validation log ${fileName}`)
  const inspectable = assertNoUnsafeLocalPaths(text)
  assertNoSecretLikeText(inspectable, `Validation log ${fileName}`)
  return text
}

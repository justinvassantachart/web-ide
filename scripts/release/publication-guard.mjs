import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import { hashFile, sha256Bytes, sortStrings } from './release-utils.mjs'

export function assertCanonicalSnapshotUnchanged(expected, actual, location) {
  if (canonicalJSONString(actual) !== canonicalJSONString(expected)) {
    throw new TypeError(`${location} changed during release evidence generation`)
  }
}

export function assertPublicationInventory(expected, actual, location) {
  if (!expected || canonicalJSONString(actual) !== canonicalJSONString(expected)) {
    throw new TypeError(`${location} changed before transactional publication`)
  }
}

export async function snapshotExactFlatDirectory(directory, expectedFileNames, location) {
  const expected = sortStrings(expectedFileNames)
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw new TypeError(`${location} expected file inventory must be non-empty and unique`)
  }
  for (const fileName of expected) {
    if (fileName !== path.basename(fileName) || fileName === '.' || fileName === '..') {
      throw new TypeError(`${location} expected file inventory contains an unsafe filename`)
    }
  }
  const actual = sortStrings(await readdir(directory))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${location} has missing or unexpected files`)
  }
  const records = []
  for (const fileName of expected) {
    const { size, digest } = await hashFile(path.join(directory, fileName))
    records.push({ fileName, size, sha256: digest })
  }
  return {
    records,
    digest: sha256Bytes(Buffer.from(canonicalJSONString(records))),
  }
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { assertExactKeys } from './release-utils.mjs'

export const RECEIPT_PROFILE_PATH = 'dist/cpp-cache-receipt-v1/profile.json'
const directory = 'dist/cpp-cache-receipt-v1'
const names = { compiler: 'llvm.core.wasm', sysroot: 'llvm-resources.tar.gz', notices: 'THIRD_PARTY_NOTICES.txt', provenance: 'provenance.json' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

/** This pins reviewed package contents for release verification only. It cannot
 * grant compiler capabilities: Engine uses its private build-fixed manifest. */
export function validateReceiptToolchainInput(value, location = 'receiptToolchain') {
  assertExactKeys(value, ['profile', 'profilePath', 'profileSha256'], [], location)
  assert.equal(value.profile, 'cache-receipt-v1', location + '.profile')
  assert.equal(value.profilePath, RECEIPT_PROFILE_PATH, location + '.profilePath')
  assert(digest(value.profileSha256), location + '.profileSha256 must be lowercase SHA-256')
  return value
}

async function regularFile(root, relative) {
  const parts = relative.split('/')
  assert(parts.every(part => part && part !== '.' && part !== '..'))
  for (let index = 1; index <= parts.length; index++) {
    const info = await lstat(path.join(root, ...parts.slice(0, index)))
    assert(!info.isSymbolicLink() && (index === parts.length ? info.isFile() : info.isDirectory()),
      'Receipt input is not a regular package file: ' + relative)
  }
  return readFile(path.join(root, relative))
}

export async function verifyInstalledReceiptToolchain(packageRoot, expected) {
  if (!expected) {
    // A legacy release input must not silently accept an activated asset set.
    try { await lstat(path.join(packageRoot, directory)) }
    catch (error) { if (error.code === 'ENOENT') return { profile: 'legacy' }; throw error }
    throw new Error('Receipt assets present without a reviewed release input')
  }
  validateReceiptToolchainInput(expected)
  const profileBytes = await regularFile(packageRoot, expected.profilePath)
  assert.equal(sha(profileBytes), expected.profileSha256, 'Installed receipt profile digest mismatch')
  const profile = JSON.parse(profileBytes)
  assertExactKeys(profile, ['schemaVersion', 'profile', 'capability', 'engineAbi', 'transportAbi', 'exceptionsSha256',
    'compiler', 'sysroot', 'notices', 'provenance', 'source', 'acceptance', 'release'], [], 'installed receipt profile')
  assert.equal(profile.schemaVersion, 1)
  assert.equal(profile.profile, 'cache-receipt-v1')
  assert.equal(profile.capability, 'webide-object-cache-v1')
  assert.equal(profile.engineAbi, 'wasm32-wasip1/c++23/legacy-eh/receipt-v1')
  assert.equal(profile.transportAbi, 'webide_compiler.cache_receipt_v1(i32,i32)->i32')
  assert.equal(profile.exceptionsSha256, '20986166552953de0e3ca5c1e9f341e7aec8b9ba54dcb244d0d2b2f9ca843ab4')
  assert.deepEqual((await readdir(path.join(packageRoot, directory))).sort(), ['profile.json', ...Object.values(names)].sort(),
    'Receipt directory must contain exactly the reviewed four assets and profile')
  const assets = {}
  for (const [role, name] of Object.entries(names)) {
    const descriptor = profile[role]
    assertExactKeys(descriptor, ['name', 'byteLength', 'sha256', ...(role === 'sysroot' ? ['tarByteLength', 'tarSha256'] : [])], [], role)
    assert.equal(descriptor.name, name, 'Unexpected receipt member name')
    const limit = role === 'compiler' ? 96 * 1024 * 1024 : role === 'sysroot' ? 32 * 1024 * 1024 : 4 * 1024 * 1024
    assert(Number.isSafeInteger(descriptor.byteLength) && descriptor.byteLength > 0 && descriptor.byteLength <= limit)
    assert(digest(descriptor.sha256))
    const bytes = await regularFile(packageRoot, directory + '/' + name)
    assert.equal(bytes.length, descriptor.byteLength, role + ' byte length mismatch')
    assert.equal(sha(bytes), descriptor.sha256, role + ' digest mismatch')
    if (role === 'sysroot') {
      assert(Number.isSafeInteger(descriptor.tarByteLength) && descriptor.tarByteLength > 0 && descriptor.tarByteLength <= 256 * 1024 * 1024)
      assert(digest(descriptor.tarSha256))
      const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 })
      assert.equal(tar.length, descriptor.tarByteLength, 'Decompressed sysroot byte length mismatch')
      assert.equal(sha(tar), descriptor.tarSha256, 'Decompressed sysroot digest mismatch')
    }
    assets[role] = { path: directory + '/' + name, byteLength: bytes.length, sha256: sha(bytes) }
  }
  return { profile: profile.profile, profileSha256: expected.profileSha256, assets }
}

/** Run after the actual clean installed consumer's Vite build. This proves the
 * bundler emitted these exact bytes, not just that npm installed them. */
export async function verifyReceiptConsumerEmission(outputRoot, installed) {
  if (installed.profile === 'legacy') return { profile: 'legacy', checked: false }
  const files = []
  async function walk(root, prefix = '') {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await walk(path.join(root, entry.name), relative + '/')
      else {
        assert(entry.isFile(), 'Non-regular consumer output: ' + relative)
        const bytes = await readFile(path.join(root, entry.name))
        files.push({ path: relative, bytes, sha256: sha(bytes) })
      }
    }
  }
  await walk(outputRoot)
  const modules = files.filter(file => /\.(?:m?js)$/u.test(file.path)).map(file => file.bytes.toString('utf8')).join('\n')
  const emitted = {}
  for (const role of ['compiler', 'sysroot']) {
    const expected = installed.assets[role]
    const matches = files.filter(file => file.sha256 === expected.sha256 && file.bytes.length === expected.byteLength)
    assert.equal(matches.length, 1, role + ' must be emitted as one byte-exact consumer asset')
    assert(modules.includes(path.basename(matches[0].path)), role + ' emitted asset is not referenced by bundled JavaScript')
    assert(!modules.includes('./' + expected.path.slice('dist/'.length)), role + ' still references an un-emitted package-relative URL')
    emitted[role] = { path: matches[0].path, sha256: matches[0].sha256, byteLength: matches[0].bytes.length }
  }
  return { profile: installed.profile, checked: true, emitted }
}

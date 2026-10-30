import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { validateReceiptToolchainInput, verifyInstalledReceiptToolchain, verifyReceiptConsumerEmission, RECEIPT_PROFILE_PATH } from '../../scripts/release/receipt-toolchain.mjs'
import { loadEngineForkInput, validateEngineForkInput } from '../../scripts/release/engine-fork-input.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(change) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'web-ide-receipt-consumer-')))
  temporary.push(root)
  const directory = path.join(root, 'engine/dist/cpp-cache-receipt-v1')
  await mkdir(directory, { recursive: true })
  // Transport-only fixtures. These bytes neither implement a compiler nor
  // assert receipt capability; the test concerns package/emission integrity.
  const tar = Buffer.from('synthetic sysroot transport fixture')
  const bytes = { compiler: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), sysroot: gzipSync(tar), notices: Buffer.from('synthetic notices'), provenance: Buffer.from('{}') }
  const names = { compiler: 'llvm.core.wasm', sysroot: 'llvm-resources.tar.gz', notices: 'THIRD_PARTY_NOTICES.txt', provenance: 'provenance.json' }
  const profile = { schemaVersion: 1, profile: 'cache-receipt-v1', capability: 'webide-object-cache-v1', engineAbi: 'wasm32-wasip1/c++23/legacy-eh/receipt-v1',
    transportAbi: 'webide_compiler.cache_receipt_v1(i32,i32)->i32', exceptionsSha256: '20986166552953de0e3ca5c1e9f341e7aec8b9ba54dcb244d0d2b2f9ca843ab4', source: {}, acceptance: {}, release: {} }
  for (const [role, data] of Object.entries(bytes)) {
    profile[role] = { name: names[role], sha256: sha(data), byteLength: data.length }
    await writeFile(path.join(directory, names[role]), data)
  }
  Object.assign(profile.sysroot, { tarByteLength: tar.length, tarSha256: sha(tar) })
  change?.(profile)
  const profileBytes = JSON.stringify(profile)
  await writeFile(path.join(directory, 'profile.json'), profileBytes)
  const expected = { profile: 'cache-receipt-v1', profilePath: RECEIPT_PROFILE_PATH, profileSha256: sha(profileBytes) }
  return { root, directory, packageRoot: path.join(root, 'engine'), expected, bytes }
}

describe('receipt package consumer release gate (synthetic transport only)', () => {
  it('preserves the released legacy input and accepts an additive exact receipt identity', async () => {
    const input = await loadEngineForkInput()
    expect(validateEngineForkInput(input)).toEqual(input)
    const { expected } = await fixture()
    expect(validateEngineForkInput({ ...input, engine: { ...input.engine, receiptToolchain: expected } }).engine.receiptToolchain).toEqual(expected)
    expect(() => validateReceiptToolchainInput({ ...expected, profilePath: '../compiler.wasm' })).toThrow()
    expect(() => validateReceiptToolchainInput({ ...expected, compilerSha256: 'a'.repeat(64) })).toThrow()
  })
  it('verifies all four installed assets and the decompressed sysroot', async () => {
    const value = await fixture()
    expect(Object.keys((await verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).assets).sort()).toEqual(['compiler', 'notices', 'provenance', 'sysroot'])
    await expect(verifyInstalledReceiptToolchain(value.packageRoot)).rejects.toThrow('without a reviewed')
    await rm(value.directory, { recursive: true })
    expect(await verifyInstalledReceiptToolchain(value.packageRoot)).toEqual({ profile: 'legacy' })
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).rejects.toThrow()
  })
  it.each(['compiler', 'sysroot', 'notices', 'provenance'])('rejects corrupt %s bytes', async role => {
    const value = await fixture(), profile = JSON.parse(await readFile(path.join(value.directory, 'profile.json')))
    await writeFile(path.join(value.directory, profile[role].name), 'corrupt')
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).rejects.toThrow('mismatch')
  })
  it.each([
    profile => { profile.engineAbi = 'different' },
    profile => { profile.capability = 'different' },
    profile => { profile.compiler.name = '../llvm.core.wasm' },
    profile => { profile.sysroot.tarSha256 = '0'.repeat(64) },
    profile => { profile.fifthAsset = {} },
  ])('rejects changed ABI, capability, member set, paths or inner bytes', async change => {
    const value = await fixture(change)
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).rejects.toThrow()
  })
  it('rejects profile mismatch, missing assets and symlinked inputs', async () => {
    const value = await fixture()
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, { ...value.expected, profileSha256: 'a'.repeat(64) })).rejects.toThrow('profile digest')
    await rm(path.join(value.directory, 'llvm.core.wasm'))
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).rejects.toThrow('exactly')
    const external = path.join(value.root, 'external.wasm')
    await writeFile(external, value.bytes.compiler)
    await symlink(external, path.join(value.directory, 'llvm.core.wasm'))
    await expect(verifyInstalledReceiptToolchain(value.packageRoot, value.expected)).rejects.toThrow('regular package file')
  })
  it('checks actual Vite consumer emission and rejects missing, altered or inline assets', async () => {
    const value = await fixture(), installed = await verifyInstalledReceiptToolchain(value.packageRoot, value.expected)
    await writeFile(path.join(value.root, 'index.html'), '<script type="module" src="/main.js"></script>')
    await writeFile(path.join(value.root, 'main.js'), `document.body.textContent = JSON.stringify([new URL('./engine/dist/cpp-cache-receipt-v1/llvm.core.wasm', import.meta.url).href, new URL('./engine/dist/cpp-cache-receipt-v1/llvm-resources.tar.gz', import.meta.url).href]);`)
    const output = path.join(value.root, 'dist')
    await build({ configFile: false, root: value.root, logLevel: 'silent', build: { outDir: output, assetsInlineLimit: 0 } })
    const result = await verifyReceiptConsumerEmission(output, installed)
    expect(result.checked).toBe(true)
    await writeFile(path.join(output, result.emitted.compiler.path), 'different')
    await expect(verifyReceiptConsumerEmission(output, installed)).rejects.toThrow('byte-exact')
    await build({ configFile: false, root: value.root, logLevel: 'silent', build: { outDir: output } })
    await expect(verifyReceiptConsumerEmission(output, installed)).rejects.toThrow('byte-exact')
  })
})

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { run } from '../../scripts/release/process-utils.mjs'
import { PREFLIGHT_ENGINE_VARIABLE, rejectPreflightEngineCandidate, seedPreflightEngineCache, validatePreflightEngineReceipt, verifyInstalledPreflightEngine, verifyPreflightEngineCandidate } from '../../scripts/release/preflight-engine-candidate.mjs'

const roots = []
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(name = 'debugger-sh') {
  const root = await mkdtemp(path.join(tmpdir(), 'web-ide-preflight-engine-'))
  roots.push(root)
  const source = path.join(root, 'package')
  await mkdir(path.join(source, 'dist'), { recursive: true })
  const input = JSON.parse(await readFile(new URL('../../release/engine-fork-input.json', import.meta.url), 'utf8'))
  delete input.engine.receiptToolchain
  const { engine } = input
  const wasm = Buffer.from('synthetic WASM fixture'), module = Buffer.from('synthetic ESM fixture larger than wasm, not executable')
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name, version: engine.version }))
  await writeFile(path.join(source, engine.embeddedWasm.wasmPath), wasm)
  await writeFile(path.join(source, engine.embeddedWasm.modulePath), module)
  const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: root, TMPDIR: root,
    npm_config_cache: path.join(root, 'pack-cache'), npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }
  await writeFile(env.npm_config_userconfig, ''); await writeFile(env.npm_config_globalconfig, '')
  const pack = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: source, env })
  const filePath = path.join(root, JSON.parse(pack.stdout)[0].filename), bytes = await readFile(filePath)
  Object.assign(engine.distribution, { size: bytes.length, sha256: digest(bytes), sha512Integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') })
  Object.assign(engine.embeddedWasm, { wasmSize: wasm.length, wasmSha256: digest(wasm), moduleSize: module.length, moduleSha256: digest(module) })
  return { root, input, filePath, env, remote: path.join(root, 'nonrelease-origin.git') }
}

it('seeds independent caches from verified owned bytes, preserving the unpublished HTTPS lock and rejecting wrong installed bytes', async () => {
  const f = await fixture()
  const candidate = await verifyPreflightEngineCandidate(f.filePath, f.input, f.remote)
  expect(candidate.receipt.sha256).toBe(f.input.engine.distribution.sha256)
  expect(Object.isFrozen(candidate.receipt)).toBe(true)
  // Later changes to the caller's file or declaration cannot alter the owned candidate.
  await writeFile(f.filePath, 'changed after verification')
  const expectedVersion = f.input.engine.version
  f.input.engine.version = 'mutated'
  for (const index of [1, 2]) {
    const cwd = path.join(f.root, `consumer-${index}`); await mkdir(cwd)
    const env = { ...f.env, npm_config_cache: path.join(f.root, `independent-cache-${index}`) }
    const dependency = candidate.receipt.plannedUrl
    const manifest = { name: 'isolated-candidate-consumer', version: '1.0.0', private: true, dependencies: { 'debugger-sh': dependency } }
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      'node_modules/debugger-sh': { version: expectedVersion, resolved: dependency, integrity: candidate.receipt.sha512Integrity },
    } }
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock))
    const before = await readFile(path.join(cwd, 'package-lock.json'))
    await seedPreflightEngineCache(candidate, { directory: cwd, cwd, env, fixtureRemote: f.remote })
    await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env })
    expect((await readFile(path.join(cwd, 'package-lock.json'))).equals(before)).toBe(true)
    await verifyInstalledPreflightEngine(candidate, cwd)
    await writeFile(path.join(cwd, 'node_modules/debugger-sh', f.input.engine.embeddedWasm.modulePath), 'wrong module')
    await expect(verifyInstalledPreflightEngine(candidate, cwd)).rejects.toThrow(/module identity mismatch/u)
  }
}, 30_000)

it('rejects digest, size, integrity, package identity and fixture mismatches before seeding', async () => {
  const f = await fixture()
  await expect(verifyPreflightEngineCandidate(f.filePath, f.input)).rejects.toThrow(/nonrelease fixture/u)
  for (const [key, value] of [['sha256', '0'.repeat(64)], ['size', 1], ['sha512Integrity', 'sha512-' + Buffer.alloc(64).toString('base64')]]) {
    const changed = structuredClone(f.input); changed.engine.distribution[key] = value
    await expect(verifyPreflightEngineCandidate(f.filePath, changed, f.remote)).rejects.toThrow(/SHA-256\/SHA-512\/size/u)
  }
  const other = await fixture('other-package')
  await expect(verifyPreflightEngineCandidate(other.filePath, other.input, other.remote)).rejects.toThrow(/name\/version/u)
  const candidate = await verifyPreflightEngineCandidate(f.filePath, f.input, f.remote)
  await expect(seedPreflightEngineCache(candidate, { fixtureRemote: 'different' })).rejects.toThrow(/verified nonrelease/u)
  await expect(seedPreflightEngineCache({ receipt: candidate.receipt }, { fixtureRemote: f.remote })).rejects.toThrow(/verified nonrelease/u)
}, 30_000)

it('rejects local input in production and permits no authority-granting receipt fields', () => {
  expect(() => rejectPreflightEngineCandidate({})).not.toThrow()
  expect(() => rejectPreflightEngineCandidate({ [PREFLIGHT_ENGINE_VARIABLE]: '/tmp/candidate.tgz' })).toThrow(/restricted to nonrelease/u)
  expect(() => rejectPreflightEngineCandidate({ [PREFLIGHT_ENGINE_VARIABLE]: '' })).toThrow(/restricted to nonrelease/u)
  expect(() => validatePreflightEngineReceipt({ kind: 'verified-local-unpublished-candidate', finalizable: true })).toThrow()
})

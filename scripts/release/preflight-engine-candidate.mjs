import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { assertFinalEngineForkInput } from './engine-fork-input.mjs'
import { run } from './process-utils.mjs'
import { assertExactKeys, readExternalRegularFile, readRegularFileSnapshot, sha512IntegrityBytes } from './release-utils.mjs'

const candidates = new WeakMap()
export const PREFLIGHT_ENGINE_VARIABLE = 'WEB_IDE_PREFLIGHT_ENGINE_TARBALL'

export function rejectPreflightEngineCandidate(environment = process.env) {
  if (environment[PREFLIGHT_ENGINE_VARIABLE] !== undefined) {
    throw new TypeError('Local engine candidates are restricted to nonrelease preflight')
  }
}

export function validatePreflightEngineReceipt(receipt) {
  assertExactKeys(receipt, ['kind', 'name', 'version', 'sourceCommit', 'plannedUrl', 'size', 'sha256', 'sha512Integrity'], [], 'preflight engine candidate')
  if (receipt.kind !== 'verified-local-unpublished-candidate' || receipt.name !== 'debugger-sh'
    || !/^\d+\.\d+\.\d+-webide\.\d+\.\d+\.\d+\.\d+$/u.test(receipt.version)
    || !/^[a-f0-9]{40}$/u.test(receipt.sourceCommit) || !/^[a-f0-9]{64}$/u.test(receipt.sha256)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(receipt.sha512Integrity)
    || !Number.isSafeInteger(receipt.size) || receipt.size <= 0 || receipt.size > 128 * 1024 * 1024
    || receipt.plannedUrl !== `https://github.com/justinvassantachart/engine/releases/download/debugger-sh-v${receipt.version}/debugger-sh-${receipt.version}.tgz`) {
    throw new TypeError('Invalid nonrelease engine candidate receipt')
  }
  return receipt
}

/** This transport does not establish an immutable published release. */
export async function verifyPreflightEngineCandidate(filePath, forkInput, fixtureRemote) {
  if (!fixtureRemote) throw new TypeError('Local engine candidates require the verified nonrelease fixture remote')
  assertFinalEngineForkInput(forkInput)
  const snapshot = await readExternalRegularFile(filePath, 'Preflight engine candidate', 128 * 1024 * 1024)
  const { engine } = forkInput
  if (snapshot.size !== engine.distribution.size || snapshot.sha256 !== engine.distribution.sha256
    || sha512IntegrityBytes(snapshot.bytes) !== engine.distribution.sha512Integrity) {
    throw new TypeError('Preflight engine candidate does not match committed SHA-256/SHA-512/size')
  }
  // Read only the bounded manifest from already hash-verified bytes. No archive
  // paths are extracted, and no package scripts or shell are invoked.
  const unpack = spawnSync('/usr/bin/tar', ['-xOzf', '-', 'package/package.json'], {
    input: snapshot.bytes, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  if (unpack.error || unpack.status !== 0) throw new TypeError('Cannot read bounded preflight engine package manifest', { cause: unpack.error })
  const manifest = JSON.parse(unpack.stdout)
  if (manifest.name !== engine.name || manifest.version !== engine.version) {
    throw new TypeError('Preflight engine package name/version does not match committed input')
  }
  const receipt = Object.freeze(validatePreflightEngineReceipt({
    kind: 'verified-local-unpublished-candidate', name: engine.name, version: engine.version,
    sourceCommit: engine.source.commit, plannedUrl: engine.distribution.url,
    size: snapshot.size, sha256: snapshot.sha256, sha512Integrity: engine.distribution.sha512Integrity,
  }))
  const candidate = Object.freeze({ receipt })
  candidates.set(candidate, { bytes: snapshot.bytes, engine: structuredClone(engine), fixtureRemote })
  return candidate
}

export async function seedPreflightEngineCache(candidate, { directory, cwd, env, fixtureRemote }) {
  const verified = candidates.get(candidate)
  if (!verified || !fixtureRemote || fixtureRemote !== verified.fixtureRemote) {
    throw new TypeError('Engine cache seeding requires its verified nonrelease candidate and fixture')
  }
  const ownedPath = path.join(directory, 'preflight-engine-candidate.tgz')
  await writeFile(ownedPath, verified.bytes, { flag: 'wx', mode: 0o600 })
  try {
    await run('npm', ['cache', 'add', ownedPath, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env })
  } finally { await rm(ownedPath, { force: true }) }
}

export async function verifyInstalledPreflightEngine(candidate, checkout) {
  const verified = candidates.get(candidate)
  if (!verified) throw new TypeError('Installed engine verification requires a verified preflight candidate')
  const root = path.join(checkout, 'node_modules/debugger-sh')
  const manifest = JSON.parse((await readRegularFileSnapshot(path.join(root, 'package.json'), 'Installed engine manifest', 128 * 1024)).bytes)
  if (manifest.name !== verified.engine.name || manifest.version !== verified.engine.version) throw new TypeError('Installed preflight engine manifest mismatch')
  const embedded = verified.engine.embeddedWasm
  for (const role of ['wasm', 'module']) {
    const actual = await readRegularFileSnapshot(path.join(root, embedded[`${role}Path`]), `Installed engine ${role}`, 128 * 1024 * 1024)
    if (actual.size !== embedded[`${role}Size`] || actual.sha256 !== embedded[`${role}Sha256`]) throw new TypeError(`Installed preflight engine ${role} identity mismatch`)
  }
}

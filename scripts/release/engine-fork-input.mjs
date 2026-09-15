import path from 'node:path'

import { assertExactKeys, assertNonEmptyString, readJSON, repositoryRoot } from './release-utils.mjs'

export const ENGINE_PACKAGE_NAME = 'debugger-sh'
export const ENGINE_LOCK_PATH = `node_modules/${ENGINE_PACKAGE_NAME}`
export const ENGINE_FORK_INPUT_PATH = 'release/engine-fork-input.json'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u
const UPSTREAM_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u
const FORK_VERSION_PATTERN = /^\d+\.\d+\.\d+-webide\.\d+\.\d+\.\d+\.\d+$/u
const BUILD_KINDS = new Set(['embedded-wasm-library-build'])
const DISTRIBUTION_MECHANISMS = new Set(['public-github-release-asset'])
const PACKAGE_FILE_PATTERN = /^dist\/[A-Za-z0-9][A-Za-z0-9._-]*$/u

function assertDigest(value, location) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location} must be lowercase SHA-256 hex`)
  }
  return value
}

function assertSize(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${location} must be a positive safe integer`)
  return value
}

function assertCommit(value, location) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new TypeError(`${location} must be a full lowercase commit SHA-1`)
  }
  return value
}

function assertGitHubHttpsUrl(value, location) {
  assertNonEmptyString(value, location)
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) throw new TypeError(`${location} must be a bare HTTPS github.com URL`)
  return url
}

function assertPackageFilePath(value, location) {
  assertNonEmptyString(value, location)
  if (!PACKAGE_FILE_PATTERN.test(value)) {
    throw new TypeError(`${location} must be a package-relative dist file path`)
  }
  return value
}

function validateUpstream(upstream, location) {
  assertExactKeys(upstream, ['repository', 'version', 'commit'], [], location)
  const repository = assertGitHubHttpsUrl(upstream.repository, `${location}.repository`)
  if (repository.pathname !== '/debugger-sh/engine') {
    throw new TypeError(`${location}.repository must be the upstream Debugger.sh engine repository`)
  }
  if (!UPSTREAM_VERSION_PATTERN.test(upstream.version)) {
    throw new TypeError(`${location}.version must be an exact upstream release version`)
  }
  assertCommit(upstream.commit, `${location}.commit`)
}

function validateSource(source, upstream, { final }, location) {
  assertExactKeys(
    source,
    ['repository', 'acceptedBaseCommit', ...(final ? ['commit'] : [])],
    [],
    location,
  )
  const repository = assertGitHubHttpsUrl(source.repository, `${location}.repository`)
  if (repository.pathname === '/debugger-sh/engine') {
    throw new TypeError(`${location}.repository must be the fork repository, not upstream`)
  }
  assertCommit(source.acceptedBaseCommit, `${location}.acceptedBaseCommit`)
  if (source.acceptedBaseCommit === upstream.commit) {
    throw new TypeError(`${location}.acceptedBaseCommit must differ from the upstream release commit`)
  }
  if (!final) return
  assertCommit(source.commit, `${location}.commit`)
  if (source.commit === upstream.commit) {
    throw new TypeError(`${location}.commit must differ from the upstream release commit`)
  }
}

function validateBuild(build, location) {
  assertExactKeys(build, ['kind', 'toolchain'], [], location)
  if (!BUILD_KINDS.has(build.kind)) throw new TypeError(`${location}.kind is not a reviewed fork build kind`)
  assertExactKeys(build.toolchain, ['node', 'npm', 'rustc', 'cargo', 'wasmPack'], [], `${location}.toolchain`)
  for (const [name, value] of Object.entries(build.toolchain)) {
    assertNonEmptyString(value, `${location}.toolchain.${name}`)
  }
}

function validateDistribution(distribution, engine, { final }, location) {
  assertExactKeys(
    distribution,
    ['mechanism', 'repository', 'tag', 'assetFilename', 'url', ...(final ? ['size', 'sha256', 'sha512Integrity'] : [])],
    [],
    location,
  )
  if (!DISTRIBUTION_MECHANISMS.has(distribution.mechanism)) {
    throw new TypeError(`${location}.mechanism is not a reviewed fork distribution mechanism`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(distribution.repository ?? '')) {
    throw new TypeError(`${location}.repository must be an owner/name GitHub repository`)
  }
  if (distribution.tag !== `${engine.name}-v${engine.version}`) {
    throw new TypeError(`${location}.tag must name the exact fork release version`)
  }
  if (distribution.assetFilename !== `${engine.name}-${engine.version}.tgz`) {
    throw new TypeError(`${location}.assetFilename must be the exact fork package tarball name`)
  }
  const url = assertGitHubHttpsUrl(distribution.url, `${location}.url`)
  const expectedPath = `/${distribution.repository}/releases/download/${distribution.tag}/${distribution.assetFilename}`
  if (url.pathname !== expectedPath) {
    throw new TypeError(`${location}.url must be the immutable release asset URL ${expectedPath}`)
  }
  if (!final) return
  assertSize(distribution.size, `${location}.size`)
  assertDigest(distribution.sha256, `${location}.sha256`)
  if (!SHA512_INTEGRITY_PATTERN.test(distribution.sha512Integrity)) {
    throw new TypeError(`${location}.sha512Integrity must be an exact base64 SHA-512 npm integrity`)
  }
}

function validateEmbeddedWasm(embedded, { final }, location) {
  assertExactKeys(
    embedded,
    [
      'wasmPath', 'wasmLoadedAtRuntime', 'modulePath', 'remotelyFetched',
      ...(final ? ['wasmSize', 'wasmSha256', 'moduleSize', 'moduleSha256'] : []),
    ],
    [],
    location,
  )
  assertPackageFilePath(embedded.wasmPath, `${location}.wasmPath`)
  assertPackageFilePath(embedded.modulePath, `${location}.modulePath`)
  if (embedded.wasmPath === embedded.modulePath) {
    throw new TypeError(`${location}.modulePath must be the module that embeds the engine WebAssembly`)
  }
  for (const field of ['remotelyFetched', 'wasmLoadedAtRuntime']) {
    if (embedded[field] !== false) {
      throw new TypeError(`${location}.${field} must be false for an embedded engine build`)
    }
  }
  if (!final) return
  assertSize(embedded.wasmSize, `${location}.wasmSize`)
  assertDigest(embedded.wasmSha256, `${location}.wasmSha256`)
  assertSize(embedded.moduleSize, `${location}.moduleSize`)
  assertDigest(embedded.moduleSha256, `${location}.moduleSha256`)
  if (embedded.moduleSize <= embedded.wasmSize) {
    throw new TypeError(`${location}.moduleSize must exceed the embedded engine WebAssembly size`)
  }
}

export function validateEngineForkInput(record, location = 'engine fork input') {
  const final = record?.status === 'final'
  assertExactKeys(
    record,
    ['schemaVersion', 'package', 'status', 'engine', ...(final ? ['consumerGraph'] : ['pendingSteps'])],
    [],
    location,
  )
  if (record.schemaVersion !== 1 || record.package !== 'web-ide') {
    throw new TypeError(`Unsupported ${location} identity`)
  }
  if (!final && record.status !== 'pending-publication') {
    throw new TypeError(`${location}.status must be "final" or "pending-publication"`)
  }
  const engine = record.engine
  assertExactKeys(
    engine,
    [
      'name', 'version', 'registryPublished', 'upstream', 'source',
      'distribution', 'embeddedWasm', ...(final ? ['build'] : []),
    ],
    [],
    `${location}.engine`,
  )
  if (engine.name !== ENGINE_PACKAGE_NAME) {
    throw new TypeError(`${location}.engine.name must be ${ENGINE_PACKAGE_NAME}`)
  }
  if (!FORK_VERSION_PATTERN.test(engine.version)) {
    throw new TypeError(`${location}.engine.version must be an exact fork version`)
  }
  if (engine.registryPublished !== false) {
    throw new TypeError(`${location}.engine.registryPublished must be false; the fork is not an upstream registry release`)
  }
  validateUpstream(engine.upstream, `${location}.engine.upstream`)
  if (!engine.version.startsWith(`${engine.upstream.version}-webide.`)) {
    throw new TypeError(`${location}.engine.version must extend the exact upstream version`)
  }
  validateSource(engine.source, engine.upstream, { final }, `${location}.engine.source`)
  validateDistribution(engine.distribution, engine, { final }, `${location}.engine.distribution`)
  validateEmbeddedWasm(engine.embeddedWasm, { final }, `${location}.engine.embeddedWasm`)
  if (final) {
    validateBuild(engine.build, `${location}.engine.build`)
    assertExactKeys(record.consumerGraph, ['normalizedLockSha256'], [], `${location}.consumerGraph`)
    assertDigest(record.consumerGraph.normalizedLockSha256, `${location}.consumerGraph.normalizedLockSha256`)
    return record
  }
  if (!Array.isArray(record.pendingSteps) || record.pendingSteps.length === 0) {
    throw new TypeError(`${location}.pendingSteps must record the remaining publication steps`)
  }
  record.pendingSteps.forEach((step, index) => assertNonEmptyString(step, `${location}.pendingSteps[${index}]`))
  return record
}

export function assertFinalEngineForkInput(record, location = 'engine fork input') {
  validateEngineForkInput(record, location)
  if (record.status !== 'final') {
    throw new TypeError(
      `${location} is ${record.status}: the fork engine asset is not published yet. Remaining steps: `
        + record.pendingSteps.join(' '),
    )
  }
  return record
}

export async function loadEngineForkInput(
  filePath = path.join(repositoryRoot, ENGINE_FORK_INPUT_PATH),
  { requireFinal = true } = {},
) {
  const record = await readJSON(filePath)
  return requireFinal ? assertFinalEngineForkInput(record) : validateEngineForkInput(record)
}

export function engineDependencySpecifier(record) {
  assertFinalEngineForkInput(record)
  return record.engine.distribution.url
}

export function assertEngineLockEntry(lockEntry, record, location) {
  assertFinalEngineForkInput(record)
  if (!lockEntry || typeof lockEntry !== 'object' || Array.isArray(lockEntry)) {
    throw new TypeError(`${location} is absent from package-lock.json`)
  }
  const { engine } = record
  if (
    lockEntry.version !== engine.version
    || lockEntry.resolved !== engine.distribution.url
    || lockEntry.integrity !== engine.distribution.sha512Integrity
  ) {
    throw new TypeError(`${location} is not the exact committed fork engine input`)
  }
  return { version: lockEntry.version, resolved: lockEntry.resolved, integrity: lockEntry.integrity }
}

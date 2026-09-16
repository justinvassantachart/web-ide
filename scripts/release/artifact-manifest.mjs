import os from 'node:os'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertEngineLockEntry,
  ENGINE_LOCK_PATH,
  engineDependencySpecifier,
  loadEngineForkInput,
} from './engine-fork-input.mjs'
import { VALIDATION_GATES } from './release-inputs.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  hashFile,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
} from './release-utils.mjs'
import { validateReleaseSchema } from './validate-release-schema.mjs'

const expectedPackageContract = {
  engines: { node: '^20.19.0 || >=22.12.0' },
  peerDependencies: {
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
  },
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './plugins': { types: './dist/plugins.d.ts', import: './dist/plugins.js' },
    './host': { types: './dist/host.d.ts', import: './dist/host.js' },
    './runtimes': { types: './dist/runtimes.d.ts', import: './dist/runtimes.js' },
    './testing': { types: './dist/testing.d.ts', import: './dist/testing.js' },
    './language-tools': { types: './dist/language-tools.d.ts', import: './dist/language-tools.js' },
    './styles.css': './dist/styles.css',
    './package.json': './package.json',
  },
}

const expectedEvidenceKinds = [
  'bundle-provenance',
  'candidate-state',
  'cyclonedx-sbom',
  'deterministic-builds',
  'license-inventory',
  'package-inspection',
  'runtime-assets',
  'runtime-source-provenance',
  'third-party-license-text',
  'validation-summary',
]

const expectedValidationLogKinds = VALIDATION_GATES
  .map((gate) => `validation-log:${gate.id}:0`)
  .sort()

const expectedCapabilityReleaseIds = Object.freeze([
  'cs106b.source/2',
])

function validateDigest(value, location) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${location} must be lowercase SHA-256 hex`)
  }
}

function validateFileEvidence(value, location) {
  assertExactKeys(value, ['kind', 'fileName', 'size', 'sha256'], [], location)
  assertNonEmptyString(value.kind, `${location}.kind`)
  assertNonEmptyString(value.fileName, `${location}.fileName`)
  if (value.fileName !== path.basename(value.fileName) || value.fileName.includes('..') || value.fileName.includes('\\')) {
    throw new TypeError(`${location}.fileName is unsafe`)
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) throw new TypeError(`${location}.size is invalid`)
  validateDigest(value.sha256, `${location}.sha256`)
}

function validateInventoryFile(value, location) {
  assertExactKeys(value, ['path', 'size', 'mode', 'sha256'], [], location)
  assertNonEmptyString(value.path, `${location}.path`)
  if (value.path.includes('..') || value.path.includes('\\') || value.path.startsWith('/')) {
    throw new TypeError(`${location}.path is unsafe`)
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0 || !Number.isSafeInteger(value.mode)) {
    throw new TypeError(`${location} has invalid numeric metadata`)
  }
  validateDigest(value.sha256, `${location}.sha256`)
}

function validateBuildInputs(buildInputs, sourceDateEpoch) {
  assertExactKeys(buildInputs, ['argv', 'environment', 'pathNormalization'], [], 'artifact manifest buildInputs')
  assertExactKeys(buildInputs.argv, ['install', 'build', 'licenseEvidence', 'pack'], [], 'artifact manifest buildInputs.argv')
  const expectedArgv = {
    install: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    build: ['npm', 'run', 'build:library'],
    licenseEvidence: ['node', 'scripts/release/generate-isolated-license-evidence.mjs'],
    pack: ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', '../pack'],
  }
  if (canonicalJSONString(buildInputs.argv) !== canonicalJSONString(expectedArgv)) {
    throw new TypeError('Artifact manifest build argv is not the reviewed exact command set')
  }
  assertExactKeys(
    buildInputs.environment,
    [
      'inherited', 'PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'CI',
      'NO_UPDATE_NOTIFIER', 'SOURCE_DATE_EPOCH', 'npm_config_cache',
      'npm_config_registry', 'npm_config_globalconfig', 'npm_config_strict_ssl',
      'npm_config_package_lock', 'npm_config_offline', 'npm_config_prefer_offline',
      'npm_config_prefer_online',
      'npm_config_ignore_scripts', 'npm_config_audit', 'npm_config_fund',
      'npm_config_userconfig', 'WEB_IDE_RELEASE_PROVENANCE_PATH',
      'WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR',
    ],
    [],
    'artifact manifest buildInputs.environment',
  )
  if (
    !Array.isArray(buildInputs.environment.inherited)
    || buildInputs.environment.inherited.length !== 0
    || buildInputs.environment.SOURCE_DATE_EPOCH !== sourceDateEpoch
    || buildInputs.environment.TZ !== 'UTC'
    || buildInputs.environment.LC_ALL !== 'C'
    || buildInputs.environment.npm_config_registry !== 'https://registry.npmjs.org/'
    || buildInputs.environment.npm_config_globalconfig !== '<isolated-build>/global.npmrc'
    || buildInputs.environment.npm_config_userconfig !== '<isolated-build>/user.npmrc'
  ) throw new TypeError('Artifact manifest build environment is not hermetic')
  assertNonEmptyString(buildInputs.pathNormalization, 'artifact manifest buildInputs.pathNormalization')
}

function engineEvidence(forkInput, lockEntry) {
  const { engine } = forkInput
  return {
    name: engine.name,
    version: engine.version,
    registryPublished: false,
    source: {
      repository: engine.source.repository,
      commit: engine.source.commit,
      acceptedBaseCommit: engine.source.acceptedBaseCommit,
      upstreamRepository: engine.upstream.repository,
      upstreamVersion: engine.upstream.version,
      upstreamCommit: engine.upstream.commit,
    },
    build: { kind: engine.build.kind, toolchain: { ...engine.build.toolchain } },
    distribution: { ...engine.distribution },
    lock: assertEngineLockEntry(lockEntry, forkInput, `${ENGINE_LOCK_PATH} lock entry`),
    embeddedWasm: { ...engine.embeddedWasm },
  }
}

function validateRuntime(runtime, forkInput) {
  assertExactKeys(
    runtime,
    ['observedDate', 'digestRepresentation', 'expectedRedirectCount', 'requestTimeoutMs', 'scope', 'limitations', 'assets', 'engine'],
    [],
    'artifact manifest runtime',
  )
  if (
    runtime.expectedRedirectCount !== 0
    || !Array.isArray(runtime.limitations)
    || !Array.isArray(runtime.assets)
    || runtime.assets.length !== 26
  ) {
    throw new TypeError('Artifact manifest runtime evidence is incomplete')
  }
  const ids = []
  for (const [index, asset] of runtime.assets.entries()) {
    const location = `artifact manifest runtime.assets[${index}]`
    assertExactKeys(
      asset,
      ['id', 'version', 'requestedUrl', 'finalUrl', 'size', 'sha256', 'contentType', 'headers', 'license'],
      [],
      location,
    )
    for (const field of ['id', 'version', 'requestedUrl', 'finalUrl', 'contentType', 'license']) {
      assertNonEmptyString(asset[field], `${location}.${field}`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new TypeError(`${location}.size is invalid`)
    validateDigest(asset.sha256, `${location}.sha256`)
    assertExactKeys(
      asset.headers,
      ['access-control-allow-origin', 'cross-origin-resource-policy'],
      [],
      `${location}.headers`,
    )
    ids.push(asset.id)
  }
  if (JSON.stringify(ids) !== JSON.stringify(sortStrings(ids)) || new Set(ids).size !== ids.length) {
    throw new TypeError('Artifact manifest runtime assets must have unique sorted identities')
  }
  for (const asset of runtime.assets) {
    if (asset.id.startsWith(`${forkInput.engine.name}.engine`)) {
      throw new TypeError('The embedded fork engine WebAssembly must not be locked as a remote runtime asset')
    }
  }
  assertExactKeys(
    runtime.engine,
    ['name', 'version', 'registryPublished', 'source', 'build', 'distribution', 'lock', 'embeddedWasm'],
    [],
    'artifact manifest runtime.engine',
  )
  if (
    canonicalJSONString(runtime.engine)
    !== canonicalJSONString(engineEvidence(forkInput, runtime.engine.lock))
  ) {
    throw new TypeError('Artifact manifest engine identity does not match the committed exact fork input')
  }
}

export function validateArtifactManifest(manifest, configuration, forkInput) {
  assertExactKeys(
    manifest,
    [
      'schemaVersion', 'manifestKind', 'manifestId', 'capabilityReleaseIds',
      'packageRole', 'package', 'source', 'toolchain', 'buildInputs',
      'distribution', 'runtime', 'validation', 'evidence',
    ],
    [],
    'artifact manifest',
  )
  if (
    manifest.schemaVersion !== 2
    || manifest.manifestKind !== 'web-ide-capability-package-artifact'
    || canonicalJSONString(manifest.capabilityReleaseIds)
      !== canonicalJSONString(expectedCapabilityReleaseIds)
    || !manifest.capabilityReleaseIds.includes(configuration.capabilityReleaseId)
    || manifest.packageRole !== configuration.packageRole
  ) throw new TypeError('Artifact manifest identity is invalid')
  const { manifestId, ...identityInput } = manifest
  const expectedId = `urn:sha256:${sha256Bytes(Buffer.from(canonicalJSONString(identityInput)))}`
  if (manifestId !== expectedId) throw new TypeError('Artifact manifestId is not its deterministic content identity')
  assertExactKeys(
    manifest.package,
    ['name', 'version', 'private', 'license', 'engines', 'dependencies', 'peerDependencies', 'exports'],
    [],
    'artifact manifest package',
  )
  if (
    `${manifest.package.name}@${manifest.package.version}` !== configuration.package
    || manifest.package.private !== true
    || manifest.package.license !== 'MIT'
  ) throw new TypeError('Artifact manifest package identity is invalid')
  for (const field of ['engines', 'peerDependencies', 'exports']) {
    if (canonicalJSONString(manifest.package[field]) !== canonicalJSONString(expectedPackageContract[field])) {
      throw new TypeError(`Artifact manifest package ${field} changed from the reviewed contract`)
    }
  }
  if (
    canonicalJSONString(manifest.package.dependencies)
    !== canonicalJSONString({ [forkInput.engine.name]: engineDependencySpecifier(forkInput) })
  ) {
    throw new TypeError('Artifact manifest package dependencies do not pin the committed exact fork engine asset')
  }
  assertExactKeys(
    manifest.source,
    ['repository', 'branch', 'commit', 'tree', 'commitTimestamp', 'sourceDateEpoch', 'tag', 'inputs', 'archive'],
    [],
    'artifact manifest source',
  )
  if (
    manifest.source.repository !== configuration.sourceRepository
    || manifest.source.branch !== 'main'
    || !/^[a-f0-9]{40}$/u.test(manifest.source.commit)
    || !/^[a-f0-9]{40}$/u.test(manifest.source.tree)
    || !Number.isSafeInteger(manifest.source.commitTimestamp)
    || manifest.source.sourceDateEpoch !== String(manifest.source.commitTimestamp)
  ) throw new TypeError('Artifact manifest source identity is invalid')
  assertExactKeys(manifest.source.tag, ['name', 'objectId', 'objectType', 'peeledCommit'], [], 'artifact manifest source.tag')
  if (
    manifest.source.tag.name !== configuration.sourceTag
    || manifest.source.tag.objectType !== 'tag'
    || !/^[a-f0-9]{40}$/u.test(manifest.source.tag.objectId)
    || manifest.source.tag.peeledCommit !== manifest.source.commit
  ) throw new TypeError('Artifact manifest annotated source tag is invalid')
  assertExactKeys(manifest.source.inputs, ['packageJson', 'packageLock'], [], 'artifact manifest source.inputs')
  for (const [name, input] of Object.entries(manifest.source.inputs)) {
    validateFileEvidence(input, `artifact manifest source.inputs.${name}`)
  }
  if (
    manifest.source.inputs.packageJson.fileName !== 'package.json'
    || manifest.source.inputs.packageLock.fileName !== 'package-lock.json'
  ) throw new TypeError('Artifact manifest source input filenames are invalid')
  validateFileEvidence(manifest.source.archive, 'artifact manifest source.archive')
  if (manifest.source.archive.kind !== 'source-archive' || manifest.source.archive.fileName !== configuration.sourceAssetFilename) {
    throw new TypeError('Artifact manifest source archive identity is invalid')
  }
  assertExactKeys(manifest.toolchain, ['node', 'npm', 'osType', 'osRelease', 'platform', 'arch'], [], 'artifact manifest toolchain')
  if (manifest.toolchain.node !== configuration.nodeVersion || manifest.toolchain.npm !== configuration.npmVersion) {
    throw new TypeError('Artifact manifest toolchain is invalid')
  }
  for (const field of ['osType', 'osRelease', 'platform', 'arch']) assertNonEmptyString(manifest.toolchain[field], `artifact manifest toolchain.${field}`)
  validateBuildInputs(manifest.buildInputs, manifest.source.sourceDateEpoch)
  assertExactKeys(
    manifest.distribution,
    ['mechanism', 'npmPublished', 'repository', 'intendedTag', 'intendedAssetFilename', 'artifact'],
    [],
    'artifact manifest distribution',
  )
  if (
    manifest.distribution.mechanism !== 'private-github-release-asset'
    || manifest.distribution.npmPublished !== false
    || manifest.distribution.repository !== configuration.releaseRepository
    || manifest.distribution.intendedTag !== configuration.releaseTag
    || manifest.distribution.intendedAssetFilename !== configuration.releaseAssetFilename
  ) throw new TypeError('Artifact manifest distribution identity is invalid')
  const artifact = manifest.distribution.artifact
  assertExactKeys(artifact, ['kind', 'fileName', 'size', 'sha256', 'sha512Integrity', 'files'], [], 'artifact manifest artifact')
  if (
    artifact.kind !== 'package-tarball'
    || artifact.fileName !== configuration.releaseAssetFilename
    || typeof artifact.sha512Integrity !== 'string'
    || !artifact.sha512Integrity.startsWith('sha512-')
    || !Array.isArray(artifact.files)
    || artifact.files.length === 0
  ) throw new TypeError('Artifact manifest package artifact identity is invalid')
  validateDigest(artifact.sha256, 'artifact manifest artifact.sha256')
  const inventoryPaths = []
  for (const [index, file] of artifact.files.entries()) {
    validateInventoryFile(file, `artifact manifest artifact.files[${index}]`)
    inventoryPaths.push(file.path)
  }
  if (JSON.stringify(inventoryPaths) !== JSON.stringify(sortStrings(inventoryPaths)) || new Set(inventoryPaths).size !== inventoryPaths.length) {
    throw new TypeError('Artifact manifest file inventory is not unique and sorted')
  }
  validateRuntime(manifest.runtime, forkInput)
  assertExactKeys(manifest.validation, ['candidateSha256', 'gateCount', 'logCount'], [], 'artifact manifest validation')
  if (
    manifest.validation.candidateSha256 !== artifact.sha256
    || manifest.validation.gateCount !== VALIDATION_GATES.length
    || manifest.validation.logCount !== VALIDATION_GATES.length
  ) throw new TypeError('Artifact manifest validation identity is incomplete')
  if (
    !Array.isArray(manifest.evidence)
    || manifest.evidence.length !== expectedEvidenceKinds.length + manifest.validation.logCount
  ) {
    throw new TypeError('Artifact manifest evidence set is incomplete')
  }
  const kinds = []
  for (const [index, item] of manifest.evidence.entries()) {
    validateFileEvidence(item, `artifact manifest evidence[${index}]`)
    kinds.push(item.kind)
  }
  if (JSON.stringify(kinds) !== JSON.stringify(sortStrings(kinds))) {
    throw new TypeError('Artifact manifest evidence kinds are unsorted')
  }
  const baseKinds = kinds.filter((kind) => !kind.startsWith('validation-log:'))
  const logKinds = kinds.filter((kind) => kind.startsWith('validation-log:'))
  if (
    JSON.stringify(baseKinds) !== JSON.stringify(expectedEvidenceKinds)
    || JSON.stringify(logKinds) !== JSON.stringify(expectedValidationLogKinds)
  ) {
    throw new TypeError('Artifact manifest evidence kinds are incomplete or unsorted')
  }
  return manifest
}

async function evidenceFile(outputDirectory, kind, fileName) {
  if (fileName !== path.basename(fileName)) throw new TypeError(`Unsafe evidence filename ${fileName}`)
  const { size, digest } = await hashFile(path.join(outputDirectory, fileName))
  return { kind, fileName, size, sha256: digest }
}

async function sourceInputFile(fileName, absolutePath = path.join(repositoryRoot, fileName)) {
  const { size, digest } = await hashFile(absolutePath)
  return { kind: 'source-input', fileName, size, sha256: digest }
}

export async function createArtifactManifest({
  outputDirectory,
  configuration,
  source,
  packageManifest,
  engineForkInputPath,
  packageLockPath = path.join(repositoryRoot, 'package-lock.json'),
}) {
  const forkInput = await loadEngineForkInput(engineForkInputPath)
  const validationSummary = await readJSON(path.join(outputDirectory, 'validation-summary.json'))
  const evidenceNames = {
    'bundle-provenance': 'bundle-provenance.json',
    'candidate-state': 'candidate-state.json',
    'cyclonedx-sbom': 'web-ide-0.5.0.cdx.json',
    'deterministic-builds': 'deterministic-builds.json',
    'license-inventory': 'third-party-licenses.json',
    'package-inspection': 'package-inspection.json',
    'runtime-assets': 'runtime-assets-verification.json',
    'runtime-source-provenance': 'runtime-source-provenance.json',
    'third-party-license-text': 'THIRD_PARTY_LICENSES.txt',
    'validation-summary': 'validation-summary.json',
  }
  for (const gate of validationSummary.gates) {
    for (const [index, log] of gate.logs.entries()) {
      evidenceNames[`validation-log:${gate.id}:${index}`] = log.fileName
    }
  }
  const evidence = await Promise.all(sortStrings(Object.keys(evidenceNames)).map((kind) => (
    evidenceFile(outputDirectory, kind, evidenceNames[kind])
  )))
  const [artifactEvidence, sourceArchive, packageJsonInput, packageLockInput] = await Promise.all([
    evidenceFile(outputDirectory, 'package-tarball', configuration.releaseAssetFilename),
    evidenceFile(outputDirectory, 'source-archive', configuration.sourceAssetFilename),
    sourceInputFile('package.json'),
    sourceInputFile('package-lock.json', packageLockPath),
  ])
  const [inspection, runtimeLock, runtimeSources, packageLock, determinism] = await Promise.all([
    readJSON(path.join(outputDirectory, 'package-inspection.json')),
    readJSON(path.join(repositoryRoot, 'release/runtime-assets.lock.json')),
    readJSON(path.join(repositoryRoot, 'release/runtime-source-provenance.json')),
    readJSON(packageLockPath),
    readJSON(path.join(outputDirectory, 'deterministic-builds.json')),
  ])
  const engine = engineEvidence(forkInput, packageLock.packages?.[ENGINE_LOCK_PATH])
  if (runtimeSources.records.some((record) => record.assets.some((asset) => asset.startsWith(`${forkInput.engine.name}.engine`)))) {
    throw new TypeError('Runtime source provenance still records the embedded fork engine WebAssembly as a remote asset')
  }
  if (
    inspection.tarball.filename !== artifactEvidence.fileName
    || inspection.tarball.size !== artifactEvidence.size
    || inspection.tarball.sha256 !== artifactEvidence.sha256
    || validationSummary.candidateSha256 !== artifactEvidence.sha256
  ) throw new TypeError('Package inspection/validation identity does not match the exact candidate bytes')
  const draft = {
    schemaVersion: 2,
    manifestKind: 'web-ide-capability-package-artifact',
    capabilityReleaseIds: expectedCapabilityReleaseIds,
    packageRole: configuration.packageRole,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      private: packageManifest.private,
      license: packageManifest.license,
      engines: packageManifest.engines,
      dependencies: packageManifest.dependencies,
      peerDependencies: packageManifest.peerDependencies,
      exports: packageManifest.exports,
    },
    source: {
      repository: configuration.sourceRepository,
      branch: source.branch,
      commit: source.commit,
      tree: source.tree,
      commitTimestamp: source.commitTimestamp,
      sourceDateEpoch: source.sourceDateEpoch,
      tag: source.tag,
      inputs: { packageJson: packageJsonInput, packageLock: packageLockInput },
      archive: sourceArchive,
    },
    toolchain: {
      node: source.nodeVersion,
      npm: source.npmVersion,
      osType: os.type(),
      osRelease: os.release(),
      platform: process.platform,
      arch: process.arch,
    },
    buildInputs: determinism.buildInputs,
    distribution: {
      mechanism: 'private-github-release-asset',
      npmPublished: false,
      repository: configuration.releaseRepository,
      intendedTag: configuration.releaseTag,
      intendedAssetFilename: configuration.releaseAssetFilename,
      artifact: {
        ...artifactEvidence,
        sha512Integrity: inspection.tarball.sha512Integrity,
        files: inspection.files,
      },
    },
    runtime: {
      observedDate: runtimeLock.observedDate,
      digestRepresentation: runtimeLock.digestRepresentation,
      expectedRedirectCount: runtimeLock.expectedRedirectCount,
      requestTimeoutMs: runtimeLock.requestTimeoutMs,
      scope: runtimeLock.scope,
      limitations: runtimeLock.limitations,
      assets: runtimeLock.assets.map((asset) => ({
        id: asset.id,
        version: asset.version,
        requestedUrl: asset.requestedUrl,
        finalUrl: asset.finalUrl,
        size: asset.size,
        sha256: asset.sha256,
        contentType: asset.contentType,
        headers: asset.headers,
        license: asset.license,
      })),
      engine,
    },
    validation: {
      candidateSha256: validationSummary.candidateSha256,
      gateCount: validationSummary.gateCount,
      logCount: validationSummary.logCount,
    },
    evidence,
  }
  const manifestId = `urn:sha256:${sha256Bytes(Buffer.from(canonicalJSONString(draft)))}`
  const manifest = validateArtifactManifest({ ...draft, manifestId }, configuration, forkInput)
  return await validateReleaseSchema('artifact-manifest.schema.json', manifest, 'Artifact manifest')
}

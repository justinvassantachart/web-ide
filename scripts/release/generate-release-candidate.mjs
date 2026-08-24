import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildDeterministicCandidates } from './candidate-builds.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import {
  assertCanonicalSnapshotUnchanged,
  assertPublicationInventory,
  snapshotExactFlatDirectory,
} from './publication-guard.mjs'
import { settleOperations } from './process-utils.mjs'
import {
  assertExternalOutputPath,
  hashFile,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  writeCanonicalJSON,
} from './release-utils.mjs'
import { validateRuntimeAssetLock, verifyRuntimeAssets } from './runtime-assets.mjs'
import { validateRuntimeSourceProvenance } from './runtime-source-provenance.mjs'
import { generateCycloneDx } from './sbom.mjs'
import { sourceArchiveBytes, verifyReleaseSourceState } from './source-state.mjs'
import { validateCycloneDx } from './validate-cyclonedx.mjs'
import { beginEmptyDirectoryTransaction } from './transactional-output.mjs'

const outputInput = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
if (!outputInput) throw new TypeError('WEB_IDE_RELEASE_OUTPUT_DIR is required')
let outputTransaction

try {
const configuration = await loadReleaseConfiguration()
const preflightRemoteInput = process.env.WEB_IDE_RELEASE_PREFLIGHT_REMOTE
const preflightRemote = preflightRemoteInput
  ? await assertExternalOutputPath(preflightRemoteInput, 'Preflight fixture remote')
  : null
const sourceOptions = preflightRemote ? { nonreleaseFixtureRemote: preflightRemote } : {}
const source = await verifyReleaseSourceState(
  configuration,
  repositoryRoot,
  sourceOptions,
)
let expectedPublicationInventory
outputTransaction = await beginEmptyDirectoryTransaction(outputInput, 'Release output directory', {
  beforePublish: async ({ inventory }) => {
    if (!expectedPublicationInventory) {
      throw new TypeError('Release candidate publication guard was not initialized')
    }
    const immediateSource = await verifyReleaseSourceState(
      configuration,
      repositoryRoot,
      sourceOptions,
    )
    assertCanonicalSnapshotUnchanged(source, immediateSource, 'Release source')
    assertPublicationInventory(
      expectedPublicationInventory,
      inventory,
      'Release candidate inventory',
    )
  },
})
const outputDirectory = outputTransaction.stagingDirectory
const packageManifest = await readJSON(path.join(repositoryRoot, 'package.json'))
const packageLock = await readJSON(path.join(repositoryRoot, 'package-lock.json'))
const runtimeLock = validateRuntimeAssetLock(
  await readJSON(path.join(repositoryRoot, 'release/runtime-assets.lock.json')),
)
const runtimeSourceProvenance = validateRuntimeSourceProvenance(
  await readJSON(path.join(repositoryRoot, 'release/runtime-source-provenance.json')),
  runtimeLock,
)

const [sourceArchiveFirst, sourceArchiveSecond] = await settleOperations([
  sourceArchiveBytes(
    configuration,
    repositoryRoot,
    sourceOptions,
  ),
  sourceArchiveBytes(
    configuration,
    repositoryRoot,
    sourceOptions,
  ),
], 'Deterministic source archive builds')
if (!sourceArchiveFirst.bytes.equals(sourceArchiveSecond.bytes)) {
  throw new TypeError('Two local exact-tag source archives were not byte-identical')
}
await writeFile(
  path.join(outputDirectory, configuration.sourceAssetFilename),
  sourceArchiveFirst.bytes,
  { flag: 'wx' },
)

const candidate = await buildDeterministicCandidates({
  outputDirectory,
  sourceCommit: source.commit,
  configuration: { ...configuration, sourceDateEpoch: source.sourceDateEpoch },
})
const provenancePath = path.join(outputDirectory, 'bundle-provenance.json')
await writeFile(provenancePath, candidate.provenanceBytes, { flag: 'wx' })
await writeCanonicalJSON(path.join(outputDirectory, 'package-inspection.json'), candidate.inspection)
await writeCanonicalJSON(path.join(outputDirectory, 'deterministic-builds.json'), {
  ...candidate.determinism,
  exactTagSourceArchivesByteIdentical: true,
  sourceArchive: {
    filename: configuration.sourceAssetFilename,
    size: sourceArchiveFirst.size,
    sha256: sourceArchiveFirst.sha256,
  },
  buildInputs: candidate.buildInputs,
})

const runtimeVerification = await verifyRuntimeAssets(runtimeLock)
await writeCanonicalJSON(path.join(outputDirectory, 'runtime-assets-verification.json'), runtimeVerification)

const sbom = await generateCycloneDx({
  provenancePath,
  runtimeLock,
  packageManifest,
  packageLock,
  candidate: candidate.inspection.tarball,
})
await validateCycloneDx(sbom)
await writeCanonicalJSON(path.join(outputDirectory, 'web-ide-0.2.0.cdx.json'), sbom)

const shippedLicenseText = await readFile(path.join(repositoryRoot, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
if (candidate.licenseTextBytes.toString('utf8') !== shippedLicenseText) {
  throw new TypeError('Shipped THIRD_PARTY_LICENSES.txt does not match generated exact-candidate evidence')
}
const packedLicenseFile = candidate.inspection.files.find((file) => file.path === 'THIRD_PARTY_LICENSES.txt')
if (!packedLicenseFile || packedLicenseFile.sha256 !== sha256Bytes(candidate.licenseTextBytes)) {
  throw new TypeError('Packed THIRD_PARTY_LICENSES.txt does not match isolated license generation')
}
await writeFile(path.join(outputDirectory, 'third-party-licenses.json'), candidate.licenseReportBytes, {
  flag: 'wx',
})
await writeFile(path.join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'), candidate.licenseTextBytes, {
  flag: 'wx',
})
await writeCanonicalJSON(
  path.join(outputDirectory, 'runtime-source-provenance.json'),
  runtimeSourceProvenance,
)

const artifactFiles = [
  configuration.releaseAssetFilename,
  configuration.sourceAssetFilename,
  'bundle-provenance.json',
  'deterministic-builds.json',
  'package-inspection.json',
  'runtime-assets-verification.json',
  'runtime-source-provenance.json',
  'third-party-licenses.json',
  'THIRD_PARTY_LICENSES.txt',
  'web-ide-0.2.0.cdx.json',
]
const artifacts = []
for (const fileName of artifactFiles.sort()) {
  const { size, digest } = await hashFile(path.join(outputDirectory, fileName))
  artifacts.push({ fileName, size, sha256: digest })
}
const state = {
  schemaVersion: 1,
  package: configuration.package,
  result: preflightRemote ? 'nonrelease-preflight' : 'candidate-generated',
  source,
  capabilityReleaseId: configuration.capabilityReleaseId,
  packageRole: configuration.packageRole,
  artifacts,
  ...(preflightRemote ? {
    preflightFixture: {
      mode: 'disposable-local-remote',
      remote: preflightRemote,
      finalizable: false,
    },
  } : {}),
}
await writeCanonicalJSON(path.join(outputDirectory, 'candidate-state.json'), state)

const postGenerationSource = await verifyReleaseSourceState(
  configuration,
  repositoryRoot,
  sourceOptions,
)
assertCanonicalSnapshotUnchanged(source, postGenerationSource, 'Release source')
expectedPublicationInventory = await snapshotExactFlatDirectory(
  outputDirectory,
  [...artifactFiles, 'candidate-state.json'],
  'Generated release candidate',
)

await outputTransaction.commit()

process.stdout.write(
  `Generated deterministic ${configuration.package} candidate ${candidate.inspection.tarball.sha256}\n`
    + `Candidate state SHA-256 ${sha256Bytes(Buffer.from(canonicalJSONString(state)))}\n`,
)
} catch (error) {
  if (outputTransaction) await outputTransaction.rollback()
  throw error
}

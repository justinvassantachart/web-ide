import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createArtifactManifest } from './artifact-manifest.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  loadReleaseConfiguration,
  MAX_VALIDATION_GATE_LOG_BYTES,
  validateFinalCandidateState,
  validateValidationSummary,
} from './release-inputs.mjs'
import {
  assertExactKeys,
  hashFile,
  readCanonicalJSON,
  readExternalRegularFile,
  readJSON,
  readRegularFileSnapshot,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
  writeCanonicalJSON,
} from './release-utils.mjs'
import {
  assertCanonicalSnapshotUnchanged,
  assertPublicationInventory,
  snapshotExactFlatDirectory,
} from './publication-guard.mjs'
import { revalidateReleaseCandidate } from './revalidate-release-candidate.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'
import { beginDirectoryReplacement } from './transactional-output.mjs'
import { decodeValidationLog } from './validation-log.mjs'
import { parseValidationGateReceipt } from './validation-gate-receipt.mjs'
import { validateReleaseSchema } from './validate-release-schema.mjs'

const outputInput = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
const validationInput = process.env.WEB_IDE_RELEASE_VALIDATION_INPUT
if (!outputInput) throw new TypeError('WEB_IDE_RELEASE_OUTPUT_DIR is required')
if (!validationInput) throw new TypeError('WEB_IDE_RELEASE_VALIDATION_INPUT is required')

function parseJSONBytes(bytes, location) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new TypeError(`${location} is not valid JSON`, { cause: error })
  }
}

async function writeVerifiedSnapshot(directory, fileName, snapshot) {
  const destination = path.join(directory, fileName)
  await writeFile(destination, snapshot.bytes, { flag: 'wx' })
  const copied = await readRegularFileSnapshot(destination, `Copied ${fileName}`)
  if (copied.size !== snapshot.size || copied.sha256 !== snapshot.sha256) {
    throw new TypeError(`Copied file identity changed after destination write: ${fileName}`)
  }
}

let publicationConfiguration
let publicationSource
let publicationCandidateSha256
let expectedPublicationInventory
const outputTransaction = await beginDirectoryReplacement(
  outputInput,
  'Release output directory',
  {
    beforePublish: async ({ inventory }) => {
      if (
        !publicationConfiguration
        || !publicationSource
        || !publicationCandidateSha256
        || !expectedPublicationInventory
      ) throw new TypeError('Final release publication guard was not initialized')
      const immediateSource = await verifyReleaseSourceState(publicationConfiguration)
      assertCanonicalSnapshotUnchanged(publicationSource, immediateSource, 'Release source')
      assertPublicationInventory(
        expectedPublicationInventory,
        inventory,
        'Final release evidence inventory',
      )
      const candidateRecord = inventory.records.find(
        (record) => record.fileName === publicationConfiguration.releaseAssetFilename,
      )
      if (candidateRecord?.sha256 !== publicationCandidateSha256) {
        throw new TypeError('Exact candidate identity changed before final publication')
      }
    },
  },
)
const outputDirectory = outputTransaction.targetDirectory
const stagingDirectory = outputTransaction.stagingDirectory

try {
  const configuration = await loadReleaseConfiguration()
  const source = await verifyReleaseSourceState(configuration)
  publicationConfiguration = configuration
  publicationSource = source
  const state = validateFinalCandidateState(
    await readCanonicalJSON(
      path.join(outputDirectory, 'candidate-state.json'),
      'candidate-state.json',
    ),
    configuration,
    source,
  )
  const expectedCandidateFiles = sortStrings([
    ...state.artifacts.map((artifact) => artifact.fileName),
    'candidate-state.json',
  ])
  const initialFiles = sortStrings(await readdir(outputDirectory))
  if (JSON.stringify(initialFiles) !== JSON.stringify(expectedCandidateFiles)) {
    throw new TypeError('Candidate output directory has missing or unexpected files before finalization')
  }
  for (const [index, artifact] of state.artifacts.entries()) {
    assertExactKeys(artifact, ['fileName', 'size', 'sha256'], [], `candidate state artifacts[${index}]`)
    if (artifact.fileName !== path.basename(artifact.fileName)) {
      throw new TypeError('Candidate state has unsafe filename')
    }
    const actual = await hashFile(path.join(outputDirectory, artifact.fileName))
    if (actual.size !== artifact.size || actual.digest !== artifact.sha256) {
      throw new TypeError(`Candidate artifact changed after generation: ${artifact.fileName}`)
    }
  }

  const regenerated = await revalidateReleaseCandidate({ outputDirectory, configuration, source })
  const sourceAfterRevalidation = await verifyReleaseSourceState(configuration)
  if (canonicalJSONString(sourceAfterRevalidation) !== canonicalJSONString(source)) {
    throw new TypeError('Release source changed during independent candidate revalidation')
  }

  const stateSnapshot = await readRegularFileSnapshot(
    path.join(outputDirectory, 'candidate-state.json'),
    'candidate-state.json',
  )
  if (!stateSnapshot.bytes.equals(Buffer.from(canonicalJSONString(state)))) {
    throw new TypeError('Candidate state changed during independent revalidation')
  }
  const candidateSnapshots = new Map([['candidate-state.json', stateSnapshot]])
  for (const artifact of state.artifacts) {
    const snapshot = await readRegularFileSnapshot(
      path.join(outputDirectory, artifact.fileName),
      `Candidate artifact ${artifact.fileName}`,
    )
    if (snapshot.size !== artifact.size || snapshot.sha256 !== artifact.sha256) {
      throw new TypeError(`Candidate artifact changed during independent revalidation: ${artifact.fileName}`)
    }
    candidateSnapshots.set(artifact.fileName, snapshot)
  }
  const finalCandidateFiles = sortStrings(await readdir(outputDirectory))
  if (JSON.stringify(finalCandidateFiles) !== JSON.stringify(expectedCandidateFiles)) {
    throw new TypeError('Candidate output directory changed during independent revalidation')
  }

  const candidateIdentity = state.artifacts.find(
    (artifact) => artifact.fileName === configuration.releaseAssetFilename,
  )
  if (!candidateIdentity) throw new TypeError('Candidate state is missing the package tarball identity')
  if (regenerated.inspection.tarball.sha256 !== candidateIdentity.sha256) {
    throw new TypeError('Independently inspected candidate identity does not match candidate state')
  }
  publicationCandidateSha256 = candidateIdentity.sha256

  const validationInputSnapshot = await readExternalRegularFile(
    validationInput,
    'Validation input path',
    1024 * 1024,
  )
  const rawValidationInput = parseJSONBytes(
    validationInputSnapshot.bytes,
    'Validation summary input',
  )
  await validateReleaseSchema(
    'validation-summary-input.schema.json',
    rawValidationInput,
    'Validation summary input',
  )
  const validationInputValue = validateValidationSummary(
    rawValidationInput,
    source.commit,
    candidateIdentity.sha256,
  )
  const validationLogNames = new Set()
  let validationLogCount = 0
  const normalizedGates = []
  const logSnapshots = new Map()
  for (const gate of validationInputValue.gates) {
    const logs = []
    for (const log of gate.logs) {
      if (log.fileName !== path.basename(log.fileName) || validationLogNames.has(log.fileName)) {
        throw new TypeError(`Validation log filename is unsafe or duplicated: ${log.fileName}`)
      }
      validationLogNames.add(log.fileName)
      const snapshot = await readExternalRegularFile(
        log.path,
        `Validation log ${log.fileName}`,
        MAX_VALIDATION_GATE_LOG_BYTES,
      )
      if (snapshot.size !== log.size || snapshot.sha256 !== log.sha256) {
        throw new TypeError(`Validation log identity mismatch: ${log.fileName}`)
      }
      const text = decodeValidationLog(snapshot.bytes, log.fileName)
      parseValidationGateReceipt(text, {
        gateId: gate.id,
        sourceCommit: source.commit,
        candidateSha256: candidateIdentity.sha256,
      })
      logSnapshots.set(log.fileName, snapshot)
      logs.push({ fileName: log.fileName, size: snapshot.size, sha256: snapshot.sha256 })
      validationLogCount += 1
    }
    normalizedGates.push({ id: gate.id, command: gate.command, result: gate.result, logs })
  }
  const validation = {
    schemaVersion: 1,
    package: validationInputValue.package,
    sourceCommit: validationInputValue.sourceCommit,
    candidateSha256: validationInputValue.candidateSha256,
    gateCount: normalizedGates.length,
    logCount: validationLogCount,
    gates: normalizedGates,
  }
  await validateReleaseSchema('validation-summary.schema.json', validation, 'Validation summary')

  for (const fileName of expectedCandidateFiles) {
    await writeVerifiedSnapshot(stagingDirectory, fileName, candidateSnapshots.get(fileName))
  }
  for (const fileName of sortStrings(validationLogNames)) {
    await writeVerifiedSnapshot(stagingDirectory, fileName, logSnapshots.get(fileName))
  }
  await writeCanonicalJSON(path.join(stagingDirectory, 'validation-summary.json'), validation)
  const packageManifest = await readJSON(path.join(repositoryRoot, 'package.json'))
  const manifest = await createArtifactManifest({
    outputDirectory: stagingDirectory,
    configuration,
    source,
    packageManifest,
  })
  const manifestBytes = canonicalJSONString(manifest)
  await writeFile(path.join(stagingDirectory, 'artifact-manifest.json'), manifestBytes, {
    encoding: 'utf8',
    flag: 'wx',
  })
  const manifestSha256 = sha256Bytes(Buffer.from(manifestBytes))
  await writeFile(
    path.join(stagingDirectory, 'artifact-manifest.json.sha256'),
    `${manifestSha256}  artifact-manifest.json\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  const expectedFinalFiles = sortStrings([
    ...expectedCandidateFiles,
    ...validationLogNames,
    'validation-summary.json',
    'artifact-manifest.json',
    'artifact-manifest.json.sha256',
  ])
  const actualFinalFiles = sortStrings(await readdir(stagingDirectory))
  if (JSON.stringify(actualFinalFiles) !== JSON.stringify(expectedFinalFiles)) {
    throw new TypeError('Finalized evidence directory has missing or unexpected files')
  }
  for (const fileName of expectedFinalFiles) {
    await hashFile(path.join(stagingDirectory, fileName))
  }
  const finalSource = await verifyReleaseSourceState(configuration)
  assertCanonicalSnapshotUnchanged(source, finalSource, 'Release source')
  expectedPublicationInventory = await snapshotExactFlatDirectory(
    stagingDirectory,
    expectedFinalFiles,
    'Final release evidence',
  )
  await outputTransaction.commit()
  process.stdout.write(`Finalized release evidence manifest SHA-256 ${manifestSha256}\n`)
} catch (error) {
  await outputTransaction.rollback()
  throw error
}

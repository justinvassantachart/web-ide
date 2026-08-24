import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createArtifactManifest } from './artifact-manifest.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertCanonicalSnapshotUnchanged,
  assertPublicationInventory,
  snapshotExactFlatDirectory,
} from './publication-guard.mjs'
import {
  validatePreflightCandidateState,
  validateValidationSummary,
  VALIDATION_GATES,
} from './release-inputs.mjs'
import {
  hashFile,
  readCanonicalJSON,
  readJSON,
  readRegularFileSnapshot,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
  writeCanonicalJSON,
} from './release-utils.mjs'
import { revalidateReleaseCandidate } from './revalidate-release-candidate.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'
import { beginDirectoryReplacement } from './transactional-output.mjs'
import {
  createPreflightValidationGateReceipt,
  parsePreflightValidationGateReceipt,
  preflightValidationGateReceiptFooter,
} from './validation-gate-receipt.mjs'
import { validateReleaseSchema } from './validate-release-schema.mjs'

async function writeSnapshot(directory, fileName, snapshot) {
  const destination = path.join(directory, fileName)
  await writeFile(destination, snapshot.bytes, { flag: 'wx' })
  const copied = await readRegularFileSnapshot(destination, `Preflight copy ${fileName}`)
  if (copied.size !== snapshot.size || copied.sha256 !== snapshot.sha256) {
    throw new TypeError(`Preflight finalization copy changed: ${fileName}`)
  }
}

export async function exercisePreflightFinalization({
  outputDirectory,
  configuration,
  source,
  fixtureRemote,
}) {
  if (fixtureRemote !== source.remote) {
    throw new TypeError('Preflight finalization fixture remote does not match verified source state')
  }
  const state = validatePreflightCandidateState(
    await readCanonicalJSON(
      path.join(outputDirectory, 'candidate-state.json'),
      'preflight candidate-state.json',
    ),
    configuration,
    source,
  )
  const regenerated = await revalidateReleaseCandidate({
    outputDirectory,
    configuration,
    source,
    sourceOptions: { nonreleaseFixtureRemote: fixtureRemote },
  })
  const candidateIdentity = state.artifacts.find(
    (artifact) => artifact.fileName === configuration.releaseAssetFilename,
  )
  if (
    !candidateIdentity
    || candidateIdentity.sha256 !== regenerated.inspection.tarball.sha256
  ) throw new TypeError('Preflight finalization candidate identity is incomplete')

  const candidateNames = sortStrings([
    ...state.artifacts.map((artifact) => artifact.fileName),
    'candidate-state.json',
  ])
  const snapshots = new Map()
  for (const fileName of candidateNames) {
    snapshots.set(fileName, await readRegularFileSnapshot(
      path.join(outputDirectory, fileName),
      `Preflight candidate ${fileName}`,
    ))
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'web-ide-finalize-preflight-'))
  const candidateCopy = path.join(temporaryRoot, 'candidate')
  await mkdir(candidateCopy)
  try {
    for (const fileName of candidateNames) {
      await writeSnapshot(candidateCopy, fileName, snapshots.get(fileName))
    }
    let expectedPublicationInventory
    const transaction = await beginDirectoryReplacement(
      candidateCopy,
      'Preflight finalization directory',
      {
        beforePublish: async ({ inventory }) => {
          const immediateSource = await verifyReleaseSourceState(
            configuration,
            repositoryRoot,
            { nonreleaseFixtureRemote: fixtureRemote },
          )
          assertCanonicalSnapshotUnchanged(source, immediateSource, 'Preflight release source')
          assertPublicationInventory(
            expectedPublicationInventory,
            inventory,
            'Preflight finalization inventory',
          )
        },
      },
    )
    try {
      const gateInput = []
      const normalizedGates = []
      for (const gate of VALIDATION_GATES) {
        const receipt = createPreflightValidationGateReceipt({
          gateId: gate.id,
          sourceCommit: source.commit,
          candidateSha256: candidateIdentity.sha256,
        })
        const bytes = Buffer.from(
          `NON-RELEASE synthetic orchestration receipt for ${gate.id}\n`
            + preflightValidationGateReceiptFooter(receipt),
        )
        const fileName = `nonrelease-${gate.id}.log`
        const logPath = path.join(temporaryRoot, fileName)
        await writeFile(logPath, bytes, { flag: 'wx' })
        const snapshot = await readRegularFileSnapshot(logPath, `Preflight ${gate.id} log`)
        parsePreflightValidationGateReceipt(snapshot.bytes.toString('utf8'), {
          gateId: gate.id,
          sourceCommit: source.commit,
          candidateSha256: candidateIdentity.sha256,
        })
        gateInput.push({
          id: gate.id,
          command: gate.command,
          result: 'pass',
          logs: [{
            path: logPath,
            fileName,
            size: snapshot.size,
            sha256: snapshot.sha256,
          }],
        })
        normalizedGates.push({
          id: gate.id,
          command: gate.command,
          result: 'pass',
          logs: [{ fileName, size: snapshot.size, sha256: snapshot.sha256 }],
        })
        snapshots.set(fileName, snapshot)
      }
      const input = {
        schemaVersion: 1,
        package: configuration.package,
        sourceCommit: source.commit,
        candidateSha256: candidateIdentity.sha256,
        gates: gateInput,
      }
      await validateReleaseSchema(
        'validation-summary-input.schema.json',
        input,
        'Nonrelease finalization input',
      )
      validateValidationSummary(input, source.commit, candidateIdentity.sha256)
      const validation = {
        schemaVersion: 1,
        package: configuration.package,
        sourceCommit: source.commit,
        candidateSha256: candidateIdentity.sha256,
        gateCount: normalizedGates.length,
        logCount: normalizedGates.length,
        gates: normalizedGates,
      }
      await validateReleaseSchema(
        'validation-summary.schema.json',
        validation,
        'Nonrelease finalization summary',
      )
      for (const fileName of candidateNames) {
        await writeSnapshot(transaction.stagingDirectory, fileName, snapshots.get(fileName))
      }
      for (const gate of normalizedGates) {
        const fileName = gate.logs[0].fileName
        await writeSnapshot(transaction.stagingDirectory, fileName, snapshots.get(fileName))
      }
      await writeCanonicalJSON(
        path.join(transaction.stagingDirectory, 'validation-summary.json'),
        validation,
      )
      const manifest = await createArtifactManifest({
        outputDirectory: transaction.stagingDirectory,
        configuration,
        source,
        packageManifest: await readJSON(path.join(repositoryRoot, 'package.json')),
      })
      const manifestBytes = Buffer.from(canonicalJSONString(manifest))
      const manifestSha256 = sha256Bytes(manifestBytes)
      await writeFile(
        path.join(transaction.stagingDirectory, 'artifact-manifest.json'),
        manifestBytes,
        { flag: 'wx' },
      )
      await writeFile(
        path.join(transaction.stagingDirectory, 'artifact-manifest.json.sha256'),
        `${manifestSha256}  artifact-manifest.json\n`,
        { encoding: 'utf8', flag: 'wx' },
      )
      const expected = sortStrings([
        ...candidateNames,
        ...normalizedGates.map((gate) => gate.logs[0].fileName),
        'validation-summary.json',
        'artifact-manifest.json',
        'artifact-manifest.json.sha256',
      ])
      if (JSON.stringify(sortStrings(await readdir(transaction.stagingDirectory))) !== JSON.stringify(expected)) {
        throw new TypeError('Nonrelease finalization exercise did not close over its exact file set')
      }
      for (const fileName of expected) {
        await hashFile(path.join(transaction.stagingDirectory, fileName))
      }
      expectedPublicationInventory = await snapshotExactFlatDirectory(
        transaction.stagingDirectory,
        expected,
        'Nonrelease finalization evidence',
      )
      await transaction.commit()
      return {
        schemaVersion: 1,
        result: 'nonrelease-finalization-exercised',
        finalizable: false,
        sourceCommit: source.commit,
        candidateSha256: candidateIdentity.sha256,
        draftManifestSha256: manifestSha256,
        gateCount: normalizedGates.length,
        logCount: normalizedGates.length,
        candidateIndependentlyRevalidated: true,
        transactionalDirectoryReplacementExercised: true,
      }
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runBoundedCommandLog } from './bounded-command-log.mjs'
import {
  loadReleaseConfiguration,
  MAX_VALIDATION_GATE_LOG_BYTES,
  VALIDATION_GATE_TIMEOUT_MS,
  validateFinalCandidateState,
  VALIDATION_GATES,
} from './release-inputs.mjs'
import {
  assertExternalOutputPath,
  hashFile,
  readCanonicalJSON,
  repositoryRoot,
} from './release-utils.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'
import {
  createValidationGateReceipt,
  parseValidationGateReceipt,
  validationGateReceiptFooter,
} from './validation-gate-receipt.mjs'
import {
  defaultPlaywrightBrowsersPath,
  withValidationGateEnvironment,
} from './validation-gate-environment.mjs'
import {
  assertTrustedValidationLogDirectory,
  normalizeValidationGateLogFile,
  removeOwnedValidationGateLog,
} from './validation-log.mjs'

const localGateIds = new Set([
  'validate-production',
  'consumer-exact-candidate',
  'audit-production',
  'audit-full',
])
const gateId = process.argv[2]
if (!localGateIds.has(gateId)) throw new TypeError('A supported local validation gate ID is required')
const outputInput = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
const logInput = process.env.WEB_IDE_RELEASE_GATE_LOG
if (!outputInput || !logInput) {
  throw new TypeError('WEB_IDE_RELEASE_OUTPUT_DIR and WEB_IDE_RELEASE_GATE_LOG are required')
}
const outputDirectory = await assertExternalOutputPath(outputInput, 'Release candidate directory')
const logPath = await assertExternalOutputPath(logInput, 'Validation gate log')
try {
  await lstat(path.resolve(logInput))
  throw new TypeError('Validation gate log path must not already exist')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const configuration = await loadReleaseConfiguration()
const source = await verifyReleaseSourceState(configuration)
const state = validateFinalCandidateState(
  await readCanonicalJSON(path.join(outputDirectory, 'candidate-state.json'), 'candidate-state.json'),
  configuration,
  source,
)
const candidateIdentity = state.artifacts.find(
  (artifact) => artifact.fileName === configuration.releaseAssetFilename,
)
if (!candidateIdentity) throw new TypeError('Candidate state has no package identity')
const candidatePath = path.join(outputDirectory, configuration.releaseAssetFilename)
const initialCandidate = await hashFile(candidatePath)
if (
  initialCandidate.size !== candidateIdentity.size
  || initialCandidate.digest !== candidateIdentity.sha256
) throw new TypeError('Candidate package does not match candidate state')

const gate = VALIDATION_GATES.find((candidate) => candidate.id === gateId)
const npmExecutable = process.platform === 'win32' ? 'npm' : path.join(path.dirname(process.execPath), 'npm')
const invocation = gateId === 'validate-production'
  ? { arguments: ['run', 'validate:production'], candidateTarball: undefined }
  : gateId === 'consumer-exact-candidate'
    ? {
        arguments: ['run', 'test:consumer'],
        candidateTarball: candidatePath,
      }
    : gateId === 'audit-production'
      ? { arguments: ['audit', '--omit=dev'], candidateTarball: undefined }
      : { arguments: ['audit'], candidateTarball: undefined }

const temporaryLogPath = path.join(
  path.dirname(logPath),
  `.${path.basename(logPath)}.partial-${randomUUID()}`,
)
await assertTrustedValidationLogDirectory(logPath)
let logComplete = false
let publishedLogIdentity
let rawLogIdentity
try {
  await withValidationGateEnvironment({
    candidateTarball: invocation.candidateTarball,
    playwrightBrowsersPath: defaultPlaywrightBrowsersPath(),
  }, async ({ environment, paths }) => {
    let receiptFooter
    const capture = await runBoundedCommandLog({
      command: npmExecutable,
      arguments: invocation.arguments,
      cwd: repositoryRoot,
      env: environment,
      outputPath: temporaryLogPath,
      maximumBytes: MAX_VALIDATION_GATE_LOG_BYTES,
      timeoutMs: VALIDATION_GATE_TIMEOUT_MS,
      footerForSuccessfulExit: async (exitCode) => {
        const finalSource = await verifyReleaseSourceState(configuration)
        if (finalSource.commit !== source.commit) throw new TypeError('Source identity changed during validation gate')
        const finalCandidate = await hashFile(candidatePath)
        if (
          finalCandidate.size !== initialCandidate.size
          || finalCandidate.digest !== initialCandidate.digest
        ) throw new TypeError('Candidate package changed during validation gate')
        const receipt = createValidationGateReceipt({
          gateId,
          sourceCommit: source.commit,
          candidateSha256: candidateIdentity.sha256,
          exitCode,
          emitter: gate.receiptEmitter,
        })
        receiptFooter = validationGateReceiptFooter(receipt)
        return Buffer.from(receiptFooter)
      },
    })
    rawLogIdentity = capture.fileIdentity
    if (!receiptFooter) throw new TypeError('Validation gate did not produce its receipt footer')
    const normalized = await normalizeValidationGateLogFile({
      rawLogPath: temporaryLogPath,
      outputPath: logPath,
      expectedRawIdentity: capture.fileIdentity,
      maximumBytes: MAX_VALIDATION_GATE_LOG_BYTES,
      receiptFooter,
      roots: {
        repository: [repositoryRoot],
        home: [paths.home, os.homedir(), process.env.HOME].filter(Boolean),
        candidate: [outputDirectory],
        temporary: [paths.temporary, paths.workspace, os.tmpdir()],
      },
    })
    rawLogIdentity = undefined
    publishedLogIdentity = normalized.fileIdentity
    parseValidationGateReceipt(normalized.text, {
      gateId,
      sourceCommit: source.commit,
      candidateSha256: candidateIdentity.sha256,
    })
  })
  logComplete = true
} finally {
  if (!logComplete && publishedLogIdentity) {
    await removeOwnedValidationGateLog(logPath, publishedLogIdentity)
  }
  if (!logComplete && rawLogIdentity) {
    await removeOwnedValidationGateLog(temporaryLogPath, rawLogIdentity)
  }
}
process.stdout.write(`Validation gate ${gateId} passed; normalized receipt log written to ${logPath}\n`)

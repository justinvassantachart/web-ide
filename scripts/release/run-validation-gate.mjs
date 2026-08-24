import { randomUUID } from 'node:crypto'
import { link, lstat, rm, unlink } from 'node:fs/promises'
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
  validationGateReceiptFooter,
} from './validation-gate-receipt.mjs'

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
  ? { arguments: ['run', 'validate:production'], environment: {} }
  : gateId === 'consumer-exact-candidate'
    ? {
        arguments: ['run', 'test:consumer'],
        environment: { WEB_IDE_CANDIDATE_TARBALL: candidatePath },
      }
    : gateId === 'audit-production'
      ? { arguments: ['audit', '--omit=dev'], environment: {} }
      : { arguments: ['audit'], environment: {} }
const commandEnvironment = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: process.env.HOME ?? os.homedir(),
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  TZ: 'UTC',
  LANG: 'C',
  LC_ALL: 'C',
  CI: 'true',
  NO_UPDATE_NOTIFIER: '1',
  npm_config_registry: 'https://registry.npmjs.org/',
  npm_config_globalconfig: '/dev/null',
  npm_config_userconfig: '/dev/null',
  npm_config_strict_ssl: 'true',
  npm_config_ignore_scripts: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
    : {}),
  ...invocation.environment,
}

const temporaryLogPath = path.join(
  path.dirname(logPath),
  `.${path.basename(logPath)}.partial-${randomUUID()}`,
)
let logComplete = false
try {
  await runBoundedCommandLog({
    command: npmExecutable,
    arguments: invocation.arguments,
    cwd: repositoryRoot,
    env: commandEnvironment,
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
      return Buffer.from(validationGateReceiptFooter(receipt))
    },
  })
  logComplete = true
} finally {
  if (!logComplete) await rm(temporaryLogPath, { force: true })
}
try {
  await link(temporaryLogPath, logPath)
  await unlink(temporaryLogPath)
} catch (error) {
  await rm(temporaryLogPath, { force: true })
  throw error
}
process.stdout.write(`Validation gate ${gateId} passed; receipt appended to ${logPath}\n`)

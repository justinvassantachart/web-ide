import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  readJSON,
  repositoryRoot,
} from './release-utils.mjs'

export const VALIDATION_GATES = Object.freeze([
  Object.freeze({
    id: 'validate-production',
    command: 'npm run validate:production',
    receiptEmitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
  }),
  Object.freeze({
    id: 'consumer-exact-candidate',
    command: 'WEB_IDE_CANDIDATE_TARBALL=<candidate> npm run test:consumer',
    receiptEmitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
  }),
  Object.freeze({
    id: 'audit-production',
    command: 'npm audit --omit=dev',
    receiptEmitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
  }),
  Object.freeze({
    id: 'audit-full',
    command: 'npm audit',
    receiptEmitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
  }),
  Object.freeze({
    id: 'karel-compatibility',
    command: 'Karel exact-candidate compatibility gate',
    receiptEmitter: 'karel:release-compatibility-gate@2',
  }),
])

export const MAX_VALIDATION_GATE_LOG_BYTES = 16 * 1024 * 1024
export const VALIDATION_GATE_TIMEOUT_MS = 30 * 60 * 1000

export async function loadReleaseConfiguration() {
  const input = await readJSON(path.join(repositoryRoot, 'release/release-input.json'))
  assertExactKeys(
    input,
    [
      'schemaVersion',
      'package',
      'sourceRepository',
      'sourceTag',
      'sourceAssetFilename',
      'capabilityReleaseId',
      'packageRole',
      'releaseRepository',
      'releaseTag',
      'releaseAssetFilename',
      'nodeVersion',
      'npmVersion',
    ],
    [],
    'release input',
  )
  if (input.schemaVersion !== 1 || input.package !== 'web-ide@0.3.0') {
    throw new TypeError('Unsupported release input identity')
  }
  for (const field of Object.keys(input).filter((key) => key !== 'schemaVersion')) {
    assertNonEmptyString(input[field], `release input.${field}`)
  }
  if (input.capabilityReleaseId !== 'hamilton.python-karel/2' || input.packageRole !== 'web-ide') {
    throw new TypeError('Release input does not match the accepted Hamilton composition identity')
  }
  if (input.sourceTag !== 'web-ide-v0.3.0-source') {
    throw new TypeError('Release input does not use the forward-only Web IDE 0.3 source tag')
  }
  if (input.releaseAssetFilename !== 'web-ide-0.3.0.tgz' || input.sourceAssetFilename !== 'web-ide-0.3.0-source.tar.gz') {
    throw new TypeError('Release asset names do not match the accepted Web IDE 0.3 identity')
  }
  return input
}

export function validateValidationSummary(summary, sourceCommit, candidateSha256) {
  assertExactKeys(
    summary,
    ['schemaVersion', 'package', 'sourceCommit', 'candidateSha256', 'gates'],
    [],
    'validation summary',
  )
  if (summary.schemaVersion !== 1 || summary.package !== 'web-ide@0.3.0') {
    throw new TypeError('Unsupported validation summary identity')
  }
  if (summary.sourceCommit !== sourceCommit) throw new TypeError('Validation summary sourceCommit does not match HEAD')
  if (summary.candidateSha256 !== candidateSha256 || !/^[a-f0-9]{64}$/u.test(summary.candidateSha256)) {
    throw new TypeError('Validation summary candidateSha256 does not match the exact candidate')
  }
  if (!Array.isArray(summary.gates)) throw new TypeError('validation summary gates must be an array')
  if (summary.gates.length !== VALIDATION_GATES.length) throw new TypeError('Validation summary has an incomplete gate set')
  for (const [index, gate] of summary.gates.entries()) {
    assertExactKeys(gate, ['id', 'command', 'result', 'logs'], [], `validation summary gates[${index}]`)
    const expected = VALIDATION_GATES[index]
    if (gate.id !== expected.id || gate.command !== expected.command || gate.result !== 'pass') {
      throw new TypeError(`Validation gate ${gate.id} is not an exact pass record`)
    }
    if (!Array.isArray(gate.logs) || gate.logs.length !== 1) {
      throw new TypeError(`Validation gate ${gate.id} must have exactly one machine-receipted normalized log`)
    }
    for (const [logIndex, log] of gate.logs.entries()) {
      const location = `validation summary gates[${index}].logs[${logIndex}]`
      assertExactKeys(log, ['path', 'fileName', 'size', 'sha256'], [], location)
      assertNonEmptyString(log.path, `${location}.path`)
      assertNonEmptyString(log.fileName, `${location}.fileName`)
      if (
        !Number.isSafeInteger(log.size)
        || log.size <= 0
        || log.size > MAX_VALIDATION_GATE_LOG_BYTES
        || !/^[a-f0-9]{64}$/u.test(log.sha256)
      ) {
        throw new TypeError(`${location} has invalid size or SHA-256`)
      }
    }
  }
  return summary
}

export function validateFinalCandidateState(state, configuration, source) {
  assertExactKeys(
    state,
    ['schemaVersion', 'package', 'result', 'source', 'capabilityReleaseId', 'packageRole', 'artifacts'],
    [],
    'candidate state',
  )
  if (
    state.schemaVersion !== 1
    || state.package !== configuration.package
    || state.result !== 'candidate-generated'
    || state.capabilityReleaseId !== configuration.capabilityReleaseId
    || state.packageRole !== configuration.packageRole
  ) throw new TypeError('Candidate state is not a final candidate for the current verified source')
  assertExactKeys(
    state.source,
    [
      'branch', 'commit', 'tree', 'tag', 'remote', 'commitTimestamp',
      'sourceDateEpoch', 'nodeVersion', 'npmVersion',
    ],
    [],
    'candidate state source',
  )
  assertExactKeys(state.source.tag, ['name', 'objectId', 'objectType', 'peeledCommit'], [], 'candidate state source.tag')
  if (
    canonicalJSONString(state.source) !== canonicalJSONString(source)
  ) throw new TypeError('Candidate state is not a final candidate for the current verified source')
  if (!Array.isArray(state.artifacts) || state.artifacts.length !== 10) {
    throw new TypeError('Candidate state artifacts must contain the exact candidate evidence set')
  }
  const names = []
  for (const [index, artifact] of state.artifacts.entries()) {
    const location = `candidate state artifacts[${index}]`
    assertExactKeys(artifact, ['fileName', 'size', 'sha256'], [], location)
    assertNonEmptyString(artifact.fileName, `${location}.fileName`)
    if (
      artifact.fileName !== path.basename(artifact.fileName)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size <= 0
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) throw new TypeError(`${location} has invalid file identity`)
    names.push(artifact.fileName)
  }
  const expectedNames = [
    configuration.releaseAssetFilename,
    configuration.sourceAssetFilename,
    'bundle-provenance.json',
    'deterministic-builds.json',
    'package-inspection.json',
    'runtime-assets-verification.json',
    'runtime-source-provenance.json',
    'third-party-licenses.json',
    'THIRD_PARTY_LICENSES.txt',
    'web-ide-0.3.0.cdx.json',
  ].sort()
  if (JSON.stringify(names) !== JSON.stringify(expectedNames) || new Set(names).size !== names.length) {
    throw new TypeError('Candidate state artifact identities are incomplete, duplicated, or unsorted')
  }
  return state
}

export function validatePreflightCandidateState(state, configuration, source) {
  assertExactKeys(
    state,
    [
      'schemaVersion', 'package', 'result', 'source', 'capabilityReleaseId',
      'packageRole', 'artifacts', 'preflightFixture',
    ],
    [],
    'preflight candidate state',
  )
  assertExactKeys(
    state.preflightFixture,
    ['mode', 'remote', 'finalizable'],
    [],
    'preflight candidate state fixture',
  )
  if (
    state.result !== 'nonrelease-preflight'
    || state.preflightFixture.mode !== 'disposable-local-remote'
    || state.preflightFixture.remote !== source.remote
    || state.preflightFixture.finalizable !== false
  ) throw new TypeError('Preflight candidate state does not identify the disposable nonrelease fixture')
  const candidateState = { ...state }
  delete candidateState.preflightFixture
  validateFinalCandidateState(
    { ...candidateState, result: 'candidate-generated' },
    configuration,
    source,
  )
  return state
}

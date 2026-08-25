import { canonicalJSONString } from './canonical-json.mjs'
import { VALIDATION_GATES } from './release-inputs.mjs'
import { assertExactKeys } from './release-utils.mjs'

export const VALIDATION_GATE_RECEIPT_PREFIX = '@@WEB_IDE_RELEASE_GATE_RECEIPT@@'
export const PREFLIGHT_VALIDATION_GATE_RECEIPT_PREFIX = '@@WEB_IDE_NONRELEASE_PREFLIGHT_GATE_RECEIPT@@'
const PREFLIGHT_RECEIPT_EMITTER = 'web-ide:scripts/release/exercise-preflight-finalization.mjs@1'

function expectedGate(gateId) {
  const gate = VALIDATION_GATES.find((candidate) => candidate.id === gateId)
  if (!gate) throw new TypeError(`Unknown validation gate ${JSON.stringify(gateId)}`)
  return gate
}

export function createValidationGateReceipt({
  gateId,
  sourceCommit,
  candidateSha256,
  exitCode,
  emitter,
}) {
  const gate = expectedGate(gateId)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new TypeError('Gate receipt source commit is invalid')
  if (!/^[a-f0-9]{64}$/u.test(candidateSha256)) throw new TypeError('Gate receipt candidate SHA-256 is invalid')
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new TypeError('Gate receipt exit code is invalid')
  }
  if (emitter !== gate.receiptEmitter) throw new TypeError('Gate receipt emitter is not the reviewed implementation')
  return {
    schemaVersion: 2,
    receiptKind: 'web-ide-release-validation-gate',
    mode: 'release-gate',
    package: 'web-ide@0.3.1',
    gateId: gate.id,
    sourceCommit,
    candidateSha256,
    command: gate.command,
    exitCode,
    emitter,
  }
}

export function createPreflightValidationGateReceipt({
  gateId,
  sourceCommit,
  candidateSha256,
}) {
  const gate = expectedGate(gateId)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new TypeError('Preflight receipt source commit is invalid')
  if (!/^[a-f0-9]{64}$/u.test(candidateSha256)) throw new TypeError('Preflight receipt candidate SHA-256 is invalid')
  return {
    schemaVersion: 1,
    receiptKind: 'web-ide-nonrelease-preflight-validation-gate',
    mode: 'nonrelease-preflight-synthetic',
    package: 'web-ide@0.3.1',
    gateId: gate.id,
    sourceCommit,
    candidateSha256,
    command: gate.command,
    exitCode: 0,
    emitter: PREFLIGHT_RECEIPT_EMITTER,
  }
}

export function validationGateReceiptFooter(receipt) {
  return `\n${VALIDATION_GATE_RECEIPT_PREFIX}${canonicalJSONString(receipt)}`
}

export function preflightValidationGateReceiptFooter(receipt) {
  return `\n${PREFLIGHT_VALIDATION_GATE_RECEIPT_PREFIX}${canonicalJSONString(receipt)}`
}

function parseReceiptFooter(text, { gateId, prefix, location }) {
  const occurrences = text.split(prefix).length - 1
  if (occurrences !== 1) throw new TypeError(`${location} ${gateId} must contain exactly one machine receipt`)
  const lines = text.replace(/\n+$/u, '').split('\n')
  const footer = lines.at(-1)
  if (!footer?.startsWith(prefix)) {
    throw new TypeError(`${location} ${gateId} machine receipt must be the final log line`)
  }
  let value
  try {
    value = JSON.parse(footer.slice(prefix.length))
  } catch (error) {
    throw new TypeError(`${location} ${gateId} machine receipt is invalid JSON`, { cause: error })
  }
  return { footer, value }
}

export function parseValidationGateReceipt(text, {
  gateId,
  sourceCommit,
  candidateSha256,
}) {
  const { footer, value } = parseReceiptFooter(text, {
    gateId,
    prefix: VALIDATION_GATE_RECEIPT_PREFIX,
    location: 'Validation gate',
  })
  assertExactKeys(
    value,
    [
      'schemaVersion', 'receiptKind', 'mode', 'package', 'gateId', 'sourceCommit',
      'candidateSha256', 'command', 'exitCode', 'emitter',
    ],
    [],
    `validation gate ${gateId} receipt`,
  )
  const expected = createValidationGateReceipt({
    gateId,
    sourceCommit,
    candidateSha256,
    exitCode: 0,
    emitter: expectedGate(gateId).receiptEmitter,
  })
  if (canonicalJSONString(value) !== canonicalJSONString(expected)) {
    throw new TypeError(`Validation gate ${gateId} machine receipt does not bind the exact pass`)
  }
  if (footer !== `${VALIDATION_GATE_RECEIPT_PREFIX}${canonicalJSONString(value).trimEnd()}`) {
    throw new TypeError(`Validation gate ${gateId} machine receipt is not canonical`)
  }
  return value
}

export function parsePreflightValidationGateReceipt(text, {
  gateId,
  sourceCommit,
  candidateSha256,
}) {
  const { footer, value } = parseReceiptFooter(text, {
    gateId,
    prefix: PREFLIGHT_VALIDATION_GATE_RECEIPT_PREFIX,
    location: 'Nonrelease preflight gate',
  })
  assertExactKeys(
    value,
    [
      'schemaVersion', 'receiptKind', 'mode', 'package', 'gateId', 'sourceCommit',
      'candidateSha256', 'command', 'exitCode', 'emitter',
    ],
    [],
    `nonrelease preflight gate ${gateId} receipt`,
  )
  const expected = createPreflightValidationGateReceipt({ gateId, sourceCommit, candidateSha256 })
  if (canonicalJSONString(value) !== canonicalJSONString(expected)) {
    throw new TypeError(`Nonrelease preflight gate ${gateId} receipt does not bind the exact fixture`)
  }
  if (footer !== `${PREFLIGHT_VALIDATION_GATE_RECEIPT_PREFIX}${canonicalJSONString(value).trimEnd()}`) {
    throw new TypeError(`Nonrelease preflight gate ${gateId} receipt is not canonical`)
  }
  return value
}

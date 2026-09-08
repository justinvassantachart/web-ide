import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import type {
  RuntimeHostChannelLimitsV1,
  RuntimeHostServiceV1,
} from '../../src/web-ide/contracts/runtime'
import type {
  TestRunRequestV2,
  TestSelectionV2,
} from '../../src/web-ide/contracts/testing'
import { validateRuntimeHostServiceV1 } from '../../src/runtimes/host-service'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

// Test-only replicas of the reviewed R-P01 and companion public boundaries.
// Bidirectional assignments make drift a compile failure without importing a
// sibling checkout into the package or production graph.
interface R_P01_HostChannelLimitsV1 {
  readonly maxFrameBytes: number
  readonly maxPendingSends: number
  readonly maxInFlightRequests: number
}

interface CompanionTestingV2RunRequestEnvelope {
  readonly apiVersion: 2
  readonly kind: 'run_request'
  readonly mode: 'run' | 'debug'
  readonly workspaceDigest: string
  readonly catalogDigest: string
  readonly selection: TestSelectionV2
}

const runtimeLimitsToEngine: R_P01_HostChannelLimitsV1 = {} as RuntimeHostChannelLimitsV1
const engineLimitsToRuntime: RuntimeHostChannelLimitsV1 = {} as R_P01_HostChannelLimitsV1
const requestToCompanion: CompanionTestingV2RunRequestEnvelope = {} as TestRunRequestV2
const companionToRequest: TestRunRequestV2 = {} as CompanionTestingV2RunRequestEnvelope
type _RuntimeLimitKeysAreExact = Assert<Equal<keyof RuntimeHostChannelLimitsV1, keyof R_P01_HostChannelLimitsV1>>
type _TestingRequestKeysAreExact = Assert<Equal<keyof TestRunRequestV2, keyof CompanionTestingV2RunRequestEnvelope>>
const compileTimeAssertions: readonly [_RuntimeLimitKeysAreExact, _TestingRequestKeysAreExact] = [true, true]
void runtimeLimitsToEngine
void engineLimitsToRuntime
void requestToCompanion
void companionToRequest
void compileTimeAssertions

describe('cross-repository extension seam fixtures', () => {
  it('accepts the exact Testing V2 request envelope against frozen bytes', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL(
      '../fixtures/frozen-contracts/testing-v2.schema.json',
      import.meta.url,
    )), 'utf8'))
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const request: TestRunRequestV2 = {
      apiVersion: 2,
      kind: 'run_request',
      mode: 'debug',
      workspaceDigest: 'a'.repeat(64),
      catalogDigest: 'b'.repeat(64),
      selection: { kind: 'tests', testIds: ['suite:test'] },
    }

    expect(validate(request)).toBe(true)
    expect(Object.keys(request)).toEqual([
      'apiVersion',
      'kind',
      'mode',
      'workspaceDigest',
      'catalogDigest',
      'selection',
    ])
  })

  it('accepts the exact R-P01 limits shape through runtime validation', () => {
    const limits: R_P01_HostChannelLimitsV1 = {
      maxFrameBytes: 16 * 1024,
      maxPendingSends: 32,
      maxInFlightRequests: 32,
    }
    const service: RuntimeHostServiceV1 = {
      capability: 'example.synthetic',
      version: 1,
      limits,
      open: () => ({ dispose() {} }),
    }

    expect(() => validateRuntimeHostServiceV1(service)).not.toThrow()
    expect(Object.keys(limits)).toEqual([
      'maxFrameBytes',
      'maxPendingSends',
      'maxInFlightRequests',
    ])
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_SCHEMA_DIGESTS,
  CONTRACT_SCHEMA_SOURCE_REVISION,
} from '../../src/web-ide/contracts/schema-digests'

const FIXTURE_ROOT = new URL('../fixtures/frozen-contracts/', import.meta.url)

function readFixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(name, FIXTURE_ROOT)))
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('definitive frozen contract bytes', () => {
  it('pins the reviewed source revision and manifest exactly', () => {
    expect(CONTRACT_SCHEMA_SOURCE_REVISION).toBe(
      '53cc934fa0395fd9e55aa48ea3c80543d9445fde',
    )
    expect(sha256(readFixture('schema-manifest.json'))).toBe(CONTRACT_SCHEMA_DIGESTS.manifest)
  })

  it.each([
    ['workspace-transaction.v1.schema.json', 'workspaceTransactionV1'],
    ['testing-v2.schema.json', 'testingV2'],
    ['cpp-compile-profile.v1.schema.json', 'cppCompileProfileV1'],
    ['cpp-build-plan.v1.schema.json', 'cppBuildPlanV1'],
  ] as const)('matches the exact %s bytes', (name, digestKey) => {
    const manifest = JSON.parse(readFixture('schema-manifest.json').toString('utf8')) as {
      schemas: Record<string, string>
    }
    const actual = sha256(readFixture(name))
    expect(actual).toBe(CONTRACT_SCHEMA_DIGESTS[digestKey])
    expect(actual).toBe(manifest.schemas[name])
  })
})

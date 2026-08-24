import { readFile } from 'node:fs/promises'
import path from 'node:path'

import Ajv from 'ajv'

import { repositoryRoot, sha256Bytes } from './release-utils.mjs'

const PINNED_SCHEMAS = [
  {
    fileName: 'cyclonedx-1.6.schema.json',
    sha256: 'bf8177eee4e8979f2ef15dd131f0ef55eaa2168382b5f888ff8a6d1c7e4d09b3',
  },
  {
    fileName: 'cyclonedx-spdx.schema.json',
    sha256: '9688c076891e4147cfe978d5fa3196c740b1ff79b25b146d94178a3db6066180',
  },
  {
    fileName: 'cyclonedx-jsf-0.82.schema.json',
    sha256: '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
  },
]

let validatorPromise

export function parsePinnedCycloneDxSchema(bytes, expectedSha256, location) {
  const actualSha256 = sha256Bytes(bytes)
  if (actualSha256 !== expectedSha256) {
    throw new TypeError(
      `${location} SHA-256 mismatch (expected ${expectedSha256}, found ${actualSha256})`,
    )
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new TypeError(`${location} is not valid JSON`, { cause: error })
  }
}

async function loadValidator() {
  validatorPromise ??= (async () => {
    const [schema, spdxSchema, jsfSchema] = await Promise.all(PINNED_SCHEMAS.map(async ({
      fileName,
      sha256,
    }) => {
      const bytes = await readFile(path.join(repositoryRoot, 'release/schemas', fileName))
      return parsePinnedCycloneDxSchema(bytes, sha256, fileName)
    }))
    const ajv = new Ajv({
      allErrors: true,
      strict: true,
      strictRequired: false,
      validateFormats: false,
    })
    ajv.addKeyword({ keyword: 'meta:enum', schemaType: 'object' })
    ajv.addSchema(spdxSchema, 'http://cyclonedx.org/schema/spdx.schema.json')
    ajv.addSchema(jsfSchema, 'http://cyclonedx.org/schema/jsf-0.82.schema.json')
    return ajv.compile(schema)
  })()
  return await validatorPromise
}

export async function validateCycloneDx(bom) {
  const validate = await loadValidator()
  if (!validate(bom)) {
    const details = validate.errors
      ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new TypeError(`CycloneDX 1.6 schema validation failed: ${details}`)
  }
  return bom
}

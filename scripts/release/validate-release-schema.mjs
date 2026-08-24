import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'

import { readJSON, repositoryRoot } from './release-utils.mjs'

const validators = new Map()

async function loadValidator(schemaFileName) {
  let validator = validators.get(schemaFileName)
  if (validator) return validator
  if (schemaFileName !== path.basename(schemaFileName)) {
    throw new TypeError(`Unsafe release schema filename ${schemaFileName}`)
  }
  const schema = await readJSON(path.join(repositoryRoot, 'release/schemas', schemaFileName))
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  })
  validator = ajv.compile(schema)
  validators.set(schemaFileName, validator)
  return validator
}

export async function validateReleaseSchema(schemaFileName, value, location) {
  const validate = await loadValidator(schemaFileName)
  if (!validate(value)) {
    const details = validate.errors
      ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new TypeError(`${location} failed ${schemaFileName}: ${details}`)
  }
  return value
}

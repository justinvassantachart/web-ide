import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { generateLicenseEvidence } from './licenses.mjs'
import {
  assertExternalOutputPath,
  ensureExternalOutputDirectory,
  readJSON,
  repositoryRoot,
} from './release-utils.mjs'
import { validateRuntimeAssetLock } from './runtime-assets.mjs'
import { validateRuntimeSourceProvenance } from './runtime-source-provenance.mjs'

const provenanceInput = process.env.WEB_IDE_RELEASE_PROVENANCE_PATH
const outputInput = process.env.WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR
if (!provenanceInput || !outputInput) {
  throw new TypeError('WEB_IDE_RELEASE_PROVENANCE_PATH and WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR are required')
}
const provenancePath = await assertExternalOutputPath(provenanceInput, 'Bundle provenance input path')
const outputDirectory = await ensureExternalOutputDirectory(outputInput)
const runtimeLock = validateRuntimeAssetLock(
  await readJSON(path.join(repositoryRoot, 'release/runtime-assets.lock.json')),
)
const runtimeSourceProvenance = validateRuntimeSourceProvenance(
  await readJSON(path.join(repositoryRoot, 'release/runtime-source-provenance.json')),
  runtimeLock,
)
const generated = await generateLicenseEvidence({
  provenancePath,
  runtimeLock,
  runtimeSourceProvenance,
  policy: await readJSON(path.join(repositoryRoot, 'release/license-policy.json')),
  packageLock: await readJSON(path.join(repositoryRoot, 'package-lock.json')),
})
const shipped = await readFile(path.join(repositoryRoot, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
if (generated.textBytes !== shipped) {
  throw new TypeError('Shipped THIRD_PARTY_LICENSES.txt differs from isolated exact-lock generation')
}
await writeFile(path.join(outputDirectory, 'third-party-licenses.json'), generated.reportBytes, {
  encoding: 'utf8',
  flag: 'wx',
})
await writeFile(path.join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'), generated.textBytes, {
  encoding: 'utf8',
  flag: 'wx',
})

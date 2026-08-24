import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { generateLicenseEvidence } from './licenses.mjs'
import { assertExternalOutputPath, readJSON, repositoryRoot } from './release-utils.mjs'
import { validateRuntimeAssetLock } from './runtime-assets.mjs'
import { validateRuntimeSourceProvenance } from './runtime-source-provenance.mjs'

const provenanceInput = process.env.WEB_IDE_RELEASE_PROVENANCE_PATH
if (!provenanceInput) throw new TypeError('WEB_IDE_RELEASE_PROVENANCE_PATH is required')
const provenancePath = await assertExternalOutputPath(provenanceInput, 'Bundle provenance input path')
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
  throw new TypeError('THIRD_PARTY_LICENSES.txt has drifted from exact bundle/runtime license evidence')
}
process.stdout.write(`Verified ${generated.report.records.length} license records and shipped text.\n`)

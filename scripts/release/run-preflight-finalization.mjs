import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import { exercisePreflightFinalization } from './exercise-preflight-finalization.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import { assertExternalOutputPath, repositoryRoot } from './release-utils.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'

const outputInput = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
const remoteInput = process.env.WEB_IDE_RELEASE_PREFLIGHT_REMOTE
if (!outputInput || !remoteInput) {
  throw new TypeError('Preflight finalization requires its external output and disposable remote')
}
const outputDirectory = await assertExternalOutputPath(outputInput, 'Preflight output directory')
const fixtureRemote = await assertExternalOutputPath(remoteInput, 'Preflight fixture remote')
const configuration = await loadReleaseConfiguration()
const source = await verifyReleaseSourceState(configuration, repositoryRoot, {
  nonreleaseFixtureRemote: fixtureRemote,
})
const finalization = await exercisePreflightFinalization({
  outputDirectory,
  configuration,
  source,
  fixtureRemote,
})
await writeFile(
  path.join(outputDirectory, 'NON_RELEASE_PREFLIGHT.json'),
  canonicalJSONString({
    ...finalization,
    reason: 'Disposable local-remote candidate/finalization proof only; production finalization rejects this candidate state and marker.',
  }),
  { encoding: 'utf8', flag: 'wx' },
)

import path from 'node:path'

import {
  ensureExternalOutputDirectory,
  readJSON,
  repositoryRoot,
  writeCanonicalJSON,
} from './release-utils.mjs'
import { verifyRuntimeAssets } from './runtime-assets.mjs'

const outputDirectory = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
if (!outputDirectory) throw new TypeError('WEB_IDE_RELEASE_OUTPUT_DIR is required')

const output = await ensureExternalOutputDirectory(outputDirectory)
const lock = await readJSON(path.join(repositoryRoot, 'release/runtime-assets.lock.json'))
const report = await verifyRuntimeAssets(lock)
await writeCanonicalJSON(path.join(output, 'runtime-assets-verification.json'), report)
process.stdout.write(`Verified ${report.assets.length} exact runtime assets.\n`)

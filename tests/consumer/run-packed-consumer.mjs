import { cp, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { withVerifiedPackedCandidate } from './packed-candidate.mjs'

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureRoot, '../..')
const temporaryArtifacts = await mkdtemp(
  path.join(tmpdir(), 'web-ide-packed-artifact-'),
)
const temporaryConsumer = await mkdtemp(
  path.join(tmpdir(), 'web-ide-packed-consumer-'),
)
const temporaryNpmCache = await mkdtemp(
  path.join(tmpdir(), 'web-ide-packed-npm-cache-'),
)
const excludedParts = new Set(['node_modules', 'dist'])
const npmEnvironment = { ...process.env }
for (const name of Object.keys(npmEnvironment)) {
  if (name.toLowerCase() === 'npm_config_cache') delete npmEnvironment[name]
}
npmEnvironment.npm_config_cache = temporaryNpmCache

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: temporaryConsumer,
    env: npmEnvironment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
  return result.status === 0
}

function packCandidate() {
  const result = spawnSync(
    'npm',
    ['pack', '--pack-destination', temporaryArtifacts, '--silent'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`npm pack failed with status ${result.status ?? 'unknown'}`)
  }

  const packedName = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!packedName) throw new Error('npm pack did not report a candidate tarball')
  return path.resolve(temporaryArtifacts, packedName)
}

async function resolveCandidate() {
  const configuredCandidate = process.env.WEB_IDE_CANDIDATE_TARBALL
  if (configuredCandidate && !path.isAbsolute(configuredCandidate)) {
    throw new Error('WEB_IDE_CANDIDATE_TARBALL must be an absolute path')
  }

  const candidate = configuredCandidate || packCandidate()
  const candidateStat = await stat(candidate)
  if (!candidateStat.isFile()) {
    throw new Error(`Packed candidate is not a file: ${candidate}`)
  }
  return candidate
}

function verifySingleReactIdentity() {
  const result = spawnSync('npm', ['ls', 'react', 'react-dom', '--all', '--json'], {
    cwd: temporaryConsumer,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    return false
  }

  const versions = { react: new Set(), 'react-dom': new Set() }
  const visit = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (name in versions && typeof dependency.version === 'string') {
        versions[name].add(dependency.version)
      }
      visit(dependency)
    }
  }
  visit(JSON.parse(result.stdout))

  const reactVersions = [...versions.react]
  const reactDOMVersions = [...versions['react-dom']]
  const valid = reactVersions.length === 1
    && reactDOMVersions.length === 1
    && reactVersions[0] === reactDOMVersions[0]
  if (!valid) {
    process.stderr.write(
      `Packed consumer resolved unexpected React identities: ${JSON.stringify({
        react: reactVersions,
        'react-dom': reactDOMVersions,
      })}\n`,
    )
    return false
  }
  process.stdout.write(`Packed consumer React identity: ${reactVersions[0]}\n`)
  return true
}

try {
  const candidateTarball = await resolveCandidate()

  await cp(fixtureRoot, temporaryConsumer, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixtureRoot, source)
      return !relative
        .split(path.sep)
        .some((part) => excludedParts.has(part) || part.endsWith('.tsbuildinfo'))
    },
  })
  await withVerifiedPackedCandidate(
    { candidatePath: candidateTarball, consumerRoot: temporaryConsumer },
    () => {
      if (!run('npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit'])) {
        process.exitCode ||= 1
      } else if (!verifySingleReactIdentity()) {
        process.exitCode ||= 1
      } else if (!run('npm', ['audit', '--omit=dev', '--audit-level=low'])) {
        process.exitCode ||= 1
      } else if (!run('npm', ['run', 'build'])) {
        process.exitCode ||= 1
      }
    },
  )
} finally {
  await Promise.all([
    rm(temporaryArtifacts, { recursive: true, force: true }),
    rm(temporaryConsumer, { recursive: true, force: true }),
    rm(temporaryNpmCache, { recursive: true, force: true }),
  ])
}

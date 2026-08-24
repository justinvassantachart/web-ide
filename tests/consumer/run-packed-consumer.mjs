import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { withVerifiedPackedCandidate } from './packed-candidate.mjs'
import { validateConsumerFixtureValues } from '../../scripts/release/consumer-fixture.mjs'
import { settleOperations } from '../../scripts/release/process-utils.mjs'

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureRoot, '../..')
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'web-ide-packed-consumer-'))
const temporaryArtifacts = path.join(temporaryRoot, 'artifacts')
const temporaryConsumer = path.join(temporaryRoot, 'consumer')
const temporaryNpmCache = path.join(temporaryRoot, 'npm-cache')
const temporaryHome = path.join(temporaryRoot, 'home')
const temporaryDirectory = path.join(temporaryRoot, 'tmp')
const npmGlobalConfig = path.join(temporaryRoot, 'global.npmrc')
const npmUserConfig = path.join(temporaryRoot, 'user.npmrc')
const excludedParts = new Set(['node_modules', 'dist'])
const safePath = `${path.dirname(process.execPath)}:/usr/bin:/bin`
const npmExecutable = process.platform === 'win32' ? 'npm' : path.join(path.dirname(process.execPath), 'npm')
const npmEnvironment = {
  PATH: safePath,
  HOME: temporaryHome,
  TMPDIR: temporaryDirectory,
  TZ: 'UTC',
  LANG: 'C',
  LC_ALL: 'C',
  CI: 'true',
  NO_UPDATE_NOTIFIER: '1',
  npm_config_cache: temporaryNpmCache,
  npm_config_registry: 'https://registry.npmjs.org/',
  npm_config_globalconfig: npmGlobalConfig,
  npm_config_userconfig: npmUserConfig,
  npm_config_strict_ssl: 'true',
  npm_config_package_lock: 'true',
  npm_config_ignore_scripts: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
}

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
    npmExecutable,
    ['pack', '--pack-destination', temporaryArtifacts, '--silent'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: npmEnvironment,
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
  const candidateStat = await lstat(candidate)
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error(`Packed candidate is not a regular non-symlink file: ${candidate}`)
  }
  return candidate
}

function verifySingleReactIdentity() {
  const result = spawnSync(npmExecutable, ['ls', 'react', 'react-dom', '--all', '--json'], {
    cwd: temporaryConsumer,
    encoding: 'utf8',
    env: npmEnvironment,
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
  await settleOperations([
    mkdir(temporaryArtifacts),
    mkdir(temporaryConsumer),
    mkdir(temporaryNpmCache),
    mkdir(temporaryHome),
    mkdir(temporaryDirectory),
    writeFile(npmGlobalConfig, '', { encoding: 'utf8', flag: 'wx' }),
    writeFile(npmUserConfig, '', { encoding: 'utf8', flag: 'wx' }),
  ], 'Packed consumer setup')
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
  const copiedManifest = JSON.parse(await readFile(path.join(temporaryConsumer, 'package.json'), 'utf8'))
  const copiedLock = JSON.parse(await readFile(path.join(temporaryConsumer, 'package-lock.json'), 'utf8'))
  validateConsumerFixtureValues(
    copiedManifest,
    copiedLock,
    copiedLock.packages?.['node_modules/web-ide']?.integrity,
  )
  await withVerifiedPackedCandidate(
    { candidatePath: candidateTarball, consumerRoot: temporaryConsumer },
    () => {
      if (!run(npmExecutable, ['ci', '--ignore-scripts', '--no-fund', '--no-audit'])) {
        process.exitCode ||= 1
      } else if (!verifySingleReactIdentity()) {
        process.exitCode ||= 1
      } else if (!run(npmExecutable, ['audit', '--omit=dev', '--audit-level=low'])) {
        process.exitCode ||= 1
      } else if (!run(npmExecutable, ['run', 'build'])) {
        process.exitCode ||= 1
      }
    },
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

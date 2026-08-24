import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { git, run, settleOperations } from './process-utils.mjs'
import { readJSON, readRegularFileSnapshot, repositoryRoot } from './release-utils.mjs'
import { beginEmptyDirectoryTransaction } from './transactional-output.mjs'

const outputInput = process.env.WEB_IDE_RELEASE_OUTPUT_DIR
if (!outputInput) throw new TypeError('WEB_IDE_RELEASE_OUTPUT_DIR is required')
let fixtureRoot
let outputTransaction

try {
const isolatedSourceGitEnvironment = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: '/nonexistent-web-ide-release-preflight-home',
  TMPDIR: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
}
const sourceGit = (arguments_) => git(arguments_, {
  cwd: repositoryRoot,
  env: isolatedSourceGitEnvironment,
})
const sourceStatus = (await sourceGit(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
if (sourceStatus !== '') throw new TypeError('Release preflight requires a clean source checkout')

const configuration = await readJSON(path.join(repositoryRoot, 'release/release-input.json'))
const sourceCommit = (await sourceGit(['rev-parse', 'HEAD'])).stdout.trim()
const sourceTimestamp = (await sourceGit(['show', '-s', '--format=%ct', 'HEAD'])).stdout.trim()
fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'web-ide-release-preflight-'))
const bareRemote = path.join(fixtureRoot, 'origin.git')
const checkout = path.join(fixtureRoot, 'source')
const candidateDirectory = path.join(fixtureRoot, 'candidate')
const tagEnvironment = {
  ...isolatedSourceGitEnvironment,
  HOME: path.join(fixtureRoot, 'home'),
  TMPDIR: path.join(fixtureRoot, 'tmp'),
  GIT_COMMITTER_NAME: 'Web IDE release preflight',
  GIT_COMMITTER_EMAIL: 'release-preflight@example.invalid',
  GIT_COMMITTER_DATE: `${sourceTimestamp} +0000`,
}

  await settleOperations([
    mkdir(tagEnvironment.HOME, { recursive: true }),
    mkdir(tagEnvironment.TMPDIR, { recursive: true }),
  ], 'Preflight Git fixture setup')
  await git(['init', '--quiet', '--bare', '--initial-branch=main', bareRemote], { env: tagEnvironment })
  const canonicalBareRemote = await realpath(bareRemote)
  await git(['clone', '--quiet', repositoryRoot, checkout], { env: tagEnvironment })
  const existingTag = await git(['tag', '--list', configuration.sourceTag], {
    cwd: checkout,
    env: tagEnvironment,
  })
  if (existingTag.stdout.trim()) {
    await git(['tag', '--delete', configuration.sourceTag], { cwd: checkout, env: tagEnvironment })
  }
  await git([
    'tag', '-a', configuration.sourceTag, sourceCommit,
    '-m', `NON-RELEASE preflight ${configuration.package}`,
  ], { cwd: checkout, env: tagEnvironment })
  await git(['remote', 'set-url', 'origin', canonicalBareRemote], { cwd: checkout, env: tagEnvironment })
  await git(['push', 'origin', `refs/heads/main:refs/heads/main`, `refs/tags/${configuration.sourceTag}`], {
    cwd: checkout,
    env: tagEnvironment,
  })
  const safeEnvironment = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(fixtureRoot, 'home'),
    TMPDIR: path.join(fixtureRoot, 'tmp'),
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    CI: 'true',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_cache: path.join(fixtureRoot, 'npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_globalconfig: path.join(fixtureRoot, 'global.npmrc'),
    npm_config_userconfig: path.join(fixtureRoot, 'user.npmrc'),
    npm_config_strict_ssl: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  await settleOperations([
    writeFile(safeEnvironment.npm_config_globalconfig, '', { encoding: 'utf8', flag: 'wx' }),
    writeFile(safeEnvironment.npm_config_userconfig, '', { encoding: 'utf8', flag: 'wx' }),
  ], 'Preflight npm configuration setup')
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: checkout,
    env: safeEnvironment,
    inherit: true,
  })
  await run(process.execPath, ['scripts/release/generate-release-candidate.mjs'], {
    cwd: checkout,
    env: {
      ...safeEnvironment,
      WEB_IDE_RELEASE_OUTPUT_DIR: candidateDirectory,
      WEB_IDE_RELEASE_PREFLIGHT_REMOTE: canonicalBareRemote,
    },
    inherit: true,
  })
  await run(process.execPath, ['scripts/release/run-preflight-finalization.mjs'], {
    cwd: checkout,
    env: {
      ...safeEnvironment,
      WEB_IDE_RELEASE_OUTPUT_DIR: candidateDirectory,
      WEB_IDE_RELEASE_PREFLIGHT_REMOTE: canonicalBareRemote,
    },
    inherit: true,
  })
  outputTransaction = await beginEmptyDirectoryTransaction(outputInput, 'Preflight output directory')
  for (const fileName of (await readdir(candidateDirectory)).sort()) {
    const snapshot = await readRegularFileSnapshot(
      path.join(candidateDirectory, fileName),
      `Completed preflight file ${fileName}`,
    )
    await writeFile(path.join(outputTransaction.stagingDirectory, fileName), snapshot.bytes, {
      flag: 'wx',
      mode: 0o600,
    })
    const copy = await readRegularFileSnapshot(
      path.join(outputTransaction.stagingDirectory, fileName),
      `Copied preflight file ${fileName}`,
    )
    if (copy.size !== snapshot.size || copy.sha256 !== snapshot.sha256) {
      throw new TypeError(`Preflight publication copy changed: ${fileName}`)
    }
  }
  await outputTransaction.commit()
  process.stdout.write('Release orchestration preflight passed; outputs are explicitly nonfinal.\n')
} catch (error) {
  if (outputTransaction) await outputTransaction.rollback()
  throw error
} finally {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
}

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { git, run } from './process-utils.mjs'
import { repositoryRoot, sha256Bytes } from './release-utils.mjs'

function clean(value) {
  return value.trim()
}

function normalizeRepository(value) {
  return value.replace(/^git\+/u, '').replace(/\.git$/u, '').replace(/\/$/u, '')
}

function isolatedGitEnvironment() {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: '/nonexistent-web-ide-release-home',
    TMPDIR: '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

const ALLOWED_LOCAL_CONFIGURATION = new Set([
  'branch.main.merge',
  'branch.main.remote',
  'core.bare',
  'core.filemode',
  'core.ignorecase',
  'core.logallrefupdates',
  'core.precomposeunicode',
  'core.repositoryformatversion',
  'remote.origin.fetch',
  'remote.origin.url',
])
const MAXIMUM_GIT_CONTROL_FILE_BYTES = 64 * 1024
const MAXIMUM_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAXIMUM_GIT_STDERR_BYTES = 1024 * 1024
const SOURCE_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000
const GITHUB_API_TIMEOUT_MS = 15 * 1000
const MAXIMUM_GITHUB_API_RESPONSE_BYTES = 128 * 1024
const SHA1_PATTERN = /^[a-f0-9]{40}$/u
const githubRemoteStateCache = new Map()

function releaseSourceOptions(options) {
  const keys = Object.keys(options)
  if (keys.some((key) => key !== 'nonreleaseFixtureRemote')) {
    throw new TypeError(`Release source options contain an unknown field: ${keys.join(', ')}`)
  }
  if (Object.hasOwn(options, 'nonreleaseFixtureRemote')) {
    if (
      typeof options.nonreleaseFixtureRemote !== 'string'
      || options.nonreleaseFixtureRemote.length === 0
    ) throw new TypeError('Non-release fixture remote must be a non-empty string')
    return { nonreleaseFixture: true, expectedRepository: options.nonreleaseFixtureRemote }
  }
  return { nonreleaseFixture: false, expectedRepository: null }
}

function githubRepositoryIdentity(repository) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/u.exec(repository)
  if (!match) {
    throw new TypeError('Final release source repository must be an exact HTTPS GitHub .git URL')
  }
  return { owner: match[1], repository: match[2] }
}

async function boundedGitHubJson(url, fetchImplementation) {
  const response = await fetchImplementation(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'web-ide-release-evidence/0.2.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  })
  if (!response.ok) throw new TypeError(`Independent GitHub source lookup failed with HTTP ${response.status}`)
  if (response.url !== url) throw new TypeError('Independent GitHub source lookup changed URL')
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    throw new TypeError(`Independent GitHub source lookup returned ${contentType || 'no content type'}`)
  }
  if (!response.body) throw new TypeError('Independent GitHub source lookup returned no body')
  const chunks = []
  let byteCount = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    byteCount += bytes.length
    if (byteCount > MAXIMUM_GITHUB_API_RESPONSE_BYTES) {
      throw new TypeError('Independent GitHub source lookup exceeded the reviewed byte limit')
    }
    chunks.push(bytes)
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    throw new TypeError('Independent GitHub source lookup was not valid UTF-8', { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new TypeError('Independent GitHub source lookup was not valid JSON', { cause: error })
  }
}

function gitHubRefObject(value, expectedRef, expectedType, location) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.ref !== expectedRef
    || !value.object
    || typeof value.object !== 'object'
    || Array.isArray(value.object)
    || value.object.type !== expectedType
    || typeof value.object.sha !== 'string'
    || !SHA1_PATTERN.test(value.object.sha)
  ) throw new TypeError(`${location} did not return the expected ${expectedType} ref`)
  return value.object.sha
}

function gitHubAnnotatedTag(value, expectedObjectId) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.sha !== expectedObjectId
    || !value.object
    || typeof value.object !== 'object'
    || Array.isArray(value.object)
    || value.object.type !== 'commit'
    || typeof value.object.sha !== 'string'
    || !SHA1_PATTERN.test(value.object.sha)
  ) throw new TypeError('Independent GitHub tag lookup did not return an annotated tag object')
  return value.object.sha
}

export async function verifyIndependentGitHubSource(
  configuration,
  expected,
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('Independent GitHub source lookup requires fetch')
  }
  const { owner, repository } = githubRepositoryIdentity(configuration.sourceRepository)
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  const branchUrl = `${base}/git/ref/heads/main`
  const tagUrl = `${base}/git/ref/tags/${encodeURIComponent(configuration.sourceTag)}`
  const branch = await boundedGitHubJson(branchUrl, fetchImplementation)
  const tag = await boundedGitHubJson(tagUrl, fetchImplementation)
  const branchCommit = gitHubRefObject(branch, 'refs/heads/main', 'commit', 'Independent GitHub branch lookup')
  const tagObjectId = gitHubRefObject(
    tag,
    `refs/tags/${configuration.sourceTag}`,
    'tag',
    'Independent GitHub tag lookup',
  )
  const tagObjectUrl = `${base}/git/tags/${tagObjectId}`
  const tagObject = await boundedGitHubJson(tagObjectUrl, fetchImplementation)
  const peeledCommit = gitHubAnnotatedTag(tagObject, tagObjectId)
  if (
    branchCommit !== expected.commit
    || tagObjectId !== expected.tagObjectId
    || peeledCommit !== expected.commit
  ) throw new TypeError('Independent GitHub source identity does not match the verified local and Git refs')
  return { branchCommit, tagObjectId, peeledCommit }
}

async function cachedIndependentGitHubSource(configuration, expected) {
  const cacheKey = `${configuration.sourceRepository}\0${configuration.sourceTag}`
  let lookup = githubRemoteStateCache.get(cacheKey)
  if (!lookup) {
    lookup = verifyIndependentGitHubSource(configuration, expected)
    githubRemoteStateCache.set(cacheKey, lookup)
  }
  try {
    const result = await lookup
    if (
      result.branchCommit !== expected.commit
      || result.tagObjectId !== expected.tagObjectId
      || result.peeledCommit !== expected.commit
    ) throw new TypeError('Cached independent GitHub source identity does not match this source state')
    return result
  } catch (error) {
    githubRemoteStateCache.delete(cacheKey)
    throw error
  }
}

async function readGitControlFile(filePath, label, { absentOnly = false } = {}) {
  let info
  try {
    info = await lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (absentOnly) throw new TypeError(`${label} must be absent`)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink file`)
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(MAXIMUM_GIT_CONTROL_FILE_BYTES)) {
      throw new TypeError(`${label} exceeds the reviewed control-file limit`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.length) !== after.size
    ) throw new TypeError(`${label} changed while it was inspected`)
    return { bytes, dev: after.dev, ino: after.ino, size: after.size, mtimeNs: after.mtimeNs }
  } finally {
    await handle.close()
  }
}

async function assertPlainGitDirectory(directory, label) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must be a plain non-symlink directory`)
  }
}

async function verifyHermeticGitControlState(root, gitEnvironment) {
  const gitAtRoot = (arguments_) => git(arguments_, { cwd: root, env: gitEnvironment })
  const reportedGitDirectory = clean((await gitAtRoot(['rev-parse', '--absolute-git-dir'])).stdout)
  if (!path.isAbsolute(reportedGitDirectory)) throw new TypeError('Release Git directory is not absolute')
  await assertPlainGitDirectory(reportedGitDirectory, 'Release Git directory')
  const gitDirectory = await realpath(reportedGitDirectory)
  await assertPlainGitDirectory(path.join(gitDirectory, 'info'), 'Release Git info directory')
  await assertPlainGitDirectory(path.join(gitDirectory, 'objects'), 'Release Git objects directory')
  await assertPlainGitDirectory(path.join(gitDirectory, 'objects/info'), 'Release Git objects/info directory')

  const configurationPath = path.join(gitDirectory, 'config')
  const configurationBefore = await readGitControlFile(configurationPath, 'Release Git config')
  if (!configurationBefore) throw new TypeError('Release Git config is missing')
  await readGitControlFile(path.join(gitDirectory, 'config.worktree'), 'Release Git config.worktree', {
    absentOnly: true,
  })
  const rawConfigurationNames = (await gitAtRoot([
    'config', '--file', configurationPath, '--no-includes', '--null', '--name-only', '--list',
  ])).stdout.split('\0').filter(Boolean)
  const normalizedNames = rawConfigurationNames.map((name) => name.toLowerCase())
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new TypeError('Release Git config contains duplicate keys')
  }
  const forbiddenNames = normalizedNames.filter((name) => !ALLOWED_LOCAL_CONFIGURATION.has(name))
  if (forbiddenNames.length > 0) {
    throw new TypeError(`Release source has forbidden Git configuration: ${forbiddenNames.join(', ')}`)
  }
  const configurationAfter = await readGitControlFile(configurationPath, 'Release Git config')
  if (!configurationAfter || !configurationBefore.bytes.equals(configurationAfter.bytes)) {
    throw new TypeError('Release Git config changed during inspection')
  }

  const expectedValues = new Map([
    ['branch.main.merge', new Set(['refs/heads/main'])],
    ['branch.main.remote', new Set(['origin'])],
    ['core.bare', new Set(['false'])],
    ['core.filemode', new Set(['true', 'false'])],
    ['core.ignorecase', new Set(['true', 'false'])],
    ['core.logallrefupdates', new Set(['true'])],
    ['core.precomposeunicode', new Set(['true', 'false'])],
    ['core.repositoryformatversion', new Set(['0'])],
    ['remote.origin.fetch', new Set(['+refs/heads/*:refs/remotes/origin/*'])],
  ])
  for (const [name, allowedValues] of expectedValues) {
    if (!normalizedNames.includes(name)) continue
    const values = (await gitAtRoot([
      'config', '--file', configurationPath, '--no-includes', '--null', '--get-all', name,
    ])).stdout.split('\0').filter(Boolean)
    if (values.length !== 1 || !allowedValues.has(values[0])) {
      throw new TypeError(`Release Git config ${name} differs from the reviewed value`)
    }
  }

  for (const relativePath of [
    'info/attributes',
    'info/grafts',
    'objects/info/alternates',
  ]) {
    const snapshot = await readGitControlFile(
      path.join(gitDirectory, relativePath),
      `Release Git ${relativePath}`,
    )
    if (snapshot && snapshot.bytes.length !== 0) {
      throw new TypeError(`Release Git ${relativePath} must be absent or empty`)
    }
  }
  const exclude = await readGitControlFile(path.join(gitDirectory, 'info/exclude'), 'Release Git info/exclude')
  if (exclude) {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(exclude.bytes)
    } catch (error) {
      throw new TypeError('Release Git info/exclude is not valid UTF-8', { cause: error })
    }
    if (text.split(/\r?\n/u).some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))) {
      throw new TypeError('Release Git info/exclude contains an active ignore rule')
    }
  }
  return { gitDirectory, configurationBytes: configurationAfter.bytes }
}

export async function verifyReleaseSourceState(configuration, root = repositoryRoot, options = {}) {
  const { nonreleaseFixture, expectedRepository: fixtureRepository } = releaseSourceOptions(options)
  const gitEnvironment = isolatedGitEnvironment()
  const gitAtRoot = (arguments_) => git(arguments_, { cwd: root, env: gitEnvironment })
  const initialControlState = await verifyHermeticGitControlState(root, gitEnvironment)
  const status = clean((await gitAtRoot(['status', '--porcelain=v1', '--untracked-files=all'])).stdout)
  if (status) throw new TypeError(`Release source worktree is dirty:\n${status}`)
  const branch = clean((await gitAtRoot(['symbolic-ref', '--short', 'HEAD'])).stdout)
  if (branch !== 'main') throw new TypeError(`Release source branch must be main, received ${branch}`)
  const head = clean((await gitAtRoot(['rev-parse', 'HEAD'])).stdout)
  const tree = clean((await gitAtRoot(['rev-parse', 'HEAD^{tree}'])).stdout)
  const tracking = clean((await gitAtRoot(['rev-parse', 'refs/remotes/origin/main'])).stdout)
  if (head !== tracking) throw new TypeError('HEAD does not match refs/remotes/origin/main')
  const expectedRepository = fixtureRepository ?? configuration.sourceRepository
  const remoteUrl = clean((await gitAtRoot(['config', '--get', 'remote.origin.url'])).stdout)
  if (normalizeRepository(remoteUrl) !== normalizeRepository(expectedRepository)) {
    throw new TypeError(`origin URL does not match release input: ${remoteUrl}`)
  }
  const remoteGit = (arguments_) => git(arguments_, { cwd: root, env: gitEnvironment })
  const remoteMain = clean((await remoteGit(['ls-remote', remoteUrl, 'refs/heads/main'])).stdout).split(/\s+/u)[0]
  if (remoteMain !== head) throw new TypeError('HEAD does not match the current remote origin/main')
  const tagObjectId = clean((await gitAtRoot(['rev-parse', `refs/tags/${configuration.sourceTag}`])).stdout)
  const tagObjectType = clean((await gitAtRoot(['cat-file', '-t', `refs/tags/${configuration.sourceTag}`])).stdout)
  const tagCommit = clean((await gitAtRoot(['rev-parse', `refs/tags/${configuration.sourceTag}^{commit}`])).stdout)
  if (tagObjectType !== 'tag') throw new TypeError(`Source tag ${configuration.sourceTag} must be annotated`)
  if (tagCommit !== head) throw new TypeError(`Source tag ${configuration.sourceTag} is not at HEAD`)
  const remoteTags = clean((await remoteGit([
    'ls-remote',
    remoteUrl,
    `refs/tags/${configuration.sourceTag}`,
    `refs/tags/${configuration.sourceTag}^{}`,
  ])).stdout)
  const remoteTagRefs = new Map(remoteTags
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [objectId, ref] = line.split(/\s+/u)
      return [ref, objectId]
    }))
  if (
    remoteTagRefs.get(`refs/tags/${configuration.sourceTag}`) !== tagObjectId
    || remoteTagRefs.get(`refs/tags/${configuration.sourceTag}^{}`) !== head
  ) {
    throw new TypeError(`Remote source tag ${configuration.sourceTag} is missing or does not resolve to HEAD`)
  }
  if (!nonreleaseFixture) {
    await cachedIndependentGitHubSource(configuration, { commit: head, tagObjectId })
  }
  const commitTimestamp = Number(clean((await gitAtRoot(['show', '-s', '--format=%ct', 'HEAD'])).stdout))
  if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp <= 0) {
    throw new TypeError('Source commit timestamp is invalid')
  }
  const nodeVersion = process.versions.node
  const npmExecutable = process.platform === 'win32' ? 'npm' : path.join(path.dirname(process.execPath), 'npm')
  const npmVersion = clean((await run(npmExecutable, ['--version'], { env: isolatedGitEnvironment() })).stdout)
  if (nodeVersion !== configuration.nodeVersion || npmVersion !== configuration.npmVersion) {
    throw new TypeError(`Release toolchain mismatch: expected Node ${configuration.nodeVersion}/npm ${configuration.npmVersion}, received Node ${nodeVersion}/npm ${npmVersion}`)
  }
  const finalControlState = await verifyHermeticGitControlState(root, gitEnvironment)
  if (
    finalControlState.gitDirectory !== initialControlState.gitDirectory
    || !finalControlState.configurationBytes.equals(initialControlState.configurationBytes)
  ) throw new TypeError('Release Git control state changed during source verification')
  return {
    branch,
    commit: head,
    tree,
    tag: {
      name: configuration.sourceTag,
      objectId: tagObjectId,
      objectType: tagObjectType,
      peeledCommit: tagCommit,
    },
    remote: remoteUrl,
    commitTimestamp,
    sourceDateEpoch: String(commitTimestamp),
    nodeVersion,
    npmVersion,
  }
}

export async function sourceArchiveBytes(configuration, root = repositoryRoot, options = {}) {
  const before = await verifyReleaseSourceState(configuration, root, options)
  const result = await new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git'
    const child = spawn(executable, [
      'archive',
      '--format=tar',
      '--prefix=web-ide-0.2.0/',
      configuration.sourceTag,
    ], {
      cwd: root,
      env: isolatedGitEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = []
    const stderr = []
    let outputBytes = 0
    let stderrBytes = 0
    let failure
    let spawnError
    const terminate = (error) => {
      if (failure) return
      failure = error
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch (killError) {
        if (killError?.code !== 'ESRCH') failure = killError
      }
    }
    const timer = setTimeout(() => {
      terminate(new Error('git archive exceeded the reviewed timeout'))
    }, SOURCE_ARCHIVE_TIMEOUT_MS)
    timer.unref()
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > MAXIMUM_SOURCE_ARCHIVE_BYTES) {
        terminate(new Error('git archive exceeded the reviewed byte limit'))
      } else output.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAXIMUM_GIT_STDERR_BYTES) {
        terminate(new Error('git archive stderr exceeded the reviewed byte limit'))
      } else stderr.push(Buffer.from(chunk))
    })
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (spawnError) reject(spawnError)
      else if (code !== 0) {
        reject(new Error(`git archive failed (${code}): ${Buffer.concat(stderr).toString('utf8').trimEnd()}`))
      } else resolve(Buffer.concat(output))
    })
  })
  const after = await verifyReleaseSourceState(configuration, root, options)
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new TypeError('Release source changed while the exact-tag archive was generated')
  }
  const bytes = gzipSync(result, { level: 9, mtime: 0 })
  return { bytes, size: bytes.length, sha256: sha256Bytes(bytes) }
}

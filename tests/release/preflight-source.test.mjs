import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { git } from '../../scripts/release/process-utils.mjs'
import { createPreflightCheckout } from '../../scripts/release/preflight-source.mjs'
import { verifyReleaseSourceState } from '../../scripts/release/source-state.mjs'
const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('preflights the captured feature commit without changing real main, branch, files or configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'web-ide-preflight-source-'))
  roots.push(root)
  const source = path.join(root, 'source'), checkout = path.join(root, 'isolated')
  await mkdir(source)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const sourceGit = async args => (await git(args, { cwd: source, env })).stdout.trim()
  await sourceGit(['init', '--quiet', '--initial-branch=main'])
  await writeFile(path.join(source, 'version.txt'), 'old main')
  await sourceGit(['add', '.']); await sourceGit(['commit', '--quiet', '-m', 'main fixture'])
  const main = await sourceGit(['rev-parse', 'main'])
  await sourceGit(['checkout', '--quiet', '-b', 'codex/feature'])
  await writeFile(path.join(source, 'version.txt'), 'candidate feature')
  await sourceGit(['add', '.']); await sourceGit(['commit', '--quiet', '-m', 'candidate fixture'])
  const sourceCommit = await sourceGit(['rev-parse', 'HEAD'])
  const config = await sourceGit(['config', '--local', '--list'])
  await createPreflightCheckout({ source, checkout, sourceCommit, env })
  const cloned = async args => (await git(args, { cwd: checkout, env })).stdout.trim()
  expect(await cloned(['rev-parse', 'main'])).toBe(sourceCommit)
  expect(await cloned(['symbolic-ref', '--short', 'HEAD'])).toBe('main')
  expect(await readFile(path.join(checkout, 'version.txt'), 'utf8')).toBe('candidate feature')
  expect(await cloned(['config', '--local', '--list'])).not.toContain('branch.codex/feature')
  expect(await cloned(['config', '--local', '--get-all', 'remote.origin.fetch'])).toBe('+refs/heads/*:refs/remotes/origin/*')
  expect(await sourceGit(['rev-parse', 'main'])).toBe(main)
  expect(await sourceGit(['symbolic-ref', '--short', 'HEAD'])).toBe('codex/feature')
  expect(await sourceGit(['config', '--local', '--list'])).toBe(config)
  expect(await sourceGit(['status', '--porcelain'])).toBe('')
  // Existing destinations are rejected by clone before any checkout/reset.
  await expect(createPreflightCheckout({ source, checkout: source, sourceCommit: main, env })).rejects.toThrow()
  expect(await sourceGit(['rev-parse', 'HEAD'])).toBe(sourceCommit)
  // Exercise the actual strict validator after synthetic-origin publication;
  // checking the captured commit alone missed the single-branch fetch refspec.
  const bare = path.join(root, 'origin.git'), sourceTag = 'web-ide-v0.10.0-source'
  await git(['init', '--quiet', '--bare', '--initial-branch=main', bare], { env })
  await cloned(['remote', 'set-url', 'origin', bare])
  await cloned(['tag', '-a', sourceTag, '-m', 'NON-RELEASE source fixture'])
  await cloned(['push', 'origin', 'main', `refs/tags/${sourceTag}`])
  const verified = await verifyReleaseSourceState({
    sourceRepository: bare, sourceTag, nodeVersion: process.versions.node,
    npmVersion: process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/u)?.[1] ?? '11.6.2',
  }, checkout, { nonreleaseFixtureRemote: bare })
  expect(verified.commit).toBe(sourceCommit)
  expect(await sourceGit(['rev-parse', 'HEAD'])).toBe(sourceCommit)
  expect(await sourceGit(['config', '--local', '--list'])).toBe(config)
})

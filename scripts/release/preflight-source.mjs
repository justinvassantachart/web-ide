import assert from 'node:assert/strict'
import { git } from './process-utils.mjs'

/** Create a new disposable checkout. Never reset a caller/shared checkout.
 * The synthetic origin must publish the captured candidate commit as main,
 * even when the real source currently has an older main and a feature HEAD. */
export async function createPreflightCheckout({ source, checkout, sourceCommit, env }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u, 'Preflight needs a captured full source commit')
  // Clone only main so unrelated feature-branch tracking configuration cannot
  // enter the final source validator's deliberately restricted local config.
  await git(['clone', '--quiet', '--no-local', '--no-checkout', '--single-branch', '--branch', 'main', source, checkout], { env })
  // A single-branch clone narrows its fetch refspec. Restore the reviewed
  // canonical refspec only in this newly created disposable checkout so the
  // unchanged release source verifier can validate the synthetic origin.
  await git(['config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: checkout, env })
  await git(['fetch', '--quiet', 'origin', sourceCommit], { cwd: checkout, env })
  await git(['checkout', '--quiet', '-B', 'main', sourceCommit], { cwd: checkout, env })
  const head = (await git(['rev-parse', 'HEAD'], { cwd: checkout, env })).stdout.trim()
  assert.equal(head, sourceCommit, 'Disposable preflight checkout differs from the captured source')
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: checkout, env })).stdout
  assert.equal(status, '', 'Disposable preflight checkout must be clean')
}

import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
const spec = manifest.dependencies['debugger-sh-upstream']
const expected = /^https:\/\/github\.com\/justinvassantachart\/engine\/releases\/download\/upstream-([0-9a-f]{40})\/debugger-sh-0\.3\.16-upstream\.([0-9a-f]{12})\.tgz$/
const match = expected.exec(spec)
if (!match || !match[1].startsWith(match[2])) throw new Error('Upstream Engine must use an immutable source-qualified release tarball')
const entry = lock.packages['node_modules/debugger-sh-upstream']
if (entry.version !== `0.3.16-upstream.${match[2]}` || entry.resolved !== spec || !entry.integrity?.startsWith('sha512-')) throw new Error('Upstream Engine lock integrity is missing or mismatched')
const source = JSON.parse(await readFile(new URL('../../node_modules/debugger-sh-upstream/dist/source.json', import.meta.url), 'utf8'))
if (source.source !== match[1] || source.repository !== 'justinvassantachart/engine') throw new Error('Installed Engine source provenance does not match the release URL')
if (source.upstreamBase !== '28b6738e5746e2c2950c5b60e0b5a7cc746429b0') throw new Error('Engine must start from upstream main plus PR #23, without the PR #30 bundle')
const engineToolchains = JSON.parse(await readFile(new URL('../../node_modules/debugger-sh-upstream/dist/toolchain-provenance.json', import.meta.url), 'utf8'))
const owned = JSON.parse(await readFile(new URL('../../src/runtimes/upstream-toolchains.json', import.meta.url), 'utf8'))
assert.deepEqual(engineToolchains, owned.toolchains, 'Owned Web IDE toolchain manifest must match the verified Engine packaging receipt')
console.log(`Pinned upstream Engine ${entry.version}, ${entry.integrity}`)

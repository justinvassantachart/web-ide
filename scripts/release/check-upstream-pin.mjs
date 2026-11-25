import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const read = async path => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'))
const manifest = await read('package.json')
const lock = await read('package-lock.json')
const receipt = await read('src/runtimes/upstream-engine.json')
assert.equal(receipt.repository, 'debugger-sh/engine')
assert.equal(receipt.packageName, 'debugger-sh')
assert.match(receipt.gitHead, /^[a-f0-9]{40}$/)
assert.equal(manifest.dependencies['debugger-sh-upstream'], `npm:debugger-sh@${receipt.version}`)
assert.equal(receipt.tarball, `https://registry.npmjs.org/debugger-sh/-/debugger-sh-${receipt.version}.tgz`)
const entry = lock.packages['node_modules/debugger-sh-upstream']
assert.equal(entry.version, receipt.version)
assert.equal(entry.resolved, receipt.tarball)
assert.equal(entry.integrity, receipt.integrity)
assert.match(entry.integrity, /^sha512-/)
for (const file of receipt.files) {
  const bytes = await readFile(new URL(`../../node_modules/debugger-sh-upstream/${file.path}`, import.meta.url))
  assert.equal(bytes.length, file.bytes, `Engine size mismatch: ${file.path}`)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Engine hash mismatch: ${file.path}`)
}
const installed = await read('node_modules/debugger-sh-upstream/package.json')
assert.equal(installed.name, receipt.packageName)
assert.equal(installed.version, receipt.version)
const code = await readFile(new URL('../../node_modules/debugger-sh-upstream/dist/debugger-sh.js', import.meta.url), 'utf8')
assert.ok(code.includes(receipt.wasmUrl), 'Official Engine WASM URL must match its release receipt')
const toolchains = await read('src/runtimes/upstream-toolchains.json')
for (const toolchain of Object.values(toolchains.toolchains)) {
  for (const url of Object.values(toolchain.artifacts)) assert.ok(code.includes(url), `Engine toolchain URL missing: ${url}`)
}
console.log(`Verified unmodified upstream Engine ${entry.version} (${receipt.gitHead}), ${entry.integrity}`)

if (process.argv.includes('--downloads')) {
  const downloads = [[receipt.wasmUrl, receipt.files.find(file => file.path === 'dist/engine_bg.wasm').sha256]]
  for (const toolchain of Object.values(toolchains.toolchains)) {
    for (const [name, url] of Object.entries(toolchain.artifacts)) downloads.push([url, toolchain.sha256[name]])
  }
  for (const [url, expected] of downloads) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    assert.equal(response.status, 200, `Runtime download failed: ${url}`)
    const hash = createHash('sha256')
    for await (const bytes of response.body) hash.update(bytes)
    assert.equal(hash.digest('hex'), expected, `Runtime download hash mismatch: ${url}`)
    console.log(`Verified runtime download ${url}`)
  }
}

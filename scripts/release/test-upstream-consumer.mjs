import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// The stable release fixture deliberately stays pinned to its reviewed receipt.
// This prerelease fixture tests a newly packed candidate, then installs its own
// generated exact lock in an empty consumer. Neither package is linked to source.
const root = fileURLToPath(new URL('../../', import.meta.url))
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'web-ide-upstream-consumer-')))
const npm = path.join(path.dirname(process.execPath), 'npm')
const viewer = process.env.WEB_IDE_UPSTREAM_VIEWER === '1'
let server
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server?.kill(signal))
function run(args, cwd, capture = false) {
  const result = spawnSync(npm, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.stderr ?? result.status}`)
  return result.stdout
}
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const sourceLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', temporary], root, true))
  const archive = path.join(temporary, packed.filename)
  const actual = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`
  if (actual !== packed.integrity) throw new Error('Packed archive differs from npm pack receipt')
  const consumer = path.join(temporary, 'consumer')
  await mkdir(consumer)
  const fixture = path.join(root, 'tests/consumer')
  for (const file of ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.nodenext.json']) {
    await cp(path.join(fixture, file), path.join(consumer, file), { recursive: true })
  }
  await writeFile(path.join(consumer, 'src/upstream-api.ts'), `
import { createCppRuntimeProvider, createPythonRuntimeProvider, type EngineBackend } from 'web-ide/runtimes'
const backend: EngineBackend = 'upstream'
export const upstreamProviders = [createCppRuntimeProvider({ backend }), createPythonRuntimeProvider({ backend })]
`)
  const entrypoint = path.join(consumer, 'src/main.tsx')
  await writeFile(entrypoint, `import './upstream-api'\n${await readFile(entrypoint, 'utf8')}`)
  const consumerManifest = JSON.parse(await readFile(path.join(fixture, 'package.json'), 'utf8'))
  for (const group of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(consumerManifest[group])) {
      consumerManifest[group][name] = name === 'web-ide' ? `file:${archive}` : sourceLock.packages[`node_modules/${name}`].version
    }
  }
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify(consumerManifest, null, 2))
  run(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const installed = JSON.parse(await readFile(path.join(consumer, 'node_modules/web-ide/package.json'), 'utf8'))
  if (installed.version !== manifest.version) throw new Error('Consumer installed a different Web IDE version')
  const consumerLock = JSON.parse(await readFile(path.join(consumer, 'package-lock.json'), 'utf8'))
  if (consumerLock.packages['node_modules/web-ide'].integrity !== packed.integrity) throw new Error('Consumer Web IDE integrity mismatch')
  for (const name of ['debugger-sh', 'debugger-sh-upstream']) {
    const expected = sourceLock.packages[`node_modules/${name}`]
    const actual = consumerLock.packages[`node_modules/${name}`]
    if (actual.integrity !== expected.integrity || actual.resolved !== expected.resolved) throw new Error(`${name} consumer lock mismatch`)
  }
  run(['run', 'build'], consumer)
  const output = path.join(root, '.artifacts')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'upstream-consumer.json'), JSON.stringify({
    version: manifest.version, integrity: packed.integrity,
    engines: Object.fromEntries(['debugger-sh', 'debugger-sh-upstream'].map(name => [name, sourceLock.packages[`node_modules/${name}`]])),
    installedWithCleanCi: true, declarationsAndProductionBundle: 'passed',
  }, null, 2))
  console.log(`Clean consumer passed for ${manifest.version} (${packed.integrity})`)
  if (viewer) {
    for (const file of ['index.html', 'main.tsx']) await cp(path.join(root, 'tests/viewer', file), path.join(consumer, file))
    run(['exec', 'vite', '--', 'build'], consumer)
    server = spawn(process.execPath, [path.join(consumer, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4207', '--strictPort'], { cwd: consumer, stdio: 'inherit' })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.once('exit', code => code ? reject(new Error(`Packed viewer exited ${code}`)) : resolve())
    })
  }
} finally { await rm(temporary, { recursive: true, force: true }) }

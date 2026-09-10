import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withVerifiedPackedCandidate } from '../consumer/packed-candidate.mjs'

const repository = path.resolve(import.meta.dirname, '../..')
const root = await mkdtemp(path.join(tmpdir(), 'web-ide-packed-viewer-'))
const consumer = path.join(root, 'consumer')
const npm = path.join(path.dirname(process.execPath), 'npm')
let server
const clean = async () => {
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)) }
    await rm(root, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void clean().then(() => process.exit(0)) })
try {
    await mkdir(consumer)
    await Promise.all(['home', 'tmp', 'cache'].map(name => mkdir(path.join(root, name))))
    await Promise.all(['user.npmrc', 'global.npmrc'].map(name => writeFile(path.join(root, name), '')))
    const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(root, 'home'),
        TMPDIR: path.join(root, 'tmp'), CI: 'true', npm_config_ignore_scripts: 'true',
        npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'user.npmrc'),
        npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_registry: 'https://registry.npmjs.org/' }
    const run = (args, cwd = consumer) => {
        const result = spawnSync(npm, args, { cwd, env: environment, stdio: 'inherit' })
        if (result.error || result.status !== 0) throw new Error(`Packed viewer command failed: ${args.join(' ')}`, { cause: result.error })
    }
    // Build/pack with the owning repository toolchain. The copied committed
    // consumer lock must already pin these bytes; no dynamic integrity waiver.
    run(['run', 'build:library'], repository)
    run(['pack', '--ignore-scripts', '--silent', '--pack-destination', root], repository)
    for (const name of ['package.json', 'package-lock.json', 'vite.config.ts']) {
        await cp(path.join(repository, 'tests/consumer', name), path.join(consumer, name))
    }
    for (const name of ['index.html', 'main.tsx']) await cp(path.join(import.meta.dirname, name), path.join(consumer, name))
    await withVerifiedPackedCandidate({ candidatePath: path.join(root, 'web-ide-0.4.0.tgz'), consumerRoot: consumer }, async () => {
        run(['ci', '--ignore-scripts', '--no-fund', '--no-audit'])
        run(['exec', 'vite', '--', 'build'])
        server = spawn(process.execPath, [path.join(consumer, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4196', '--strictPort'],
            { cwd: consumer, env: environment, stdio: 'inherit' })
        await new Promise((resolve, reject) => { server.once('error', reject); server.once('exit', code => code ? reject(new Error(`Preview exited ${code}`)) : resolve()) })
    })
} finally { await clean() }

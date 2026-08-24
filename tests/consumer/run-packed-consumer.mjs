import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureRoot, '../..')
const tarball = path.join(repositoryRoot, 'web-ide-0.1.0.tgz')
const temporaryConsumer = await mkdtemp(
  path.join(tmpdir(), 'web-ide-packed-consumer-'),
)
const excludedParts = new Set(['node_modules', 'dist'])

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: temporaryConsumer,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
  return result.status === 0
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
  await cp(fixtureRoot, temporaryConsumer, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixtureRoot, source)
      return !relative
        .split(path.sep)
        .some((part) => excludedParts.has(part) || part.endsWith('.tsbuildinfo'))
    },
  })

  const packagePath = path.join(temporaryConsumer, 'package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  manifest.dependencies['web-ide'] = `file:${tarball}`
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)

  if (!run('npm', ['install', '--no-fund', '--no-audit'])) {
    process.exitCode ||= 1
  } else if (!verifySingleReactIdentity()) {
    process.exitCode ||= 1
  } else if (!run('npm', ['audit', '--omit=dev', '--audit-level=low'])) {
    process.exitCode ||= 1
  } else if (!run('npm', ['run', 'build'])) {
    process.exitCode ||= 1
  }
} finally {
  await rm(temporaryConsumer, { recursive: true, force: true })
}

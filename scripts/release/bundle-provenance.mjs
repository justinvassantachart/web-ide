import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  assertExternalOutputPath,
  repositoryRoot,
  sortStrings,
  toPosixPath,
} from './release-utils.mjs'

const virtualPrefixes = [
  'commonjsHelpers.js',
  'vite/',
  'vite:',
]

function stripModuleDecorators(moduleId) {
  let normalized = moduleId.startsWith('\0') ? moduleId.slice(1) : moduleId
  const query = normalized.indexOf('?')
  if (query !== -1) normalized = normalized.slice(0, query)
  return normalized
}

export function normalizeModuleId(moduleId, root = repositoryRoot) {
  const stripped = stripModuleDecorators(moduleId)
  const normalizedRoot = toPosixPath(root)
  const normalized = toPosixPath(stripped)
  if (normalized === normalizedRoot) return '<repository>'
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return `<repository>/${normalized.slice(normalizedRoot.length + 1)}`
  }
  if (virtualPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return `<virtual>/${normalized}`
  }
  if (!path.isAbsolute(stripped)) return `<virtual>/${normalized}`
  throw new TypeError(`Bundle provenance contains a module outside the repository: ${moduleId}`)
}

export function packageOwnerForModule(moduleId, lockPackages, root = repositoryRoot) {
  const stripped = stripModuleDecorators(moduleId)
  if (!path.isAbsolute(stripped)) return null
  const relative = toPosixPath(path.relative(root, stripped))
  if (relative.startsWith('../') || path.isAbsolute(relative)) return null

  const candidates = Object.keys(lockPackages)
    .filter((key) => key.startsWith('node_modules/'))
    .sort((left, right) => right.length - left.length)
  for (const lockPath of candidates) {
    if (relative === lockPath || relative.startsWith(`${lockPath}/`)) {
      const metadata = lockPackages[lockPath]
      if (typeof metadata?.version !== 'string') {
        throw new TypeError(`Package lock entry ${lockPath} has no version`)
      }
      const packageName = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
      return {
        lockPath,
        name: packageName,
        version: metadata.version,
        dev: metadata.dev === true,
      }
    }
  }
  return null
}

function validateOwner(owner, location) {
  if (owner === null) return
  assertExactKeys(owner, ['lockPath', 'name', 'version', 'dev'], [], location)
  for (const field of ['lockPath', 'name', 'version']) assertNonEmptyString(owner[field], `${location}.${field}`)
  if (!owner.lockPath.startsWith('node_modules/') || owner.lockPath.includes('..') || owner.lockPath.includes('\\')) {
    throw new TypeError(`${location}.lockPath is unsafe`)
  }
  if (typeof owner.dev !== 'boolean') throw new TypeError(`${location}.dev must be boolean`)
}

export function validateBundleProvenance(provenance) {
  assertExactKeys(
    provenance,
    ['schemaVersion', 'package', 'format', 'chunks', 'packages'],
    [],
    'bundle provenance',
  )
  if (
    provenance.schemaVersion !== 1
    || provenance.package !== 'web-ide'
    || provenance.format !== 'vite-rollup-output-modules'
  ) throw new TypeError('Unsupported bundle provenance identity')
  if (!Array.isArray(provenance.chunks) || !Array.isArray(provenance.packages)) {
    throw new TypeError('Bundle provenance chunks and packages must be arrays')
  }
  const usage = new Map()
  for (const [chunkIndex, chunk] of provenance.chunks.entries()) {
    const location = `bundle provenance chunks[${chunkIndex}]`
    assertExactKeys(chunk, ['fileName', 'name', 'isEntry', 'isDynamicEntry', 'modules'], [], location)
    assertNonEmptyString(chunk.fileName, `${location}.fileName`)
    assertNonEmptyString(chunk.name, `${location}.name`)
    if (path.isAbsolute(chunk.fileName) || chunk.fileName.includes('..') || chunk.fileName.includes('\\')) {
      throw new TypeError(`${location}.fileName is unsafe`)
    }
    if (typeof chunk.isEntry !== 'boolean' || typeof chunk.isDynamicEntry !== 'boolean' || !Array.isArray(chunk.modules)) {
      throw new TypeError(`${location} has invalid flags or modules`)
    }
    for (const [moduleIndex, module] of chunk.modules.entries()) {
      const moduleLocation = `${location}.modules[${moduleIndex}]`
      assertExactKeys(module, ['id', 'renderedLength', 'package'], [], moduleLocation)
      assertNonEmptyString(module.id, `${moduleLocation}.id`)
      if (!module.id.startsWith('<repository>/') && !module.id.startsWith('<virtual>/')) {
        throw new TypeError(`${moduleLocation}.id is not normalized`)
      }
      if (!Number.isSafeInteger(module.renderedLength) || module.renderedLength < 0) {
        throw new TypeError(`${moduleLocation}.renderedLength must be a non-negative safe integer`)
      }
      validateOwner(module.package, `${moduleLocation}.package`)
      const repositoryPath = module.id.slice('<repository>/'.length)
      if (module.id.startsWith('<repository>/node_modules/') && module.package === null) {
        throw new TypeError(`${moduleLocation} is a bundled dependency without package-lock ownership`)
      }
      if (
        module.package
        && (!module.id.startsWith('<repository>/')
          || (repositoryPath !== module.package.lockPath
            && !repositoryPath.startsWith(`${module.package.lockPath}/`)))
      ) {
        throw new TypeError(`${moduleLocation}.package does not own the normalized module path`)
      }
      if (module.package) {
        const current = usage.get(module.package.lockPath) ?? {
          ...module.package,
          chunks: new Set(),
          moduleCount: 0,
        }
        if (
          current.name !== module.package.name
          || current.version !== module.package.version
          || current.dev !== module.package.dev
        ) throw new TypeError(`Conflicting ownership for ${module.package.lockPath}`)
        current.chunks.add(chunk.fileName)
        current.moduleCount += 1
        usage.set(module.package.lockPath, current)
      }
    }
  }
  const expectedPackages = [...usage.values()]
    .sort((left, right) => left.lockPath < right.lockPath ? -1 : left.lockPath > right.lockPath ? 1 : 0)
    .map(({ chunks, ...owner }) => ({ ...owner, chunks: sortStrings(chunks) }))
  for (const [index, bundled] of provenance.packages.entries()) {
    assertExactKeys(
      bundled,
      ['lockPath', 'name', 'version', 'dev', 'chunks', 'moduleCount'],
      [],
      `bundle provenance packages[${index}]`,
    )
  }
  if (canonicalJSONString(expectedPackages) !== canonicalJSONString(provenance.packages)) {
    throw new TypeError('Bundle provenance package summary does not match chunk module ownership')
  }
  return provenance
}

export async function createReleaseProvenancePlugin(outputPath, root = repositoryRoot) {
  const verifiedOutput = await assertExternalOutputPath(outputPath, 'Bundle provenance output path')
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const lockPackages = lock.packages ?? {}

  return {
    name: 'web-ide-release-provenance',
    async generateBundle(_outputOptions, bundle) {
      const chunks = []
      const packageUsage = new Map()
      for (const fileName of sortStrings(Object.keys(bundle))) {
        const output = bundle[fileName]
        if (output.type !== 'chunk') continue
        const modules = []
        for (const moduleId of sortStrings(Object.keys(output.modules))) {
          const owner = packageOwnerForModule(moduleId, lockPackages, root)
          const rendered = output.modules[moduleId]
          const record = {
            id: normalizeModuleId(moduleId, root),
            renderedLength: rendered.renderedLength,
            package: owner,
          }
          if (record.id.startsWith('<repository>/node_modules/') && owner === null) {
            throw new TypeError(`Bundled module has no package-lock ownership: ${record.id}`)
          }
          modules.push(record)
          if (owner) {
            const usage = packageUsage.get(owner.lockPath) ?? {
              ...owner,
              chunks: new Set(),
              moduleCount: 0,
            }
            usage.chunks.add(fileName)
            usage.moduleCount += 1
            packageUsage.set(owner.lockPath, usage)
          }
        }
        chunks.push({
          fileName,
          name: output.name,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          modules,
        })
      }

      const packages = [...packageUsage.values()]
        .sort((left, right) => (left.lockPath < right.lockPath ? -1 : left.lockPath > right.lockPath ? 1 : 0))
        .map(({ chunks: usedChunks, ...owner }) => ({
          ...owner,
          chunks: sortStrings(usedChunks),
        }))
      const report = {
        schemaVersion: 1,
        package: 'web-ide',
        format: 'vite-rollup-output-modules',
        chunks,
        packages,
      }
      await mkdir(path.dirname(verifiedOutput), { recursive: true })
      await writeFile(verifiedOutput, canonicalJSONString(report), { flag: 'wx' })
    },
  }
}

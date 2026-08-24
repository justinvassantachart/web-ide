import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { validateBundleProvenance } from './bundle-provenance.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import { sourceProvenanceForAsset } from './runtime-source-provenance.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  readRegularFileSnapshot,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
  toPosixPath,
} from './release-utils.mjs'

const licenseFilePattern = /^(?:licen[cs]e|copying|notice|third[-_. ]?party)/iu

function assertRepositoryRelativePath(value, location) {
  assertNonEmptyString(value, location)
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${location} must be a safe repository-relative path`)
  }
}

function validatePolicy(policy) {
  assertExactKeys(
    policy,
    ['schemaVersion', 'package', 'packageOverrides', 'sourceAttributions'],
    [],
    'license policy',
  )
  if (policy.schemaVersion !== 1 || policy.package !== 'web-ide') {
    throw new TypeError('Unsupported license policy identity')
  }
  if (!policy.packageOverrides || typeof policy.packageOverrides !== 'object' || Array.isArray(policy.packageOverrides)) {
    throw new TypeError('license policy packageOverrides must be an object')
  }
  for (const [name, override] of Object.entries(policy.packageOverrides)) {
    assertNonEmptyString(name, 'license policy package override name')
    assertExactKeys(override, ['licenseTextPaths'], [], `license policy packageOverrides.${name}`)
    if (!Array.isArray(override.licenseTextPaths) || override.licenseTextPaths.length === 0) {
      throw new TypeError(`license policy packageOverrides.${name}.licenseTextPaths must be non-empty`)
    }
    override.licenseTextPaths.forEach((value, index) => {
      assertRepositoryRelativePath(value, `license policy packageOverrides.${name}.licenseTextPaths[${index}]`)
    })
  }
  if (!Array.isArray(policy.sourceAttributions)) throw new TypeError('license policy sourceAttributions must be an array')
  for (const [index, attribution] of policy.sourceAttributions.entries()) {
    const location = `license policy sourceAttributions[${index}]`
    assertExactKeys(
      attribution,
      ['name', 'version', 'license', 'repository', 'sourcePaths', 'licenseTextPaths'],
      [],
      location,
    )
    for (const field of ['name', 'version', 'license', 'repository']) {
      assertNonEmptyString(attribution[field], `${location}.${field}`)
    }
    for (const field of ['sourcePaths', 'licenseTextPaths']) {
      if (!Array.isArray(attribution[field]) || attribution[field].length === 0) {
        throw new TypeError(`${location}.${field} must be a non-empty array`)
      }
      attribution[field].forEach((value, itemIndex) => {
        assertRepositoryRelativePath(value, `${location}.${field}[${itemIndex}]`)
      })
    }
  }
  return policy
}

function normalizedText(bytes, source) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`License evidence is not UTF-8: ${source}`, { cause: error })
  }
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').replace(/\s+$/u, '')
  if (normalized.length === 0) throw new TypeError(`License evidence is empty: ${source}`)
  return `${normalized}\n`
}

async function readEvidenceBytes(absolutePath, relativePath) {
  const snapshot = await readRegularFileSnapshot(
    absolutePath,
    `License/source evidence ${relativePath}`,
    8 * 1024 * 1024,
  )
  return snapshot.bytes
}

async function packageLicenseFiles(packageRoot) {
  const names = sortStrings(await readdir(packageRoot))
  return names.filter((name) => licenseFilePattern.test(name))
}

function packageNameFromLockPath(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

async function packageLicenseRecord({ lockPath, inclusion, provenance, packageLock, overrides }) {
  const lockEntry = packageLock.packages?.[lockPath]
  if (!lockEntry || typeof lockEntry.version !== 'string') {
    throw new TypeError(`License package is absent from lock: ${lockPath}`)
  }
  const packageRoot = path.join(repositoryRoot, lockPath)
  const manifest = await readJSON(path.join(packageRoot, 'package.json'))
  const name = packageNameFromLockPath(lockPath)
  if (manifest.name !== name || manifest.version !== lockEntry.version) {
    throw new TypeError(`Installed license package does not match lock: ${lockPath}`)
  }
  const expression = assertNonEmptyString(manifest.license ?? lockEntry.license, `${name}.license`)
  if (lockEntry.license && lockEntry.license !== expression) {
    throw new TypeError(`License metadata disagrees for ${name}@${manifest.version}`)
  }

  const localFiles = (await packageLicenseFiles(packageRoot)).map((file) => path.join(lockPath, file))
  const configuredFiles = overrides[name]?.licenseTextPaths ?? []
  const evidencePaths = sortStrings(new Set([...localFiles, ...configuredFiles]))
  if (evidencePaths.length === 0) {
    throw new TypeError(`No license text was found for ${name}@${manifest.version}`)
  }
  const files = []
  for (const relativePath of evidencePaths) {
    const absolutePath = path.join(repositoryRoot, relativePath)
    const bytes = await readEvidenceBytes(absolutePath, relativePath)
    const text = normalizedText(bytes, relativePath)
    files.push({
      path: toPosixPath(relativePath),
      sha256: sha256Bytes(bytes),
      normalizedSha256: sha256Bytes(Buffer.from(text)),
      text,
    })
  }
  return {
    kind: 'npm-package',
    name,
    version: manifest.version,
    inclusion,
    lockPath,
    license: expression,
    repository: manifest.repository ?? null,
    homepage: manifest.homepage ?? null,
    provenance,
    files,
  }
}

async function sourceAttributionRecord(attribution) {
  const files = []
  for (const relativePath of attribution.licenseTextPaths) {
    const bytes = await readEvidenceBytes(path.join(repositoryRoot, relativePath), relativePath)
    const text = normalizedText(bytes, relativePath)
    files.push({
      path: relativePath,
      sha256: sha256Bytes(bytes),
      normalizedSha256: sha256Bytes(Buffer.from(text)),
      text,
    })
  }
  if (files.length === 0) throw new TypeError(`No license text for attribution ${attribution.name}`)
  const sources = []
  for (const relativePath of attribution.sourcePaths) {
    const bytes = await readEvidenceBytes(path.join(repositoryRoot, relativePath), relativePath)
    sources.push({ path: relativePath, size: bytes.length, sha256: sha256Bytes(bytes) })
  }
  return {
    kind: 'source-attribution',
    name: attribution.name,
    version: attribution.version,
    inclusion: 'adapted-source',
    lockPath: null,
    license: attribution.license,
    repository: attribution.repository,
    homepage: null,
    provenance: { sources },
    files,
  }
}

async function runtimeAssetRecord(asset, runtimeSourceProvenance) {
  const files = []
  for (const relativePath of asset.licenseTextPaths) {
    const bytes = await readEvidenceBytes(path.join(repositoryRoot, relativePath), relativePath)
    const text = normalizedText(bytes, relativePath)
    files.push({
      path: relativePath,
      sha256: sha256Bytes(bytes),
      normalizedSha256: sha256Bytes(Buffer.from(text)),
      text,
    })
  }
  if (files.length === 0) throw new TypeError(`No license text for runtime asset ${asset.id}`)
  const sourceProvenance = sourceProvenanceForAsset(runtimeSourceProvenance, asset.id)
  return {
    kind: 'runtime-asset',
    name: asset.id,
    version: asset.version,
    inclusion: 'runtime-asset',
    lockPath: null,
    license: asset.license,
    repository: asset.sourceRepository,
    homepage: asset.requestedUrl,
    provenance: {
      sha256: asset.sha256,
      size: asset.size,
      sourceRecord: sourceProvenance.id,
      sourceRelationship: sourceProvenance.relationship,
      limitations: sourceProvenance.limitations,
    },
    files,
  }
}

export async function generateLicenseEvidence({
  provenancePath,
  runtimeLock,
  runtimeSourceProvenance,
  policy,
  packageLock,
}) {
  validatePolicy(policy)
  const provenance = await readJSON(provenancePath)
  validateBundleProvenance(provenance)
  const records = []
  const usedOverrides = new Set()
  for (const bundled of provenance.packages) {
    const bundledName = packageNameFromLockPath(bundled.lockPath)
    if (policy.packageOverrides[bundledName]) usedOverrides.add(bundledName)
    records.push(await packageLicenseRecord({
      lockPath: bundled.lockPath,
      inclusion: bundled.dev ? 'bundled-dev-classified' : 'bundled-production-classified',
      provenance: { chunks: bundled.chunks, moduleCount: bundled.moduleCount },
      packageLock,
      overrides: policy.packageOverrides,
    }))
  }

  for (const [name, inclusion] of [
    ['debugger-sh', 'runtime-external'],
    ['react', 'peer-external'],
    ['react-dom', 'peer-external'],
    ['monaco-editor', 'runtime-external'],
  ]) {
    if (policy.packageOverrides[name]) usedOverrides.add(name)
    records.push(await packageLicenseRecord({
      lockPath: `node_modules/${name}`,
      inclusion,
      provenance: null,
      packageLock,
      overrides: policy.packageOverrides,
    }))
  }
  for (const attribution of policy.sourceAttributions) {
    records.push(await sourceAttributionRecord(attribution))
  }
  for (const asset of runtimeLock.assets) {
    records.push(await runtimeAssetRecord(asset, runtimeSourceProvenance))
  }

  const unusedOverrides = Object.keys(policy.packageOverrides).filter((name) => !usedOverrides.has(name))
  if (unusedOverrides.length > 0) {
    throw new TypeError(`License policy has unused package overrides: ${sortStrings(unusedOverrides).join(', ')}`)
  }

  records.sort((left, right) => {
    const leftKey = `${left.kind}\0${left.name}\0${left.version}`
    const rightKey = `${right.kind}\0${right.name}\0${right.version}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })

  const textByHash = new Map()
  for (const record of records) {
    for (const file of record.files) textByHash.set(file.normalizedSha256, file.text)
  }
  const machineRecords = records.map((record) => ({
    ...record,
    files: record.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      normalizedSha256: file.normalizedSha256,
    })),
  }))
  const report = { schemaVersion: 1, package: 'web-ide', records: machineRecords }

  const sections = [
    'WEB IDE 0.3.0 THIRD-PARTY LICENSE EVIDENCE',
    '',
    'Generated deterministically from the exact Rollup bundle provenance, package lock,',
    'runtime-asset lock, and reviewed source-attribution policy.',
    '',
    'COMPONENT INDEX',
    '',
    ...machineRecords.flatMap((record) => [
      `${record.kind}: ${record.name}@${record.version}`,
      `License: ${record.license}`,
      `Inclusion: ${record.inclusion}`,
      ...record.files.map((file) => `License text: ${file.path} (normalized SHA-256 ${file.normalizedSha256})`),
      '',
    ]),
    'DEDUPLICATED LICENSE TEXTS',
    '',
  ]
  for (const digest of sortStrings(textByHash.keys())) {
    sections.push(`===== normalized SHA-256 ${digest} =====`, '', textByHash.get(digest).trimEnd(), '')
  }
  return {
    report,
    reportBytes: canonicalJSONString(report),
    textBytes: `${sections.join('\n').trimEnd()}\n`,
  }
}

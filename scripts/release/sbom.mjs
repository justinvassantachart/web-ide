import { createHash } from 'node:crypto'
import path from 'node:path'

import { validateBundleProvenance } from './bundle-provenance.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  readJSON,
  repositoryRoot,
  sortStrings,
} from './release-utils.mjs'

function npmPurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function deterministicUuidV5(name) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function lockHash(integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new TypeError('Release component lock entry must have SHA-512 integrity')
  }
  const bytes = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  if (bytes.length !== 64) throw new TypeError('Release component has malformed SHA-512 integrity')
  return { alg: 'SHA-512', content: bytes.toString('hex') }
}

function packageComponent({ name, version, lockPath, inclusion, lockEntry, extraProperties = [] }) {
  const license = assertNonEmptyString(lockEntry.license, `${lockPath}.license`)
  const purl = npmPurl(name, version)
  const bomRef = `${purl}?web_ide_lock_path=${encodeURIComponent(lockPath)}`
  const properties = [
    { name: 'web-ide:evidence:inclusion', value: inclusion },
    { name: 'web-ide:evidence:lock-path', value: lockPath },
    ...extraProperties,
  ].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const component = {
    type: 'library',
    'bom-ref': bomRef,
    name,
    version,
    purl,
    scope: inclusion === 'peer-external' ? 'optional' : 'required',
    hashes: [lockHash(lockEntry.integrity)],
    licenses: [{ expression: license }],
    properties,
  }
  if (typeof lockEntry.resolved === 'string') {
    component.externalReferences = [{ type: 'distribution', url: lockEntry.resolved }]
  }
  return component
}

function runtimeAssetComponent(asset) {
  const bomRef = `urn:web-ide:runtime-asset:${asset.id}:${asset.sha256}`
  return {
    type: 'file',
    'bom-ref': bomRef,
    name: asset.id,
    version: asset.version,
    scope: 'required',
    hashes: [{ alg: 'SHA-256', content: asset.sha256 }],
    licenses: [{ expression: asset.license }],
    externalReferences: [
      { type: 'distribution', url: asset.requestedUrl },
      { type: 'vcs', url: asset.sourceRepository },
    ],
    properties: [
      { name: 'web-ide:evidence:content-type', value: asset.contentType },
      { name: 'web-ide:evidence:final-url', value: asset.finalUrl },
      { name: 'web-ide:evidence:inclusion', value: 'runtime-asset' },
      { name: 'web-ide:evidence:size', value: String(asset.size) },
    ],
  }
}

export async function generateCycloneDx({
  provenancePath,
  runtimeLock,
  packageManifest,
  packageLock,
  candidate,
}) {
  assertExactKeys(candidate, ['filename', 'size', 'sha256', 'sha512Integrity'], [], 'SBOM candidate')
  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0 || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
    throw new TypeError('SBOM candidate has invalid size or SHA-256')
  }
  const provenance = await readJSON(provenancePath)
  validateBundleProvenance(provenance)
  const lockPackages = packageLock.packages ?? {}
  const byBomRef = new Map()

  for (const bundled of provenance.packages) {
    const lockEntry = lockPackages[bundled.lockPath]
    if (!lockEntry || lockEntry.version !== bundled.version) {
      throw new TypeError(`Bundle package ${bundled.lockPath} does not match package-lock.json`)
    }
    const component = packageComponent({
      ...bundled,
      inclusion: bundled.dev ? 'bundled-dev-classified' : 'bundled-production-classified',
      lockEntry,
      extraProperties: [
        { name: 'web-ide:evidence:chunks', value: sortStrings(bundled.chunks).join(',') },
        { name: 'web-ide:evidence:module-count', value: String(bundled.moduleCount) },
      ],
    })
    const previous = byBomRef.get(component['bom-ref'])
    if (previous && JSON.stringify(previous.hashes) !== JSON.stringify(component.hashes)) {
      throw new TypeError(`Conflicting package content for ${component['bom-ref']}`)
    }
    byBomRef.set(component['bom-ref'], component)
  }

  const externalPackages = [
    ['debugger-sh', 'runtime-external', packageManifest.dependencies?.['debugger-sh']],
    ['monaco-editor', 'runtime-external', lockPackages['node_modules/monaco-editor']?.version],
    ['react', 'peer-external', lockPackages['node_modules/react']?.version],
    ['react-dom', 'peer-external', lockPackages['node_modules/react-dom']?.version],
  ]
  for (const [name, inclusion, expectedVersion] of externalPackages) {
    const lockPath = `node_modules/${name}`
    const lockEntry = lockPackages[lockPath]
    if (!lockEntry || lockEntry.version !== expectedVersion) {
      throw new TypeError(`External release component ${name} is not exactly locked`)
    }
    const extraProperties = inclusion === 'peer-external'
      ? [{ name: 'web-ide:evidence:peer-range', value: packageManifest.peerDependencies[name] }]
      : []
    const component = packageComponent({
      name,
      version: lockEntry.version,
      lockPath,
      inclusion,
      lockEntry,
      extraProperties,
    })
    byBomRef.set(component['bom-ref'], component)
  }

  for (const asset of runtimeLock.assets) {
    const component = runtimeAssetComponent(asset)
    byBomRef.set(component['bom-ref'], component)
  }

  const rootRef = npmPurl(packageManifest.name, packageManifest.version)
  const components = [...byBomRef.values()]
    .sort((left, right) => left['bom-ref'] < right['bom-ref'] ? -1 : left['bom-ref'] > right['bom-ref'] ? 1 : 0)
  const componentRefs = components.map((component) => component['bom-ref'])
  const identity = [packageManifest.name, packageManifest.version, candidate.sha256, ...componentRefs].join('\n')
  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuidV5(identity)}`,
    version: 1,
    metadata: {
      component: {
        type: 'library',
        'bom-ref': rootRef,
        name: packageManifest.name,
        version: packageManifest.version,
        purl: rootRef,
        hashes: [{ alg: 'SHA-256', content: candidate.sha256 }],
        licenses: [{ expression: packageManifest.license }],
        properties: [
          { name: 'web-ide:evidence:candidate-filename', value: candidate.filename },
          { name: 'web-ide:evidence:candidate-size', value: String(candidate.size) },
        ],
      },
      properties: [
        { name: 'web-ide:evidence:runtime-asset-observed-date', value: runtimeLock.observedDate },
        { name: 'web-ide:evidence:runtime-digest-representation', value: runtimeLock.digestRepresentation },
        { name: 'web-ide:evidence:source', value: 'rollup-output-module-ownership' },
      ],
    },
    components,
    dependencies: [
      { ref: rootRef, dependsOn: componentRefs },
      ...componentRefs.map((ref) => ({ ref, dependsOn: [] })),
    ],
  }
}

export async function loadReleaseInputs(runtimeLockPath = path.join(repositoryRoot, 'release/runtime-assets.lock.json')) {
  return Promise.all([
    readJSON(path.join(repositoryRoot, 'package.json')),
    readJSON(path.join(repositoryRoot, 'package-lock.json')),
    readJSON(runtimeLockPath),
  ])
}

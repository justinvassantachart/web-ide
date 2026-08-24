import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  readRegularFileSnapshot,
  repositoryRoot,
  sha256Bytes,
} from './release-utils.mjs'

const CANDIDATE_REFERENCE = 'file:web-ide.tgz'
const NORMALIZED_LOCK_SHA256 = '6af9d98a1efb4a083b11f9d9dfdf1dc94739b1a28c495b89d7be3cac711b497c'
const CANDIDATE_INTEGRITY_PLACEHOLDER = '<candidate-sha512-integrity>'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const PACKAGE_PATH_PATTERN = /^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const ORDINARY_PACKAGE_KEYS = [
  'version',
  'resolved',
  'integrity',
  'dev',
  'optional',
  'peer',
  'license',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
  'bin',
  'funding',
  'cpu',
  'os',
  'hasInstallScript',
]

const EXPECTED_MANIFEST = {
  name: 'web-ide-packed-consumer-test',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: { build: 'tsc -b && vite build' },
  dependencies: {
    react: '^19.2.0',
    'react-dom': '^19.2.0',
    'web-ide': CANDIDATE_REFERENCE,
  },
  devDependencies: {
    '@types/react': '^19.2.7',
    '@types/react-dom': '^19.2.3',
    '@vitejs/plugin-react': '^5.1.1',
    buffer: '6.0.3',
    events: '3.3.0',
    'path-browserify': '1.0.1',
    process: '0.11.10',
    'stream-browserify': '3.0.0',
    typescript: '~5.9.3',
    vite: '^7.3.1',
    'vite-plugin-wasm': '^3.5.0',
  },
}

const EXPECTED_CANDIDATE = {
  version: '0.3.0',
  resolved: CANDIDATE_REFERENCE,
  integrity: CANDIDATE_INTEGRITY_PLACEHOLDER,
  license: 'MIT',
  workspaces: ['examples/basic', 'examples/plugin-demo'],
  dependencies: { 'debugger-sh': '0.3.15' },
  engines: { node: '^20.19.0 || >=22.12.0' },
  peerDependencies: {
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
  },
}

function parse(bytes, location) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new TypeError(`Packed consumer ${location} is not valid JSON`, { cause: error })
  }
}

function assertPlainObject(value, location) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`)
  }
}

function assertStringMap(value, location, { packageNames = false, safeVersions = false } = {}) {
  assertPlainObject(value, location)
  for (const [key, entry] of Object.entries(value)) {
    if ((packageNames && !PACKAGE_NAME_PATTERN.test(key)) || typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError(`${location} contains an invalid entry`)
    }
    if (safeVersions && /^[a-z][a-z0-9+.-]*:/iu.test(entry)) {
      throw new TypeError(`${location}.${key} contains a forbidden dependency source`)
    }
  }
}

function assertStringArray(value, location) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new TypeError(`${location} must be a non-empty string array`)
  }
}

function packageNameForPath(packagePath) {
  const marker = 'node_modules/'
  return packagePath.slice(packagePath.lastIndexOf(marker) + marker.length)
}

function assertRegistryPackage(packagePath, node) {
  const required = ['version', 'resolved', 'integrity', 'license']
  assertExactKeys(
    node,
    required,
    ORDINARY_PACKAGE_KEYS.filter((key) => !required.includes(key)),
    packagePath,
  )
  if (!VERSION_PATTERN.test(node.version)) throw new TypeError(`${packagePath}.version is invalid`)
  if (!SHA512_INTEGRITY_PATTERN.test(node.integrity)) throw new TypeError(`${packagePath}.integrity is invalid`)
  if (typeof node.license !== 'string' || node.license.length === 0) {
    throw new TypeError(`${packagePath}.license is missing`)
  }
  let resolved
  try {
    resolved = new URL(node.resolved)
  } catch (error) {
    throw new TypeError(`${packagePath}.resolved is not a registry URL`, { cause: error })
  }
  if (
    resolved.protocol !== 'https:'
    || resolved.hostname !== 'registry.npmjs.org'
    || resolved.username !== ''
    || resolved.password !== ''
    || resolved.search !== ''
    || resolved.hash !== ''
    || !resolved.pathname.endsWith('.tgz')
  ) throw new TypeError(`${packagePath}.resolved is not an exact registry.npmjs.org tarball URL`)

  for (const field of ['dev', 'optional', 'peer']) {
    if (field in node && node[field] !== true) throw new TypeError(`${packagePath}.${field} must be true when present`)
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (field in node) assertStringMap(node[field], `${packagePath}.${field}`, {
      packageNames: true,
      safeVersions: true,
    })
  }
  for (const field of ['engines', 'bin']) {
    if (field in node) assertStringMap(node[field], `${packagePath}.${field}`)
  }
  if ('peerDependenciesMeta' in node) {
    assertPlainObject(node.peerDependenciesMeta, `${packagePath}.peerDependenciesMeta`)
    for (const [name, metadata] of Object.entries(node.peerDependenciesMeta)) {
      if (!PACKAGE_NAME_PATTERN.test(name)) throw new TypeError(`${packagePath}.peerDependenciesMeta has an invalid name`)
      assertExactKeys(metadata, ['optional'], [], `${packagePath}.peerDependenciesMeta.${name}`)
      if (metadata.optional !== true) throw new TypeError(`${packagePath}.peerDependenciesMeta.${name} is invalid`)
    }
  }
  for (const field of ['cpu', 'os']) {
    if (field in node) assertStringArray(node[field], `${packagePath}.${field}`)
  }
  if ('funding' in node) {
    const entries = Array.isArray(node.funding) ? node.funding : [node.funding]
    if (entries.length === 0) throw new TypeError(`${packagePath}.funding must not be empty`)
    for (const [index, funding] of entries.entries()) {
      assertExactKeys(funding, ['url'], ['type'], `${packagePath}.funding[${index}]`)
      if (typeof funding.url !== 'string' || !funding.url.startsWith('https://')) {
        throw new TypeError(`${packagePath}.funding[${index}].url must use HTTPS`)
      }
      if ('type' in funding && (typeof funding.type !== 'string' || funding.type === '')) {
        throw new TypeError(`${packagePath}.funding[${index}].type is invalid`)
      }
    }
  }
  const installScriptAllowed = new Set(['node_modules/esbuild', 'node_modules/fsevents'])
  if ('hasInstallScript' in node && (node.hasInstallScript !== true || !installScriptAllowed.has(packagePath))) {
    throw new TypeError(`${packagePath}.hasInstallScript is not reviewed`)
  }
}

export function validateConsumerFixtureValues(manifest, lock, candidateIntegrity) {
  if (!SHA512_INTEGRITY_PATTERN.test(candidateIntegrity)) {
    throw new TypeError('Candidate SHA-512 integrity is malformed')
  }
  assertExactKeys(
    manifest,
    ['name', 'private', 'version', 'type', 'scripts', 'dependencies', 'devDependencies'],
    [],
    'packed consumer package.json',
  )
  if (canonicalJSONString(manifest) !== canonicalJSONString(EXPECTED_MANIFEST)) {
    throw new TypeError('Packed consumer manifest changed from the reviewed exact-candidate contract')
  }
  assertExactKeys(
    lock,
    ['name', 'version', 'lockfileVersion', 'requires', 'packages'],
    [],
    'packed consumer package-lock.json',
  )
  if (
    lock.name !== EXPECTED_MANIFEST.name
    || lock.version !== EXPECTED_MANIFEST.version
    || lock.lockfileVersion !== 3
    || lock.requires !== true
  ) throw new TypeError('Packed consumer lock root identity is invalid')
  assertPlainObject(lock.packages, 'packed consumer package-lock.json packages')
  const lockRoot = lock.packages['']
  assertExactKeys(lockRoot, ['name', 'version', 'dependencies', 'devDependencies'], [], 'packed consumer lock root')
  if (canonicalJSONString(lockRoot) !== canonicalJSONString({
    name: EXPECTED_MANIFEST.name,
    version: EXPECTED_MANIFEST.version,
    dependencies: EXPECTED_MANIFEST.dependencies,
    devDependencies: EXPECTED_MANIFEST.devDependencies,
  })) throw new TypeError('Packed consumer lock root does not exactly match package.json')

  const candidate = lock.packages['node_modules/web-ide']
  assertExactKeys(
    candidate,
    ['version', 'resolved', 'integrity', 'license', 'workspaces', 'dependencies', 'engines', 'peerDependencies'],
    [],
    'packed consumer candidate node',
  )
  const normalizedCandidate = { ...candidate, integrity: CANDIDATE_INTEGRITY_PLACEHOLDER }
  if (
    candidate.integrity !== candidateIntegrity
    || canonicalJSONString(normalizedCandidate) !== canonicalJSONString(EXPECTED_CANDIDATE)
  ) throw new TypeError('Packed consumer lock does not bind the exact candidate')

  for (const [packagePath, node] of Object.entries(lock.packages)) {
    if (packagePath === '' || packagePath === 'node_modules/web-ide') continue
    if (!PACKAGE_PATH_PATTERN.test(packagePath)) {
      throw new TypeError(`Packed consumer lock has an unsafe package path: ${packagePath}`)
    }
    if (!PACKAGE_NAME_PATTERN.test(packageNameForPath(packagePath))) {
      throw new TypeError(`Packed consumer lock has an invalid package name: ${packagePath}`)
    }
    for (const forbidden of ['link', 'inBundle', 'bundled']) {
      if (forbidden in node) throw new TypeError(`${packagePath}.${forbidden} is forbidden`)
    }
    for (const key of Object.keys(node)) {
      if (!ORDINARY_PACKAGE_KEYS.includes(key)) throw new TypeError(`${packagePath} has unknown field ${key}`)
    }
    assertRegistryPackage(packagePath, node)
  }

  const normalizedLock = structuredClone(lock)
  normalizedLock.packages['node_modules/web-ide'].integrity = CANDIDATE_INTEGRITY_PLACEHOLDER
  if (sha256Bytes(Buffer.from(canonicalJSONString(normalizedLock))) !== NORMALIZED_LOCK_SHA256) {
    throw new TypeError('Packed consumer lock differs from the reviewed complete dependency graph')
  }
  return { manifest, lock }
}

export async function validateCommittedConsumerFixture(candidateIntegrity) {
  const packagePath = path.join(repositoryRoot, 'tests/consumer/package.json')
  const lockPath = path.join(repositoryRoot, 'tests/consumer/package-lock.json')
  const [packageSnapshot, lockSnapshot] = await Promise.all([
    readRegularFileSnapshot(packagePath, 'Packed consumer package.json', 64 * 1024),
    readRegularFileSnapshot(lockPath, 'Packed consumer package-lock.json', 8 * 1024 * 1024),
  ])
  const packageBytes = packageSnapshot.bytes
  const lockBytes = lockSnapshot.bytes
  validateConsumerFixtureValues(
    parse(packageBytes, 'package.json'),
    parse(lockBytes, 'package-lock.json'),
    candidateIntegrity,
  )
  return {
    packageJson: {
      fileName: 'tests/consumer/package.json',
      size: packageBytes.length,
      sha256: sha256Bytes(packageBytes),
    },
    packageLock: {
      fileName: 'tests/consumer/package-lock.json',
      size: lockBytes.length,
      sha256: sha256Bytes(lockBytes),
    },
    candidateSha512Integrity: candidateIntegrity,
  }
}

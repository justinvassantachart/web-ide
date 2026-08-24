import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createArtifactManifest,
  validateArtifactManifest,
} from '../../scripts/release/artifact-manifest.mjs'
import {
  createReleaseProvenancePlugin,
  normalizeModuleId,
  packageOwnerForModule,
  validateBundleProvenance,
} from '../../scripts/release/bundle-provenance.mjs'
import {
  assertCleanIsolatedCheckoutStatus,
  assertExpectedIgnoredCheckoutStatus,
  settleIsolatedBuilds,
} from '../../scripts/release/candidate-builds.mjs'
import { runBoundedCommandLog } from '../../scripts/release/bounded-command-log.mjs'
import { canonicalJSONString } from '../../scripts/release/canonical-json.mjs'
import {
  validateCommittedConsumerFixture,
  validateConsumerFixtureValues,
} from '../../scripts/release/consumer-fixture.mjs'
import { generateLicenseEvidence } from '../../scripts/release/licenses.mjs'
import { readPackageTarball, scanPackedEntry } from '../../scripts/release/package-inspection.mjs'
import { run, settleOperations } from '../../scripts/release/process-utils.mjs'
import { assertCanonicalSnapshotUnchanged } from '../../scripts/release/publication-guard.mjs'
import {
  readExternalRegularFile,
  readJSON,
  repositoryRoot,
} from '../../scripts/release/release-utils.mjs'
import {
  MAX_VALIDATION_GATE_LOG_BYTES,
  VALIDATION_GATES,
  validateFinalCandidateState,
  validateValidationSummary,
} from '../../scripts/release/release-inputs.mjs'
import { validateRuntimeAssetLock, verifyRuntimeAssets } from '../../scripts/release/runtime-assets.mjs'
import { generateCycloneDx } from '../../scripts/release/sbom.mjs'
import {
  sourceArchiveBytes,
  verifyIndependentGitHubSource,
  verifyReleaseSourceState,
} from '../../scripts/release/source-state.mjs'
import {
  parsePinnedCycloneDxSchema,
  validateCycloneDx,
} from '../../scripts/release/validate-cyclonedx.mjs'
import { validateReleaseSchema } from '../../scripts/release/validate-release-schema.mjs'
import {
  beginDirectoryReplacement,
  beginEmptyDirectoryTransaction,
} from '../../scripts/release/transactional-output.mjs'
import {
  createPreflightValidationGateReceipt,
  createValidationGateReceipt,
  parsePreflightValidationGateReceipt,
  parseValidationGateReceipt,
  preflightValidationGateReceiptFooter,
  validationGateReceiptFooter,
} from '../../scripts/release/validation-gate-receipt.mjs'
import {
  defaultPlaywrightBrowsersPath,
  withValidationGateEnvironment,
} from '../../scripts/release/validation-gate-environment.mjs'
import {
  decodeValidationLog,
  normalizeValidationGateLog,
  normalizeValidationGateLogFile,
} from '../../scripts/release/validation-log.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function tarNumeric(value, digits) {
  return `${value.toString(8).padStart(digits, '0')} \0`
}

function refreshTarHeaderChecksum(entry) {
  const header = entry.subarray(0, 512)
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')} \0`, 148, 8, 'ascii')
}

function tarEntry(name, content, type = '0') {
  const bytes = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(tarNumeric(0o644, 6), 100, 8, 'ascii')
  header.write(tarNumeric(bytes.length, 10), 124, 12, 'ascii')
  header.write('3560116604 \0', 136, 12, 'ascii')
  header[156] = type.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(tarNumeric(0, 6), 329, 8, 'ascii')
  header.write(tarNumeric(0, 6), 337, 8, 'ascii')
  refreshTarHeaderChecksum(header)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

function tarball(entries) {
  const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 })
  bytes[9] = 0xff
  return bytes
}

function runtimeLock(overrides = {}) {
  const bytes = Buffer.from('runtime bytes')
  return {
    schemaVersion: 1,
    package: 'web-ide',
    observedDate: '2026-08-24',
    digestRepresentation: 'identity-encoded-response-body',
    expectedRedirectCount: 0,
    requestTimeoutMs: 1000,
    scope: 'Fixture asset.',
    limitations: ['Fixture only.'],
    assets: [{
      id: 'fixture.wasm',
      version: '1',
      requestedUrl: 'https://assets.example.test/runtime.wasm',
      finalUrl: 'https://assets.example.test/runtime.wasm',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: 'application/wasm',
      headers: {
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': null,
      },
      license: 'MIT',
      licenseTextPaths: ['LICENSE.md'],
      sourceRepository: 'https://example.test/source',
      sourceLocations: ['src/runtime.ts'],
      ...overrides,
    }],
  }
}

async function regularFileIdentity(filePath) {
  const info = await lstat(filePath, { bigint: true })
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
  }
}

describe('canonical JSON', () => {
  it('sorts every object and rejects non-JSON values', () => {
    expect(canonicalJSONString({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}\n')
    expect(() => canonicalJSONString({ value: undefined })).toThrow(/undefined/u)
    expect(() => canonicalJSONString({ value: Number.NaN })).toThrow(/finite/u)
  })
})

describe('Rollup module ownership', () => {
  it('uses the longest nested node_modules lock path and normalizes the checkout root', () => {
    const root = '/checkout'
    const owner = packageOwnerForModule(
      '/checkout/node_modules/a/node_modules/b/index.js?commonjs-proxy',
      {
        'node_modules/a': { version: '1.0.0', dev: true },
        'node_modules/a/node_modules/b': { version: '2.0.0', dev: true },
      },
      root,
    )
    expect(owner).toEqual({
      lockPath: 'node_modules/a/node_modules/b',
      name: 'b',
      version: '2.0.0',
      dev: true,
    })
    expect(normalizeModuleId('/checkout/src/index.ts', root)).toBe('<repository>/src/index.ts')
    expect(() => normalizeModuleId('/different/private.ts', root)).toThrow(/outside/u)
  })

  it('records path-normalized rendered ownership without path-length-sensitive source metrics', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-provenance-normalization-'))
    temporaryDirectories.push(directory)
    const reports = []
    for (const [name, originalLength] of [['short', 10], ['a-much-longer-root-name', 999]]) {
      const root = path.join(directory, name)
      await mkdir(root)
      await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/pkg': { version: '1.0.0', dev: true } },
      }))
      const reportPath = path.join(directory, `${name}.json`)
      const plugin = await createReleaseProvenancePlugin(reportPath, root)
      await plugin.generateBundle({}, {
        'index.js': {
          type: 'chunk',
          name: 'index',
          isEntry: true,
          isDynamicEntry: false,
          modules: {
            [path.join(root, 'node_modules/pkg/index.js')]: {
              renderedLength: 7,
              originalLength,
            },
          },
        },
      })
      reports.push(await readFile(reportPath))
    }
    expect(reports[0].equals(reports[1])).toBe(true)
  })

  it('rejects bundled node_modules records without exact lock ownership', () => {
    const provenance = {
      schemaVersion: 1,
      package: 'web-ide',
      format: 'vite-rollup-output-modules',
      chunks: [{
        fileName: 'index.js',
        name: 'index',
        isEntry: true,
        isDynamicEntry: false,
        modules: [{
          id: '<repository>/node_modules/unowned/index.js',
          renderedLength: 1,
          package: null,
        }],
      }],
      packages: [],
    }
    expect(() => validateBundleProvenance(provenance)).toThrow(/without package-lock ownership/u)
    provenance.chunks[0].modules[0].package = {
      lockPath: 'node_modules/different',
      name: 'different',
      version: '1.0.0',
      dev: true,
    }
    expect(() => validateBundleProvenance(provenance)).toThrow(/does not own/u)
  })
})

describe('safe tar reading', () => {
  it('extracts a regular package file inventory without writing it', () => {
    const entries = readPackageTarball(tarball([tarEntry('package/package.json', '{}')]))
    expect(entries).toMatchObject([{ path: 'package.json', type: 'file', size: 2 }])
  })

  it('rejects traversal, links, and case collisions', () => {
    expect(() => readPackageTarball(tarball([tarEntry('package/../escape', 'x')]))).toThrow(/outside package/u)
    expect(() => readPackageTarball(tarball([tarEntry('package/link', '', '2')]))).toThrow(/Forbidden tar entry/u)
    expect(() => readPackageTarball(tarball([tarEntry('package/directory', '', '5')]))).toThrow(/Forbidden tar entry/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/A.js', 'a'),
      tarEntry('package/a.js', 'b'),
    ]))).toThrow(/Case-colliding/u)
  })

  it('rejects malformed UTF-8 in archive paths', () => {
    const entry = tarEntry('package/index.js', 'export {}\n')
    entry[8] = 0xff
    refreshTarHeaderChecksum(entry)
    expect(() => readPackageTarball(tarball([entry]))).toThrow(/not valid UTF-8/u)
  })

  it('rejects every unused PAX and hidden metadata channel', () => {
    const globalPax = tarEntry(
      'package/pax',
      '45 path=package/token=abcdefghijk-hidden.js\n',
      'g',
    )
    const emptyPax = tarEntry('package/pax', '', 'x')
    const duplicatePax = tarEntry(
      'package/pax',
      '25 path=package/a.js\n25 path=package/b.js\n',
      'x',
    )
    const excessivePax = tarEntry(
      'package/pax',
      `8193 path=package/${'a'.repeat(8_170)}\n`,
      'x',
    )

    for (const entries of [
      [globalPax],
      [emptyPax],
      [emptyPax, emptyPax, tarEntry('package/index.js', 'export {}\n')],
      [duplicatePax, tarEntry('package/index.js', 'export {}\n')],
      [excessivePax, tarEntry('package/index.js', 'export {}\n')],
    ]) {
      expect(() => readPackageTarball(tarball(entries))).toThrow(/Forbidden tar entry type/u)
    }
  })

  it('requires one canonical gzip member with no hidden concatenated member', () => {
    const first = tarball([tarEntry('package/package.json', '{}')])
    const emptyMember = gzipSync(Buffer.alloc(0), { level: 9, mtime: 0 })
    emptyMember[3] = 0x08
    emptyMember[9] = 0xff
    const hiddenMember = Buffer.concat([
      emptyMember.subarray(0, 10),
      Buffer.from('token=abcdefghijk-hidden\0'),
      emptyMember.subarray(10),
    ])
    expect(() => readPackageTarball(Buffer.concat([first, hiddenMember])))
      .toThrow(/one exact canonical npm gzip member/u)
  })

  it('rejects noncanonical fixed headers, special modes, and nonzero padding', () => {
    const afterNameNul = tarEntry('package/index.js', 'x')
    afterNameNul['package/index.js'.length + 1] = 0x41
    refreshTarHeaderChecksum(afterNameNul)

    const uname = tarEntry('package/index.js', 'x')
    uname[266] = 0x41
    refreshTarHeaderChecksum(uname)

    const reserved = tarEntry('package/index.js', 'x')
    reserved[501] = 0x41
    refreshTarHeaderChecksum(reserved)

    const specialMode = tarEntry('package/index.js', 'x')
    specialMode.write(tarNumeric(0o4644, 6), 100, 8, 'ascii')
    refreshTarHeaderChecksum(specialMode)

    const nonzeroPadding = tarEntry('package/index.js', 'x')
    nonzeroPadding[513] = 0x41

    for (const entry of [afterNameNul, uname, reserved, specialMode, nonzeroPadding]) {
      expect(() => readPackageTarball(tarball([entry]))).toThrow()
    }
  })

  it('requires bounded control-free paths and two zero end-marker blocks', () => {
    expect(() => readPackageTarball(tarball([
      tarEntry(`package/${String.fromCodePoint(0x80)}.js`, 'x'),
    ]))).toThrow(/Unsafe tar path/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('a'.repeat(100), 'x'),
    ]))).toThrow(/NUL terminator/u)
    const oneEndBlock = gzipSync(Buffer.concat([
      tarEntry('package/index.js', 'x'),
      Buffer.alloc(512),
    ]), { level: 9 })
    oneEndBlock[9] = 0xff
    expect(() => readPackageTarball(oneEndBlock)).toThrow(/two zero end-marker/u)
  })

  it('enforces archive entry and per-entry size ceilings', () => {
    const excessiveEntries = Array.from(
      { length: 513 },
      (_, index) => tarEntry(`package/${String(index).padStart(3, '0')}.js`, ''),
    )
    expect(() => readPackageTarball(tarball(excessiveEntries))).toThrow(/entry limit/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/oversized.js', Buffer.alloc(8 * 1024 * 1024 + 1)),
    ]))).toThrow(/per-entry size/u)
  })

  it('classifies and scans every permitted packed file fail-closed', () => {
    expect(() => scanPackedEntry({ path: 'dist/index.js', bytes: Buffer.from('export {}\n') })).not.toThrow()
    expect(() => scanPackedEntry({
      path: 'dist/index.js',
      bytes: Buffer.from('this._token = setTimeout(() => {}, 1)\n'),
    })).not.toThrow()
    expect(() => scanPackedEntry({
      path: 'THIRD_PARTY_LICENSES.txt',
      bytes: Buffer.from('Basic permission remains subject to this license.\n'),
    })).not.toThrow()
    expect(() => scanPackedEntry({ path: 'dist/runtime.wasm', bytes: Buffer.from('wasm') })).toThrow(/text allowlist/u)
    expect(() => scanPackedEntry({ path: 'dist/index.js', bytes: Buffer.from([0xff]) })).toThrow(/valid UTF-8/u)
    expect(() => scanPackedEntry({
      path: 'dist/index.js',
      bytes: Buffer.from('const token = "abcdefghijk"\n'),
    })).toThrow(/secret assignment/u)
    for (const secret of [
      'client_secret=abcdefghijk',
      'password: abcdefghijk',
      'WEB_IDE_CLIENT_SECRET=abcdefghijk',
      'DATABASE_PASSWORD=abcdefghijk',
      'MY_API_KEY=abcdefghijk',
      `github_pat_${'a'.repeat(24)}`,
      `npm_${'a'.repeat(24)}`,
      'xoxb-1234567890-abcdefghij',
      'Bearer abcdefghijklmnop',
      'Basic dXNlcjpwYXNzd29yZA==',
      'https://teacher:password@example.invalid/path',
      'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
    ]) {
      expect(() => scanPackedEntry({
        path: 'dist/index.js',
        bytes: Buffer.from(secret),
      })).toThrow()
      expect(() => decodeValidationLog(Buffer.from(secret), 'fixture.log')).toThrow()
    }
  })
})

describe('isolated build settlement', () => {
  it('fails immediately when an isolated operation mutates tracked or untracked source', () => {
    expect(() => assertCleanIsolatedCheckoutStatus('', 1, 'build')).not.toThrow()
    expect(() => assertCleanIsolatedCheckoutStatus(' M package.json\n?? generated.txt\n', 1, 'build'))
      .toThrow(/after build/u)
    expect(() => assertExpectedIgnoredCheckoutStatus(
      '!! dist/\n!! node_modules/',
      1,
      'build',
      ['dist/', 'node_modules/'],
    )).not.toThrow()
    expect(() => assertExpectedIgnoredCheckoutStatus(
      '!! debug.log',
      1,
      'build',
      ['dist/', 'node_modules/'],
    )).toThrow(/unexpected ignored output/u)
  })

  it('waits for every concurrent build to settle before surfacing failures', async () => {
    let finishSecond
    const second = new Promise((resolve) => { finishSecond = resolve })
    let rejected = false
    const settlement = settleIsolatedBuilds([
      Promise.reject(new Error('first build failed')),
      second,
    ])
    settlement.catch(() => { rejected = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(rejected).toBe(false)
    finishSecond('second build finished')
    await expect(settlement).rejects.toThrow(/isolated release builds failed/u)
  })

  it('waits for every generic concurrent operation before cleanup can continue', async () => {
    let finishSibling
    const sibling = new Promise((resolve) => { finishSibling = resolve })
    let settled = false
    const operations = settleOperations([
      Promise.reject(new Error('setup failed')),
      sibling,
    ], 'Fixture setup')
    operations.catch(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishSibling('complete')
    await expect(operations).rejects.toThrow(/Fixture setup failed/u)
  })
})

describe('committed exact-candidate consumer fixture', () => {
  it('hashes both metadata files and binds the lock to the candidate SRI', async () => {
    const lock = await readJSON(path.join(repositoryRoot, 'tests/consumer/package-lock.json'))
    const candidateIntegrity = lock.packages['node_modules/web-ide'].integrity
    const evidence = await validateCommittedConsumerFixture(candidateIntegrity)
    expect(evidence).toMatchObject({
      candidateSha512Integrity: candidateIntegrity,
      packageJson: { fileName: 'tests/consumer/package.json' },
      packageLock: { fileName: 'tests/consumer/package-lock.json' },
    })
    await expect(validateCommittedConsumerFixture(
      `sha512-${Buffer.alloc(64).toString('base64')}`,
    )).rejects.toThrow(/exact candidate/u)
  })

  it('rejects unreviewed manifest, registry, package-node, and integrity mutations', async () => {
    const manifest = await readJSON(path.join(repositoryRoot, 'tests/consumer/package.json'))
    const lock = await readJSON(path.join(repositoryRoot, 'tests/consumer/package-lock.json'))
    const candidateIntegrity = lock.packages['node_modules/web-ide'].integrity
    expect(() => validateConsumerFixtureValues(manifest, lock, candidateIntegrity)).not.toThrow()

    const cases = []
    const addedDependencyManifest = structuredClone(manifest)
    const addedDependencyLock = structuredClone(lock)
    addedDependencyManifest.dependencies['extra-package'] = '1.0.0'
    addedDependencyLock.packages[''].dependencies['extra-package'] = '1.0.0'
    cases.push([addedDependencyManifest, addedDependencyLock])

    const gitDependency = structuredClone(lock)
    gitDependency.packages['node_modules/@babel/core'].dependencies.fixture = 'git+https://example.invalid/repo.git'
    cases.push([manifest, gitDependency])
    const linked = structuredClone(lock)
    linked.packages['node_modules/react'].link = true
    cases.push([manifest, linked])
    const installScript = structuredClone(lock)
    installScript.packages['node_modules/react'].hasInstallScript = true
    cases.push([manifest, installScript])
    const customRegistry = structuredClone(lock)
    customRegistry.packages['node_modules/react'].resolved = 'https://packages.example.invalid/react.tgz'
    cases.push([manifest, customRegistry])
    const unknownField = structuredClone(lock)
    unknownField.packages['node_modules/react'].unreviewed = true
    cases.push([manifest, unknownField])
    const missingIntegrity = structuredClone(lock)
    delete missingIntegrity.packages['node_modules/react'].integrity
    cases.push([manifest, missingIntegrity])

    for (const [candidateManifest, candidateLock] of cases) {
      expect(() => validateConsumerFixtureValues(
        candidateManifest,
        candidateLock,
        candidateIntegrity,
      )).toThrow()
    }
  })
})

describe('bounded subprocess evidence', () => {
  it('writes exact successful bytes and a bounded verified footer', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-command-log-'))
    temporaryDirectories.push(directory)
    const outputPath = path.join(directory, 'success.log')
    const result = await runBoundedCommandLog({
      command: process.execPath,
      arguments: ['-e', "process.stdout.write('exact output\\n')"],
      cwd: directory,
      env: { PATH: process.env.PATH ?? '' },
      outputPath,
      maximumBytes: 1024,
      timeoutMs: 5_000,
      footerForSuccessfulExit: async () => Buffer.from('verified footer\n'),
    })
    expect(result).toMatchObject({ exitCode: 0, size: 29 })
    expect(result.fileIdentity).toEqual(await regularFileIdentity(outputPath))
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('exact output\nverified footer\n')
  })

  it('normalizes completed path-bearing logs and preserves the exact final receipt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-normalized-log-'))
    temporaryDirectories.push(directory)
    const repository = '/Users/synthetic/Projects/web-ide'
    const candidate = '/Users/synthetic/evidence/candidate-r2'
    const home = '/Users/synthetic'
    const isolatedHome = '/private/tmp/web-ide-gate/home'
    const temporary = '/private/tmp/web-ide-gate/tmp'
    const sourceCommit = 'a'.repeat(40)
    const candidateSha256 = 'b'.repeat(64)
    const receipt = createValidationGateReceipt({
      gateId: 'validate-production',
      sourceCommit,
      candidateSha256,
      exitCode: 0,
      emitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
    })
    const receiptFooter = validationGateReceiptFooter(receipt)
    const splitRepositoryPath = Buffer.concat([
      Buffer.from('stack: /Users/synthetic/Projects/web-'),
      Buffer.from('ide/src/index.ts:1\n'),
    ])
    const raw = Buffer.concat([
      splitRepositoryPath,
      Buffer.from([
        `candidate: ${candidate}/web-ide-0.2.0.tgz`,
        `home: ${home}/Library/Caches/ms-playwright`,
        `isolated home: ${isolatedHome}/.npmrc`,
        `temporary: ${temporary}/consumer/package.json`,
        `url: file://${repository}/tests/release/release-evidence.test.mjs`,
        `encoded: ${encodeURIComponent(repository)}/package.json`,
        `encoded file: file:${encodeURIComponent(`///${repository.slice(1)}`)}/package.json`,
        String.raw`json: \/Users\/synthetic\/Projects\/web-ide\/package.json`,
        'token=abcdefghijk',
      ].join('\n') + receiptFooter),
    ])
    const roots = {
      repository: [repository],
      home: [home, isolatedHome],
      candidate: [candidate],
      temporary: [temporary, '/private/tmp/web-ide-gate'],
    }

    const normalizedBytes = normalizeValidationGateLog(raw, { roots, receiptFooter })
    const normalized = normalizedBytes.toString('utf8')
    expect(normalized).toContain('stack: <repository-root>/src/index.ts:1')
    expect(normalized).toContain('candidate: <web-candidate>/web-ide-0.2.0.tgz')
    expect(normalized).toContain('home: <home>/Library/Caches/ms-playwright')
    expect(normalized).toContain('isolated home: <home>/.npmrc')
    expect(normalized).toContain('temporary: <execution-root>/consumer/package.json')
    expect(normalized).toContain('url: file:<repository-root>/tests/release/release-evidence.test.mjs')
    expect(normalized).toContain('encoded: <repository-root>/package.json')
    expect(normalized).toContain('encoded file: file:<repository-root>/package.json')
    expect(normalized).toContain(String.raw`json: <repository-root>\/package.json`)
    expect(normalized).toContain('token=abcdefghijk')
    expect(normalized.endsWith(receiptFooter)).toBe(true)
    expect(parseValidationGateReceipt(normalized, {
      gateId: 'validate-production',
      sourceCommit,
      candidateSha256,
    })).toEqual(receipt)
    expect(() => decodeValidationLog(normalizedBytes, 'fixture.log')).toThrow(/secret assignment/u)

    const logPath = path.join(directory, 'normalized.log')
    const outputPath = path.join(directory, 'published.log')
    await writeFile(logPath, raw, { mode: 0o600 })
    await expect(normalizeValidationGateLogFile({
      rawLogPath: logPath,
      outputPath,
      expectedRawIdentity: await regularFileIdentity(logPath),
      maximumBytes: 16 * 1024,
      roots,
      receiptFooter,
    })).rejects.toThrow(/secret assignment/u)
    await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(directory)).toEqual([])
  })

  it('atomically publishes a normalized log and fails closed on residual local paths', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-normalized-log-file-'))
    temporaryDirectories.push(directory)
    const sourceCommit = 'a'.repeat(40)
    const candidateSha256 = 'b'.repeat(64)
    const receipt = createValidationGateReceipt({
      gateId: 'audit-full',
      sourceCommit,
      candidateSha256,
      exitCode: 0,
      emitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
    })
    const receiptFooter = validationGateReceiptFooter(receipt)
    const roots = {
      repository: ['/opt/build/web-ide'],
      home: ['/home/synthetic'],
      candidate: ['/opt/evidence/candidate'],
      temporary: ['/tmp/web-ide-gate'],
    }
    const rawLogPath = path.join(directory, '.audit.log.raw')
    const outputPath = path.join(directory, 'audit.log')
    await writeFile(rawLogPath, `checked /opt/build/web-ide/package.json${receiptFooter}`, { mode: 0o600 })
    const result = await normalizeValidationGateLogFile({
      rawLogPath,
      outputPath,
      expectedRawIdentity: await regularFileIdentity(rawLogPath),
      maximumBytes: 16 * 1024,
      roots,
      receiptFooter,
    })
    expect(result.text).toContain('checked <repository-root>/package.json')
    expect(result.text.endsWith(receiptFooter)).toBe(true)
    expect(await readFile(outputPath, 'utf8')).toBe(result.text)
    expect(result.fileIdentity).toEqual(await regularFileIdentity(outputPath))
    expect(await readdir(directory)).toEqual(['audit.log'])

    for (const unsafe of [
      '/Users/unrecognized/private.txt',
      '/home/unrecognized/private.txt',
      '/private/var/unrecognized/private.txt',
      '/var/folders/unrecognized/private.txt',
      '/tmp/unrecognized/private.txt',
      '/private/Users/synthetic/private.txt',
      'prefix/Users/synthetic/private.txt',
      'prefixfile:///Users/synthetic/private.txt',
      String.raw`C:\Users\unrecognized\private.txt`,
      'file:///opt/unrecognized/private.txt',
      '%2FUsers%2Funrecognized%2Fprivate.txt',
      '%2Fopt%2Funrecognized%2Fprivate.txt',
      'file:%2F%2F%2Fopt%2Funrecognized%2Fprivate.txt',
      `/Users/unrec\u001b[31mognized/private.txt`,
    ]) {
      expect(() => normalizeValidationGateLog(
        Buffer.from(`${unsafe}${receiptFooter}`),
        { roots, receiptFooter },
      )).toThrow(/unsafe local path/u)
      expect(() => decodeValidationLog(Buffer.from(unsafe), 'residual-path.log'))
        .toThrow(/unsafe local path/u)
    }
    expect(() => normalizeValidationGateLog(
      Buffer.from(`clean output${receiptFooter}trailing bytes`),
      { roots, receiptFooter },
    )).toThrow(/not final/u)

    for (const embeddedPlaceholder of [
      'prefix<home>/private.txt',
      '/private<home>/private.txt',
      'prefixfile:<home>/private.txt',
      '<home>suffix/private.txt',
    ]) {
      expect(() => decodeValidationLog(Buffer.from(embeddedPlaceholder), 'embedded.log'))
        .toThrow(/embeds a .*path placeholder/u)
    }

    const encodedRoots = normalizeValidationGateLog(Buffer.from([
      '%2Fopt%2Fbuild%2Fweb-ide/package.json',
      'file:%2F%2F%2Fopt%2Fbuild%2Fweb-ide/package.json',
      receiptFooter,
    ].join('\n')), { roots, receiptFooter }).toString('utf8')
    expect(encodedRoots).toContain('<repository-root>/package.json')
    expect(encodedRoots).toContain('file:<repository-root>/package.json')

    const ansiSplitGitHubToken = `ghp_${'a'.repeat(10)}\u001b[31m${'b'.repeat(12)}`
    expect(() => decodeValidationLog(Buffer.from(ansiSplitGitHubToken), 'ansi-secret.log'))
      .toThrow(/GitHub token/u)
  })

  it('pins raw and normalized inodes and never clobbers a competing publication', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-normalized-log-races-'))
    temporaryDirectories.push(directory)
    const sourceCommit = 'a'.repeat(40)
    const candidateSha256 = 'b'.repeat(64)
    const receiptFooter = validationGateReceiptFooter(createValidationGateReceipt({
      gateId: 'audit-production',
      sourceCommit,
      candidateSha256,
      exitCode: 0,
      emitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
    }))
    const roots = {
      repository: ['/opt/build/web-ide'],
      home: ['/home/synthetic'],
      candidate: ['/opt/evidence/candidate'],
      temporary: ['/tmp/web-ide-gate'],
    }
    const rawBytes = Buffer.from(`checked /opt/build/web-ide/package.json${receiptFooter}`)
    const runRace = async (name, beforePublish) => {
      const caseDirectory = path.join(directory, name)
      await mkdir(caseDirectory)
      const rawLogPath = path.join(caseDirectory, '.gate.raw')
      const outputPath = path.join(caseDirectory, 'gate.log')
      await writeFile(rawLogPath, rawBytes, { mode: 0o600 })
      const expectedRawIdentity = await regularFileIdentity(rawLogPath)
      const operation = normalizeValidationGateLogFile({
        rawLogPath,
        outputPath,
        expectedRawIdentity,
        maximumBytes: 16 * 1024,
        roots,
        receiptFooter,
        hooks: { beforePublish },
      })
      return { caseDirectory, rawLogPath, outputPath, operation }
    }

    const rawRace = await runRace('raw-replacement', async ({ rawLogPath }) => {
      await rename(rawLogPath, path.join(path.dirname(rawLogPath), 'owned-raw.log'))
      await writeFile(rawLogPath, 'competing raw bytes\n', { mode: 0o600 })
    })
    await expect(rawRace.operation).rejects.toThrow(/publication and cleanup failed/u)
    await expect(readFile(rawRace.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(rawRace.rawLogPath, 'utf8')).resolves.toBe('competing raw bytes\n')
    await expect(readFile(path.join(rawRace.caseDirectory, 'owned-raw.log')))
      .resolves.toEqual(rawBytes)

    let displacedNormalizedPath
    const normalizedRace = await runRace('normalized-replacement', async ({ normalizedPath }) => {
      displacedNormalizedPath = path.join(path.dirname(normalizedPath), 'owned-normalized.log')
      await rename(normalizedPath, displacedNormalizedPath)
      await writeFile(normalizedPath, 'competing normalized bytes\n', { mode: 0o600 })
    })
    await expect(normalizedRace.operation).rejects.toThrow(/publication and cleanup failed/u)
    await expect(readFile(normalizedRace.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(displacedNormalizedPath, 'utf8'))
      .resolves.toContain('<repository-root>/package.json')
    const normalizedCompetitor = (await readdir(normalizedRace.caseDirectory))
      .find((fileName) => fileName.includes('.normalized-'))
    expect(normalizedCompetitor).toBeTruthy()
    await expect(readFile(path.join(normalizedRace.caseDirectory, normalizedCompetitor), 'utf8'))
      .resolves.toBe('competing normalized bytes\n')

    const outputRace = await runRace('output-no-clobber', async ({ outputPath }) => {
      await writeFile(outputPath, 'competing published bytes\n', { mode: 0o600 })
    })
    await expect(outputRace.operation).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(outputRace.outputPath, 'utf8'))
      .resolves.toBe('competing published bytes\n')
    expect(await readdir(outputRace.caseDirectory)).toEqual(['gate.log'])

    const untrustedDirectory = path.join(directory, 'untrusted-parent')
    await mkdir(untrustedDirectory)
    await chmod(untrustedDirectory, 0o777)
    const untrustedRawPath = path.join(untrustedDirectory, '.gate.raw')
    const untrustedOutputPath = path.join(untrustedDirectory, 'gate.log')
    await writeFile(untrustedRawPath, rawBytes, { mode: 0o600 })
    await expect(normalizeValidationGateLogFile({
      rawLogPath: untrustedRawPath,
      outputPath: untrustedOutputPath,
      expectedRawIdentity: await regularFileIdentity(untrustedRawPath),
      maximumBytes: 16 * 1024,
      roots,
      receiptFooter,
    })).rejects.toThrow(/must not be group- or world-writable/u)
    await expect(readFile(untrustedOutputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await chmod(untrustedDirectory, 0o700)
  })

  it('terminates output and time limit violations without retaining partial logs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-bounded-failure-'))
    temporaryDirectories.push(directory)
    const cases = [
      {
        name: 'stdout.log',
        arguments: ['-e', "process.stdout.write('x'.repeat(2048))"],
        maximumBytes: 1024,
        timeoutMs: 5_000,
        pattern: /command-log limit/u,
      },
      {
        name: 'stderr.log',
        arguments: ['-e', "process.stderr.write('x'.repeat(2048))"],
        maximumBytes: 1024,
        timeoutMs: 5_000,
        pattern: /command-log limit/u,
      },
      {
        name: 'timeout.log',
        arguments: ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
        maximumBytes: 1024,
        timeoutMs: 250,
        pattern: /command-log timeout/u,
      },
    ]
    for (const fixture of cases) {
      const outputPath = path.join(directory, fixture.name)
      await expect(runBoundedCommandLog({
        command: process.execPath,
        arguments: fixture.arguments,
        cwd: directory,
        env: { PATH: process.env.PATH ?? '' },
        outputPath,
        maximumBytes: fixture.maximumBytes,
        timeoutMs: fixture.timeoutMs,
      })).rejects.toThrow(fixture.pattern)
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('bounds generic subprocess stdout, stderr, and duration', async () => {
    await expect(run(process.execPath, ['-e', "process.stdout.write('x'.repeat(128))"], {
      maxStdoutBytes: 64,
    })).rejects.toThrow(/stdout limit/u)
    await expect(run(process.execPath, ['-e', "process.stderr.write('x'.repeat(128))"], {
      maxStderrBytes: 64,
    })).rejects.toThrow(/stderr limit/u)
    await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 250,
    })).rejects.toThrow(/process timeout/u)
  })

  it('settles TERM-resistant residual process-group members for both runners', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-process-group-'))
    temporaryDirectories.push(directory)
    const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const leaderArguments = (pidPath) => ['-e', [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' })`,
      'child.unref()',
      `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
    ].join(';')]
    const assertGone = async (pidPath) => {
      const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
      expect(Number.isSafeInteger(pid)).toBe(true)
      let errorCode
      try {
        process.kill(pid, 0)
      } catch (error) {
        errorCode = error?.code
      }
      expect(errorCode).toBe('ESRCH')
    }

    const genericPidPath = path.join(directory, 'generic.pid')
    await expect(run(process.execPath, leaderArguments(genericPidPath), {
      cwd: directory,
      timeoutMs: 10_000,
    })).rejects.toThrow(/residual process-group/u)
    await assertGone(genericPidPath)

    const logPidPath = path.join(directory, 'log.pid')
    const logPath = path.join(directory, 'residual.log')
    await expect(runBoundedCommandLog({
      command: process.execPath,
      arguments: leaderArguments(logPidPath),
      cwd: directory,
      env: { PATH: process.env.PATH ?? '' },
      outputPath: logPath,
      maximumBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow(/residual process-group/u)
    await assertGone(logPidPath)
    await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('rejects promptly when termination settlement fails before close', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-settlement-failure-'))
    temporaryDirectories.push(directory)
    const generic = {}
    const commandLog = {}
    const rejectingController = (holder) => (child) => {
      holder.child = child
      return {
        async terminateAndSettle() {
          throw new Error('fixture process-group settlement failure')
        },
        async ensureEmptyAfterClose() {
          return false
        },
      }
    }
    const stopFixture = async (holder) => {
      if (!holder.child?.pid) return
      const closed = once(holder.child, 'close')
      try {
        process.kill(-holder.child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
        return
      }
      await closed
    }

    try {
      await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: directory,
        timeoutMs: 50,
        processGroupControllerFactory: rejectingController(generic),
      })).rejects.toThrow(/fixture process-group settlement failure/u)
    } finally {
      await stopFixture(generic)
    }

    const logPath = path.join(directory, 'settlement-failure.log')
    try {
      await expect(runBoundedCommandLog({
        command: process.execPath,
        arguments: ['-e', "process.stdout.write('partial\\n'); setInterval(() => {}, 1000)"],
        cwd: directory,
        env: { PATH: process.env.PATH ?? '' },
        outputPath: logPath,
        maximumBytes: 1024,
        timeoutMs: 50,
        processGroupControllerFactory: rejectingController(commandLog),
      })).rejects.toThrow(/fixture process-group settlement failure/u)
      await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await stopFixture(commandLog)
    }
  }, 5_000)
})

describe('validation gate environment', () => {
  it('runs npm with distinct empty isolated configs and removes the complete workspace', async () => {
    let workspace
    const npmExecutable = process.platform === 'win32'
      ? 'npm'
      : path.join(path.dirname(process.execPath), 'npm')
    await withValidationGateEnvironment({
      candidateTarball: path.join(tmpdir(), 'fixture-web-ide.tgz'),
      playwrightBrowsersPath: defaultPlaywrightBrowsersPath(),
    }, async ({ environment, paths }) => {
      workspace = paths.workspace
      expect(environment).toEqual({
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: paths.home,
        TMPDIR: paths.temporary,
        XDG_CONFIG_HOME: paths.xdgConfig,
        XDG_CACHE_HOME: paths.xdgCache,
        TZ: 'UTC',
        LANG: 'C',
        LC_ALL: 'C',
        CI: 'true',
        NO_UPDATE_NOTIFIER: '1',
        npm_config_cache: paths.npmCache,
        npm_config_prefix: paths.npmPrefix,
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_globalconfig: paths.npmGlobalConfig,
        npm_config_userconfig: paths.npmUserConfig,
        npm_config_strict_ssl: 'true',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        ...(defaultPlaywrightBrowsersPath()
          ? { PLAYWRIGHT_BROWSERS_PATH: defaultPlaywrightBrowsersPath() }
          : {}),
        WEB_IDE_CANDIDATE_TARBALL: path.join(tmpdir(), 'fixture-web-ide.tgz'),
      })
      expect(paths.npmGlobalConfig).not.toBe(paths.npmUserConfig)
      await expect(readFile(paths.npmGlobalConfig, 'utf8')).resolves.toBe('')
      await expect(readFile(paths.npmUserConfig, 'utf8')).resolves.toBe('')
      const result = await run(npmExecutable, ['config', 'get', 'registry'], {
        cwd: repositoryRoot,
        env: environment,
        timeoutMs: 10_000,
      })
      expect(result.stdout.trim()).toBe('https://registry.npmjs.org/')
      await mkdir(path.join(paths.npmCache, 'nested'))
      await writeFile(path.join(paths.npmCache, 'nested', 'fixture'), 'cache fixture')
    })
    await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the isolated workspace when the gate operation fails', async () => {
    let workspace
    await expect(withValidationGateEnvironment({}, async ({ paths }) => {
      workspace = paths.workspace
      await writeFile(path.join(paths.temporary, 'partial'), 'partial gate output')
      throw new Error('fixture gate failure')
    })).rejects.toThrow(/fixture gate failure/u)
    await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('transactional external evidence', () => {
  it('rolls failed generation back and transactionally commits complete output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-output-transaction-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'candidate')
    await mkdir(target)
    const failed = await beginEmptyDirectoryTransaction(target)
    await writeFile(path.join(failed.stagingDirectory, 'partial.txt'), 'partial')
    await failed.rollback()
    expect(await readdir(target)).toEqual([])

    const complete = await beginEmptyDirectoryTransaction(target)
    await writeFile(path.join(complete.stagingDirectory, 'complete.txt'), 'complete')
    await complete.commit()
    await expect(readFile(path.join(target, 'complete.txt'), 'utf8')).resolves.toBe('complete')
    expect((await readdir(directory)).filter((name) => name.includes('.publication-'))).toHaveLength(1)

    const failedReplacement = await beginDirectoryReplacement(target)
    await writeFile(path.join(failedReplacement.stagingDirectory, 'partial-final.txt'), 'partial')
    await failedReplacement.rollback()
    await expect(readFile(path.join(target, 'complete.txt'), 'utf8')).resolves.toBe('complete')

    const replacement = await beginDirectoryReplacement(target)
    await writeFile(path.join(replacement.stagingDirectory, 'final.txt'), 'final')
    await replacement.commit()
    expect(await readdir(target)).toEqual(['final.txt'])
    expect((await readdir(directory)).filter((name) => name.includes('.publication-'))).toHaveLength(2)
  })

  it('never overwrites a concurrently changed target and retains failed replacement recovery', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-output-race-'))
    temporaryDirectories.push(directory)

    const absentTarget = path.join(directory, 'absent-candidate')
    const absent = await beginEmptyDirectoryTransaction(absentTarget)
    await writeFile(path.join(absent.stagingDirectory, 'candidate.txt'), 'candidate')
    await mkdir(absentTarget)
    await expect(absent.commit()).rejects.toThrow(/concurrently created/u)
    await absent.rollback()
    expect(await readdir(absentTarget)).toEqual([])

    const emptyTarget = path.join(directory, 'empty-candidate')
    const displacedEmptyTarget = path.join(directory, 'displaced-empty-candidate')
    await mkdir(emptyTarget)
    const empty = await beginEmptyDirectoryTransaction(emptyTarget)
    await writeFile(path.join(empty.stagingDirectory, 'candidate.txt'), 'candidate')
    await rename(emptyTarget, displacedEmptyTarget)
    await mkdir(emptyTarget)
    await expect(empty.commit()).rejects.toThrow(/changed while generation/u)
    await empty.rollback()
    expect(await readdir(emptyTarget)).toEqual([])
    expect(await readdir(displacedEmptyTarget)).toEqual([])

    const replacementTarget = path.join(directory, 'replacement-candidate')
    const displacedReplacement = path.join(directory, 'displaced-replacement')
    await mkdir(replacementTarget)
    await writeFile(path.join(replacementTarget, 'original.txt'), 'original')
    const concurrentReplacement = await beginDirectoryReplacement(replacementTarget)
    await writeFile(path.join(concurrentReplacement.stagingDirectory, 'candidate.txt'), 'candidate')
    await rename(replacementTarget, displacedReplacement)
    await mkdir(replacementTarget)
    await writeFile(path.join(replacementTarget, 'competitor.txt'), 'competitor')
    await expect(concurrentReplacement.commit()).rejects.toThrow(/identity changed/u)
    await concurrentReplacement.rollback()
    await expect(readFile(path.join(replacementTarget, 'competitor.txt'), 'utf8')).resolves.toBe('competitor')
    await expect(readFile(path.join(displacedReplacement, 'original.txt'), 'utf8')).resolves.toBe('original')

    const recoverableTarget = path.join(directory, 'recoverable-candidate')
    await mkdir(recoverableTarget)
    await writeFile(path.join(recoverableTarget, 'original.txt'), 'original')
    const recoverable = await beginDirectoryReplacement(recoverableTarget)
    await mkdir(path.join(recoverable.stagingDirectory, 'unexpected-directory'))
    await expect(recoverable.commit()).rejects.toThrow(/recovery path/u)
    expect(recoverable.retainedBackup).toMatch(/\.backup-[^/]+\/original$/u)
    await expect(readFile(path.join(recoverable.retainedBackup, 'original.txt'), 'utf8')).resolves.toBe('original')
    await expect(recoverable.rollback()).rejects.toThrow(/regular non-symlink/u)
  })

  it('creates no completion marker until the reserved target is closed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-marker-race-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'candidate')
    const displaced = path.join(directory, 'displaced-publication')
    const transaction = await beginEmptyDirectoryTransaction(
      target,
      'Race fixture output',
      {
        beforePublish: async ({ targetDirectory }) => {
          expect((await readdir(targetDirectory)).sort()).toEqual([
            '.web-ide-publication-reservation',
            'candidate.txt',
          ])
          expect((await readdir(directory)).filter((name) => name.includes('.publication-'))).toEqual([])
          await rename(targetDirectory, displaced)
          await mkdir(targetDirectory)
          await writeFile(path.join(targetDirectory, 'competitor.txt'), 'competitor')
        },
      },
    )
    await writeFile(path.join(transaction.stagingDirectory, 'candidate.txt'), 'candidate')
    await expect(transaction.commit()).rejects.toThrow(/identity changed/u)
    await transaction.rollback()
    await expect(readFile(path.join(target, 'competitor.txt'), 'utf8')).resolves.toBe('competitor')
    await expect(readFile(path.join(displaced, 'candidate.txt'), 'utf8')).resolves.toBe('candidate')
    expect((await readdir(directory)).filter((name) => name.includes('.publication-'))).toEqual([])
  })

  it('never deletes a concurrently replaced staging directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-staging-race-'))
    temporaryDirectories.push(directory)
    for (const populated of [false, true]) {
      const suffix = populated ? 'populated' : 'empty'
      const target = path.join(directory, `${suffix}-target`)
      const displaced = path.join(directory, `${suffix}-owned-staging`)
      await mkdir(target)
      const transaction = await beginEmptyDirectoryTransaction(target, `${suffix} staging fixture`)
      if (populated) {
        await writeFile(path.join(transaction.stagingDirectory, 'owned.txt'), 'owned bytes')
      }
      await rename(transaction.stagingDirectory, displaced)
      await mkdir(transaction.stagingDirectory)
      if (populated) {
        await writeFile(path.join(transaction.stagingDirectory, 'competitor.txt'), 'competitor bytes')
      }
      await expect(transaction.rollback()).rejects.toThrow(/staging directory identity changed/u)
      expect(await readdir(displaced)).toEqual(populated ? ['owned.txt'] : [])
      expect(await readdir(transaction.stagingDirectory)).toEqual(populated ? ['competitor.txt'] : [])
    }

    const target = path.join(directory, 'commit-target')
    const displaced = path.join(directory, 'commit-owned-staging')
    await mkdir(target)
    const transaction = await beginEmptyDirectoryTransaction(target, 'Commit staging fixture')
    await writeFile(path.join(transaction.stagingDirectory, 'owned.txt'), 'owned bytes')
    await rename(transaction.stagingDirectory, displaced)
    await mkdir(transaction.stagingDirectory)
    await writeFile(path.join(transaction.stagingDirectory, 'competitor.txt'), 'competitor bytes')
    await expect(transaction.commit()).rejects.toThrow(/staging directory identity changed/u)
    await expect(transaction.rollback()).rejects.toThrow(/staging directory identity changed/u)
    await expect(readFile(path.join(displaced, 'owned.txt'), 'utf8')).resolves.toBe('owned bytes')
    await expect(readFile(path.join(transaction.stagingDirectory, 'competitor.txt'), 'utf8'))
      .resolves.toBe('competitor bytes')
  })

  it('rejects source drift in the publication hook without a completion marker', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-source-race-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'candidate')
    await mkdir(target)
    const expectedSource = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }
    const transaction = await beginEmptyDirectoryTransaction(target, 'Source guard fixture', {
      beforePublish: async () => {
        assertCanonicalSnapshotUnchanged(
          expectedSource,
          { ...expectedSource, tree: 'c'.repeat(40) },
          'Fixture source',
        )
      },
    })
    await writeFile(path.join(transaction.stagingDirectory, 'candidate.txt'), 'candidate')
    await expect(transaction.commit()).rejects.toThrow(/partial bytes retained/u)
    await transaction.rollback()
    expect(await readdir(target)).toEqual([])
    expect((await readdir(directory)).filter((name) => name.includes('.publication-'))).toEqual([])
  })

  it('rejects active reservations and content changes before replacing a directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-replacement-content-race-'))
    temporaryDirectories.push(directory)
    const active = path.join(directory, 'active')
    await mkdir(active)
    await writeFile(path.join(active, '.web-ide-publication-reservation'), 'reserved for verified publication\n')
    await expect(beginDirectoryReplacement(active)).rejects.toThrow(/active publication reservation/u)

    const target = path.join(directory, 'candidate')
    await mkdir(target)
    await writeFile(path.join(target, 'original.txt'), 'original')
    const transaction = await beginDirectoryReplacement(target)
    await writeFile(path.join(transaction.stagingDirectory, 'replacement.txt'), 'replacement')
    await writeFile(path.join(target, 'concurrent.txt'), 'concurrent owner')
    await expect(transaction.commit()).rejects.toThrow(/contents changed/u)
    await transaction.rollback()
    await expect(readFile(path.join(target, 'original.txt'), 'utf8')).resolves.toBe('original')
    await expect(readFile(path.join(target, 'concurrent.txt'), 'utf8')).resolves.toBe('concurrent owner')
  })

  it('rejects symlinked external validation inputs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-external-input-'))
    temporaryDirectories.push(directory)
    const source = path.join(directory, 'source.log')
    const link = path.join(directory, 'link.log')
    await writeFile(source, 'pass\n')
    await symlink(source, link)
    await expect(readExternalRegularFile(link, 'Fixture log')).rejects.toThrow(/non-symlink/u)
  })
})

describe('runtime asset evidence', () => {
  it('streams bytes and matches final URL, digest, content type, and selected headers', async () => {
    const lock = runtimeLock()
    const responseBytes = Buffer.from('runtime bytes')
    const report = await verifyRuntimeAssets(lock, async () => ({
      body: (async function* body() { yield responseBytes.subarray(0, 4); yield responseBytes.subarray(4) })(),
      url: lock.assets[0].finalUrl,
      redirected: false,
      status: 200,
      headers: new Headers({
        'content-type': 'application/wasm',
        'access-control-allow-origin': '*',
      }),
    }))
    expect(report.result).toBe('pass')
    expect(report.assets[0]).toMatchObject({ redirectCount: 0, size: responseBytes.length })
  })

  it('fails closed on unknown fields and digest drift', async () => {
    expect(() => validateRuntimeAssetLock({ ...runtimeLock(), extra: true })).toThrow(/unknown field/u)
    await expect(verifyRuntimeAssets(runtimeLock({ sha256: '0'.repeat(64) }), async () => ({
      body: (async function* body() { yield Buffer.from('runtime bytes') })(),
      url: 'https://assets.example.test/runtime.wasm',
      redirected: false,
      status: 200,
      headers: new Headers({ 'content-type': 'application/wasm', 'access-control-allow-origin': '*' }),
    }))).rejects.toThrow(/sha256 mismatch/u)
  })

  it('aborts stalled fetches and bodies that exceed the exact locked size', async () => {
    await expect(verifyRuntimeAssets(runtimeLock(), async (_url, init) => await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }), { timeoutMs: 5 })).rejects.toThrow(/request timeout/u)
    await expect(verifyRuntimeAssets(runtimeLock({ size: 1 }), async () => ({
      body: (async function* body() { yield Buffer.from('too large') })(),
      url: 'https://assets.example.test/runtime.wasm',
      redirected: false,
      status: 200,
      headers: new Headers({ 'content-type': 'application/wasm', 'access-control-allow-origin': '*' }),
    }))).rejects.toThrow(/maximum streamed size/u)
  })
})

describe('SBOM and license gates', () => {
  it('rejects retained CycloneDX schema bytes that drift from their reviewed pin', async () => {
    const schemaPath = path.join(repositoryRoot, 'release/schemas/cyclonedx-1.6.schema.json')
    const bytes = await readFile(schemaPath)
    const sha256 = 'bf8177eee4e8979f2ef15dd131f0ef55eaa2168382b5f888ff8a6d1c7e4d09b3'
    expect(parsePinnedCycloneDxSchema(bytes, sha256, 'fixture schema')).toMatchObject({
      $id: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    })
    const drifted = Buffer.from(bytes)
    drifted[0] ^= 1
    expect(() => parsePinnedCycloneDxSchema(drifted, sha256, 'fixture schema'))
      .toThrow(/SHA-256 mismatch/u)
  })

  it('includes an actually bundled dev-classified module, externals, peers, and runtime files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-sbom-test-'))
    temporaryDirectories.push(directory)
    const provenancePath = path.join(directory, 'provenance.json')
    await writeFile(provenancePath, JSON.stringify({
      schemaVersion: 1,
      package: 'web-ide',
      format: 'vite-rollup-output-modules',
      chunks: [{
        fileName: 'index.js',
        name: 'index',
        isEntry: true,
        isDynamicEntry: false,
        modules: [{
          id: '<repository>/node_modules/bundled/index.js',
          renderedLength: 1,
          package: {
            lockPath: 'node_modules/bundled',
            name: 'bundled',
            version: '1.0.0',
            dev: true,
          },
        }],
      }],
      packages: [{
        lockPath: 'node_modules/bundled',
        name: 'bundled',
        version: '1.0.0',
        dev: true,
        chunks: ['index.js'],
        moduleCount: 1,
      }],
    }))
    const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    const packageLock = { packages: Object.fromEntries([
      ['node_modules/bundled', { version: '1.0.0', integrity, license: 'MIT' }],
      ...['debugger-sh', 'monaco-editor', 'react', 'react-dom'].map((name) => [
        `node_modules/${name}`,
        { version: name === 'debugger-sh' ? '0.3.15' : '1.0.0', integrity, license: 'MIT' },
      ]),
    ]) }
    const packageManifest = {
      name: 'web-ide',
      version: '0.2.0',
      license: 'MIT',
      dependencies: { 'debugger-sh': '0.3.15' },
      peerDependencies: { react: '^1', 'react-dom': '^1' },
    }
    const result = await generateCycloneDx({
      provenancePath,
      runtimeLock: runtimeLock(),
      packageManifest,
      packageLock,
      candidate: {
        filename: 'web-ide-0.2.0.tgz',
        size: 123,
        sha256: 'a'.repeat(64),
        sha512Integrity: integrity,
      },
    })
    expect(result.metadata.component.hashes).toEqual([{ alg: 'SHA-256', content: 'a'.repeat(64) }])
    await expect(validateCycloneDx(result)).resolves.toBe(result)
    const inclusions = result.components.flatMap((component) => (
      component.properties?.filter((property) => property.name.endsWith(':inclusion')).map((property) => property.value) ?? []
    ))
    expect(new Set(inclusions)).toEqual(new Set([
      'bundled-dev-classified',
      'runtime-external',
      'peer-external',
      'runtime-asset',
    ]))
  })

  it('rejects incomplete license policy before producing a report', async () => {
    await expect(generateLicenseEvidence({
      provenancePath: '/does/not/matter',
      runtimeLock: runtimeLock(),
      packageLock: {},
      policy: { schemaVersion: 1, package: 'web-ide', packageOverrides: {} },
    })).rejects.toThrow(/missing required field sourceAttributions/u)
  })
})

describe('validation summary', () => {
  it('accepts only one canonical machine receipt bound to the exact gate run', () => {
    const sourceCommit = 'a'.repeat(40)
    const candidateSha256 = 'b'.repeat(64)
    const receipt = createValidationGateReceipt({
      gateId: 'validate-production',
      sourceCommit,
      candidateSha256,
      exitCode: 0,
      emitter: 'web-ide:scripts/release/run-validation-gate.mjs@3',
    })
    const log = `gate output\n${validationGateReceiptFooter(receipt)}`
    expect(parseValidationGateReceipt(log, {
      gateId: 'validate-production',
      sourceCommit,
      candidateSha256,
    })).toEqual(receipt)
    expect(() => parseValidationGateReceipt(`${log}${validationGateReceiptFooter(receipt)}`, {
      gateId: 'validate-production',
      sourceCommit,
      candidateSha256,
    })).toThrow(/exactly one/u)
    expect(() => parseValidationGateReceipt(log, {
      gateId: 'validate-production',
      sourceCommit: 'c'.repeat(40),
      candidateSha256,
    })).toThrow(/exact pass/u)
  })

  it('makes every synthetic preflight receipt invalid to the production parser', () => {
    const sourceCommit = 'a'.repeat(40)
    const candidateSha256 = 'b'.repeat(64)
    for (const gate of VALIDATION_GATES) {
      const receipt = createPreflightValidationGateReceipt({
        gateId: gate.id,
        sourceCommit,
        candidateSha256,
      })
      const log = `NON-RELEASE synthetic output\n${preflightValidationGateReceiptFooter(receipt)}`
      expect(parsePreflightValidationGateReceipt(log, {
        gateId: gate.id,
        sourceCommit,
        candidateSha256,
      })).toEqual(receipt)
      expect(() => parseValidationGateReceipt(log, {
        gateId: gate.id,
        sourceCommit,
        candidateSha256,
      })).toThrow(/exactly one machine receipt/u)
    }
  })

  it('accepts only the exact complete all-pass gate set in the pinned strict schema', async () => {
    const commit = 'a'.repeat(40)
    const summary = {
      schemaVersion: 1,
      package: 'web-ide@0.2.0',
      sourceCommit: commit,
      candidateSha256: 'b'.repeat(64),
      gates: [
        ['validate-production', 'npm run validate:production'],
        ['consumer-exact-candidate', 'WEB_IDE_CANDIDATE_TARBALL=<candidate> npm run test:consumer'],
        ['audit-production', 'npm audit --omit=dev'],
        ['audit-full', 'npm audit'],
        ['karel-compatibility', 'Karel exact-candidate compatibility gate'],
      ].map(([id, command]) => ({
        id,
        command,
        result: 'pass',
        logs: [{
          path: `/tmp/${id}.log`,
          fileName: `${id}.log`,
          size: 1,
          sha256: 'c'.repeat(64),
        }],
      })),
    }
    expect(validateValidationSummary(summary, commit, 'b'.repeat(64))).toBe(summary)
    await expect(validateReleaseSchema(
      'validation-summary-input.schema.json',
      summary,
      'fixture validation summary',
    )).resolves.toBe(summary)
    const unknownNestedField = structuredClone(summary)
    unknownNestedField.gates[0].logs[0].unexpected = true
    await expect(validateReleaseSchema(
      'validation-summary-input.schema.json',
      unknownNestedField,
      'fixture validation summary',
    )).rejects.toThrow(/additional properties/u)
    const oversizedLog = structuredClone(summary)
    oversizedLog.gates[0].logs[0].size = MAX_VALIDATION_GATE_LOG_BYTES + 1
    expect(() => validateValidationSummary(
      oversizedLog,
      commit,
      'b'.repeat(64),
    )).toThrow(/invalid size/u)
    await expect(validateReleaseSchema(
      'validation-summary-input.schema.json',
      oversizedLog,
      'fixture validation summary',
    )).rejects.toThrow(/must be <= 16777216/u)
    summary.gates[0].result = 'fail'
    expect(() => validateValidationSummary(summary, commit, 'b'.repeat(64))).toThrow(/not an exact pass/u)
  })

  it('compiles the strict artifact-manifest schema and rejects an incomplete document', async () => {
    await expect(validateReleaseSchema(
      'artifact-manifest.schema.json',
      {},
      'fixture artifact manifest',
    )).rejects.toThrow(/required property/u)
  })

  it('does not allow a nonrelease preflight state into finalization', () => {
    const configuration = {
      package: 'web-ide@0.2.0',
      capabilityReleaseId: 'hamilton.python-karel/1',
      packageRole: 'web-ide',
    }
    const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }
    const state = {
      schemaVersion: 1,
      package: configuration.package,
      result: 'nonrelease-preflight',
      source,
      capabilityReleaseId: configuration.capabilityReleaseId,
      packageRole: configuration.packageRole,
      artifacts: [],
    }
    expect(() => validateFinalCandidateState(state, configuration, source)).toThrow(/not a final candidate/u)
    state.result = 'candidate-generated'
    state.preflightFixture = {
      mode: 'disposable-local-remote',
      remote: '/tmp/fixture-origin.git',
      finalizable: false,
    }
    expect(() => validateFinalCandidateState(state, configuration, source)).toThrow(/unknown field preflightFixture/u)
  })
})

describe('artifact manifest', () => {
  it('binds the exact candidate inventory, source/tag, runtime, build inputs, logs, and strict schema', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-manifest-test-'))
    temporaryDirectories.push(directory)
    const candidateBytes = Buffer.from('exact candidate bytes')
    const candidateSha256 = createHash('sha256').update(candidateBytes).digest('hex')
    const sourceBytes = Buffer.from('exact source archive')
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
    const sourceCommit = 'a'.repeat(40)
    const sourceTree = 'b'.repeat(40)
    const logDefinitions = [
      ['validate-production', 'npm run validate:production'],
      ['consumer-exact-candidate', 'WEB_IDE_CANDIDATE_TARBALL=<candidate> npm run test:consumer'],
      ['audit-production', 'npm audit --omit=dev'],
      ['audit-full', 'npm audit'],
      ['karel-compatibility', 'Karel exact-candidate compatibility gate'],
    ]
    const gates = []
    for (const [id, command] of logDefinitions) {
      const fileName = `${id}.log`
      const bytes = Buffer.from(`${id} passed\n`)
      await writeFile(path.join(directory, fileName), bytes)
      gates.push({
        id,
        command,
        result: 'pass',
        logs: [{
          fileName,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }],
      })
    }
    const buildInputs = {
      argv: {
        install: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        build: ['npm', 'run', 'build:library'],
        licenseEvidence: ['node', 'scripts/release/generate-isolated-license-evidence.mjs'],
        pack: ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', '../pack'],
      },
      environment: {
        inherited: [],
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: '<isolated-build>/home',
        TMPDIR: '<isolated-build>/tmp',
        TZ: 'UTC',
        LANG: 'C',
        LC_ALL: 'C',
        CI: 'true',
        NO_UPDATE_NOTIFIER: '1',
        SOURCE_DATE_EPOCH: '1',
        npm_config_cache: '<isolated-build>/npm-cache',
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_globalconfig: '<isolated-build>/global.npmrc',
        npm_config_strict_ssl: 'true',
        npm_config_package_lock: 'true',
        npm_config_offline: 'false',
        npm_config_prefer_offline: 'false',
        npm_config_prefer_online: 'false',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_userconfig: '<isolated-build>/user.npmrc',
        WEB_IDE_RELEASE_PROVENANCE_PATH: '<isolated-build>/bundle-provenance.json',
        WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR: '<isolated-build>/licenses',
      },
      pathNormalization: '<isolated-build> replaces the absolute per-build directory outside the source checkout',
    }
    const jsonEvidence = [
      'bundle-provenance.json',
      'candidate-state.json',
      'web-ide-0.2.0.cdx.json',
      'runtime-assets-verification.json',
      'runtime-source-provenance.json',
      'third-party-licenses.json',
    ]
    await Promise.all(jsonEvidence.map((name) => writeFile(path.join(directory, name), '{}\n')))
    await Promise.all([
      writeFile(path.join(directory, 'web-ide-0.2.0.tgz'), candidateBytes),
      writeFile(path.join(directory, 'web-ide-0.2.0-source.tar.gz'), sourceBytes),
      writeFile(path.join(directory, 'THIRD_PARTY_LICENSES.txt'), 'license evidence\n'),
      writeFile(path.join(directory, 'package-inspection.json'), JSON.stringify({
        tarball: {
          filename: 'web-ide-0.2.0.tgz',
          size: candidateBytes.length,
          sha256: candidateSha256,
          sha512Integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
        },
        files: [{ path: 'package.json', size: 2, mode: 420, sha256: 'c'.repeat(64) }],
      })),
      writeFile(path.join(directory, 'deterministic-builds.json'), JSON.stringify({ buildInputs })),
      writeFile(path.join(directory, 'validation-summary.json'), JSON.stringify({
        schemaVersion: 1,
        package: 'web-ide@0.2.0',
        sourceCommit,
        candidateSha256,
        gateCount: 5,
        logCount: 5,
        gates,
      })),
    ])
    const configuration = {
      package: 'web-ide@0.2.0',
      sourceRepository: 'https://github.com/justinvassantachart/web-ide.git',
      sourceTag: 'web-ide-v0.2.0-source-r2',
      sourceAssetFilename: 'web-ide-0.2.0-source.tar.gz',
      capabilityReleaseId: 'hamilton.python-karel/1',
      packageRole: 'web-ide',
      releaseRepository: 'justinvassantachart/ths-ide',
      releaseTag: 'web-ide-v0.2.0',
      releaseAssetFilename: 'web-ide-0.2.0.tgz',
      nodeVersion: '24.11.1',
      npmVersion: '11.6.2',
    }
    const packageManifest = await readJSON(path.join(repositoryRoot, 'package.json'))
    const manifest = await createArtifactManifest({
      outputDirectory: directory,
      configuration,
      packageManifest,
      source: {
        branch: 'main',
        commit: sourceCommit,
        tree: sourceTree,
        commitTimestamp: 1,
        sourceDateEpoch: '1',
        tag: { name: 'web-ide-v0.2.0-source-r2', objectId: 'd'.repeat(40), objectType: 'tag', peeledCommit: sourceCommit },
        remote: configuration.sourceRepository,
        nodeVersion: configuration.nodeVersion,
        npmVersion: configuration.npmVersion,
      },
    })
    expect(manifest.manifestId).toMatch(/^urn:sha256:[a-f0-9]{64}$/u)
    expect(manifest.distribution.artifact.sha256).toBe(candidateSha256)
    expect(manifest.source.archive.sha256).toBe(sourceSha256)
    expect(manifest.runtime.expectedRedirectCount).toBe(0)
    const unknownNestedField = structuredClone(manifest)
    unknownNestedField.runtime.debuggerSh.registry.unexpected = true
    await expect(validateReleaseSchema(
      'artifact-manifest.schema.json',
      unknownNestedField,
      'fixture artifact manifest',
    )).rejects.toThrow(/additional properties/u)

    const duplicatedGateEvidence = structuredClone(manifest)
    const karelLog = duplicatedGateEvidence.evidence.find(
      (item) => item.kind === 'validation-log:karel-compatibility:0',
    )
    karelLog.kind = 'validation-log:validate-production:1'
    duplicatedGateEvidence.evidence.sort((left, right) => (
      left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
    ))
    await expect(validateReleaseSchema(
      'artifact-manifest.schema.json',
      duplicatedGateEvidence,
      'fixture artifact manifest',
    )).rejects.toThrow(/must contain/u)
    duplicatedGateEvidence.manifestId = `urn:sha256:${createHash('sha256').update(
      canonicalJSONString(Object.fromEntries(
        Object.entries(duplicatedGateEvidence).filter(([key]) => key !== 'manifestId'),
      )),
    ).digest('hex')}`
    expect(() => validateArtifactManifest(duplicatedGateEvidence, configuration))
      .toThrow(/evidence kinds are incomplete/u)
  })
})

describe('release source state', () => {
  it('independently binds GitHub branch, annotated tag object, and peeled commit', async () => {
    const commit = 'a'.repeat(40)
    const tagObjectId = 'b'.repeat(40)
    const sourceRepository = 'https://github.com/justinvassantachart/web-ide.git'
    const responses = new Map([
      ['https://api.github.com/repos/justinvassantachart/web-ide/git/ref/heads/main', {
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: commit },
      }],
      ['https://api.github.com/repos/justinvassantachart/web-ide/git/ref/tags/web-ide-v0.2.0-source-r2', {
        ref: 'refs/tags/web-ide-v0.2.0-source-r2',
        object: { type: 'tag', sha: tagObjectId },
      }],
      [`https://api.github.com/repos/justinvassantachart/web-ide/git/tags/${tagObjectId}`, {
        sha: tagObjectId,
        object: { type: 'commit', sha: commit },
      }],
    ])
    const fetched = []
    const fakeFetch = async (url) => {
      fetched.push(url)
      const value = responses.get(url)
      if (!value) throw new Error(`Unexpected GitHub fixture URL ${url}`)
      const bytes = Buffer.from(JSON.stringify(value))
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        body: {
          async *[Symbol.asyncIterator]() { yield bytes },
        },
      }
    }
    await expect(verifyIndependentGitHubSource(
      { sourceRepository, sourceTag: 'web-ide-v0.2.0-source-r2' },
      { commit, tagObjectId },
      fakeFetch,
    )).resolves.toEqual({ branchCommit: commit, tagObjectId, peeledCommit: commit })
    expect(fetched).toEqual([...responses.keys()])

    responses.get('https://api.github.com/repos/justinvassantachart/web-ide/git/ref/tags/web-ide-v0.2.0-source-r2')
      .object.type = 'commit'
    await expect(verifyIndependentGitHubSource(
      { sourceRepository, sourceTag: 'web-ide-v0.2.0-source-r2' },
      { commit, tagObjectId },
      fakeFetch,
    )).rejects.toThrow(/expected tag ref/u)
  })

  it('requires a clean pushed main and pushed source tag, and makes a deterministic local archive', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'web-ide-source-state-test-'))
    temporaryDirectories.push(directory)
    const bare = path.join(directory, 'remote.git')
    const checkout = path.join(directory, 'checkout')
    await run('git', ['init', '--bare', '--initial-branch=main', bare])
    await run('git', ['clone', bare, checkout])
    await writeFile(path.join(checkout, 'fixture.txt'), 'release fixture\n')
    await run('git', ['add', 'fixture.txt'], { cwd: checkout })
    const gitIdentityEnvironment = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Fixture',
      GIT_AUTHOR_EMAIL: 'release-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-08-24T00:00:00Z',
      GIT_COMMITTER_NAME: 'Release Fixture',
      GIT_COMMITTER_EMAIL: 'release-fixture@example.invalid',
      GIT_COMMITTER_DATE: '2026-08-24T00:00:00Z',
    }
    await run('git', [
      '-c', 'user.name=Release Fixture',
      '-c', 'user.email=release-fixture@example.invalid',
      'commit', '-m', 'fixture',
    ], { cwd: checkout, env: gitIdentityEnvironment })
    await run('git', ['tag', '-a', 'web-ide-v0.2.0-source-r2', '-m', 'Web IDE 0.2.0 fixture'], {
      cwd: checkout,
      env: gitIdentityEnvironment,
    })
    await run('git', ['push', 'origin', 'main', 'refs/tags/web-ide-v0.2.0-source-r2'], { cwd: checkout })
    const configuration = {
      sourceRepository: bare,
      sourceTag: 'web-ide-v0.2.0-source-r2',
      nodeVersion: process.versions.node,
      npmVersion: process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/u)?.[1] ?? '11.6.2',
    }
    const fixtureOptions = { nonreleaseFixtureRemote: bare }
    const source = await verifyReleaseSourceState(configuration, checkout, fixtureOptions)
    expect(source).toMatchObject({ branch: 'main', tag: { name: 'web-ide-v0.2.0-source-r2', objectType: 'tag' } })
    const [first, second] = await Promise.all([
      sourceArchiveBytes(configuration, checkout, fixtureOptions),
      sourceArchiveBytes(configuration, checkout, fixtureOptions),
    ])
    expect(first.bytes.equals(second.bytes)).toBe(true)
    await writeFile(path.join(checkout, 'fixture.txt'), 'replacement content\n')
    await run('git', ['add', 'fixture.txt'], { cwd: checkout })
    await run('git', [
      '-c', 'user.name=Release Fixture',
      '-c', 'user.email=release-fixture@example.invalid',
      'commit', '-m', 'replacement fixture',
    ], { cwd: checkout, env: gitIdentityEnvironment })
    const replacementCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
    await run('git', ['reset', '--hard', source.commit], { cwd: checkout })
    await run('git', ['replace', source.commit, replacementCommit], { cwd: checkout })
    const replaceProtectedSource = await verifyReleaseSourceState(configuration, checkout, fixtureOptions)
    const replaceProtectedArchive = await sourceArchiveBytes(configuration, checkout, fixtureOptions)
    expect(replaceProtectedSource.tree).toBe(source.tree)
    expect(replaceProtectedArchive.bytes.equals(first.bytes)).toBe(true)
    await run('git', ['replace', '-d', source.commit], { cwd: checkout })
    const rewriteKey = 'url.file:///tmp/untrusted-release-origin.git.insteadOf'
    await run('git', ['config', '--local', rewriteKey, bare], { cwd: checkout })
    await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/forbidden Git configuration/u)
    await run('git', ['config', '--local', '--unset-all', rewriteKey], { cwd: checkout })

    const gitDirectory = path.join(checkout, '.git')
    const attributesPath = path.join(gitDirectory, 'info/attributes')
    await writeFile(attributesPath, 'fixture.txt export-ignore\n')
    await expect(sourceArchiveBytes(configuration, checkout, fixtureOptions)).rejects.toThrow(/info\/attributes/u)
    await rm(attributesPath)
    const attributesTarget = path.join(directory, 'attributes-target')
    await writeFile(attributesTarget, '')
    await symlink(attributesTarget, attributesPath)
    await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/non-symlink/u)
    await rm(attributesPath)

    const configPath = path.join(gitDirectory, 'config')
    const worktreeConfigPath = path.join(gitDirectory, 'config.worktree')
    await run('git', ['config', '--file', configPath, 'extensions.worktreeConfig', 'true'])
    await writeFile(worktreeConfigPath, '[url "file:///tmp/rewrite"]\n\tinsteadOf = origin\n')
    await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/config.worktree/u)
    await rm(worktreeConfigPath)
    await run('git', ['config', '--file', configPath, '--unset-all', 'extensions.worktreeConfig'])
    await symlink(attributesTarget, worktreeConfigPath)
    await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/config.worktree/u)
    await rm(worktreeConfigPath)

    for (const controlPath of [
      path.join(gitDirectory, 'info/grafts'),
      path.join(gitDirectory, 'objects/info/alternates'),
    ]) {
      await writeFile(controlPath, `${'0'.repeat(40)}\n`)
      await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/must be absent or empty/u)
      await rm(controlPath)
    }
    await writeFile(path.join(checkout, 'dirty.txt'), 'dirty\n')
    await expect(verifyReleaseSourceState(configuration, checkout, fixtureOptions)).rejects.toThrow(/dirty/u)
  }, 20_000)
})

import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import { inspectPackedPackage } from './package-inspection.mjs'
import { git, run, settleOperations } from './process-utils.mjs'
import { repositoryRoot } from './release-utils.mjs'

export function assertCleanIsolatedCheckoutStatus(status, index, stage = 'operation') {
  if (status !== '') {
    throw new TypeError(
      `Isolated build ${index} mutated its source checkout after ${stage}:\n${status.trimEnd()}`,
    )
  }
}

export function assertExpectedIgnoredCheckoutStatus(status, index, stage, expectedPaths) {
  const actual = status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith('!! ')) {
        throw new TypeError(`Isolated build ${index} returned malformed ignored status after ${stage}`)
      }
      return line.slice(3)
    })
  const expected = [...expectedPaths].sort()
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
    throw new TypeError(
      `Isolated build ${index} has unexpected ignored output after ${stage}: ${actual.join(', ')}`,
    )
  }
}

async function buildOne({ workRoot, index, sourceCommit, configuration }) {
  const buildDirectory = path.join(workRoot, `build-${index}`)
  const cloneDirectory = path.join(buildDirectory, 'source')
  const cacheDirectory = path.join(buildDirectory, 'npm-cache')
  const homeDirectory = path.join(buildDirectory, 'home')
  const temporaryDirectory = path.join(buildDirectory, 'tmp')
  const packDirectory = path.join(buildDirectory, 'pack')
  const licenseDirectory = path.join(buildDirectory, 'licenses')
  const npmGlobalConfig = path.join(buildDirectory, 'global.npmrc')
  const npmUserConfig = path.join(buildDirectory, 'user.npmrc')
  const provenancePath = path.join(buildDirectory, 'bundle-provenance.json')
  await mkdir(buildDirectory, { recursive: true })
  await settleOperations([
    mkdir(packDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true }),
    mkdir(licenseDirectory, { recursive: true }),
    writeFile(npmGlobalConfig, '', { encoding: 'utf8', flag: 'wx' }),
    writeFile(npmUserConfig, '', { encoding: 'utf8', flag: 'wx' }),
  ], `Isolated build ${index} setup`)
  const safePath = `${path.dirname(process.execPath)}:/usr/bin:/bin`
  const gitEnvironment = {
    PATH: safePath,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  }
  await git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', repositoryRoot, cloneDirectory], {
    env: gitEnvironment,
  })
  await git(['checkout', '--quiet', '--detach', sourceCommit], {
    cwd: cloneDirectory,
    env: gitEnvironment,
  })
  const installIgnoredPaths = ['node_modules/']
  const assertCheckoutStillClean = async (stage, expectedIgnoredPaths = []) => {
    const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: cloneDirectory,
      env: gitEnvironment,
    })).stdout
    assertCleanIsolatedCheckoutStatus(status, index, stage)
    const ignored = (await git([
      'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching',
    ], {
      cwd: cloneDirectory,
      env: gitEnvironment,
    })).stdout
      .split('\n')
      .filter((line) => line.startsWith('!! '))
      .join('\n')
    assertExpectedIgnoredCheckoutStatus(ignored, index, stage, expectedIgnoredPaths)
  }
  await assertCheckoutStillClean('checkout')
  const fixedEnvironment = {
    PATH: safePath,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    CI: 'true',
    NO_UPDATE_NOTIFIER: '1',
    SOURCE_DATE_EPOCH: configuration.sourceDateEpoch,
    npm_config_cache: cacheDirectory,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_strict_ssl: 'true',
    npm_config_package_lock: 'true',
    npm_config_offline: 'false',
    npm_config_prefer_offline: 'false',
    npm_config_prefer_online: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_userconfig: npmUserConfig,
  }
  const installArguments = ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
  const buildArguments = ['run', 'build:library']
  const packArguments = ['pack', '--json', '--ignore-scripts', '--pack-destination', '../pack']
  await run('npm', installArguments, {
    cwd: cloneDirectory,
    env: fixedEnvironment,
    inherit: true,
  })
  await assertCheckoutStillClean('install', installIgnoredPaths)
  await run('npm', buildArguments, {
    cwd: cloneDirectory,
    env: { ...fixedEnvironment, WEB_IDE_RELEASE_PROVENANCE_PATH: provenancePath },
    inherit: true,
  })
  const buildIgnoredPaths = [...installIgnoredPaths, 'dist/']
  await assertCheckoutStillClean('build', buildIgnoredPaths)
  await run(process.execPath, ['scripts/release/generate-isolated-license-evidence.mjs'], {
    cwd: cloneDirectory,
    env: {
      ...fixedEnvironment,
      WEB_IDE_RELEASE_PROVENANCE_PATH: provenancePath,
      WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR: licenseDirectory,
    },
  })
  await assertCheckoutStillClean('license generation', buildIgnoredPaths)
  const packProcess = await run('npm', packArguments, { cwd: cloneDirectory, env: fixedEnvironment })
  await assertCheckoutStillClean('pack', buildIgnoredPaths)
  const packResult = JSON.parse(packProcess.stdout)
  const filename = packResult?.[0]?.filename
  if (filename !== configuration.releaseAssetFilename) {
    throw new TypeError(`Isolated build ${index} produced unexpected asset ${JSON.stringify(filename)}`)
  }
  const tarballBytes = await readFile(path.join(packDirectory, filename))
  const inspection = inspectPackedPackage(packResult, tarballBytes)
  const provenanceBytes = await readFile(provenancePath)
  const licenseReportBytes = await readFile(path.join(licenseDirectory, 'third-party-licenses.json'))
  const licenseTextBytes = await readFile(path.join(licenseDirectory, 'THIRD_PARTY_LICENSES.txt'))
  return {
    tarballBytes,
    provenanceBytes,
    inspection,
    licenseReportBytes,
    licenseTextBytes,
    buildInputs: {
      argv: {
        install: ['npm', ...installArguments],
        build: ['npm', ...buildArguments],
        licenseEvidence: ['node', 'scripts/release/generate-isolated-license-evidence.mjs'],
        pack: ['npm', ...packArguments],
      },
      environment: {
        inherited: [],
        PATH: safePath,
        HOME: '<isolated-build>/home',
        TMPDIR: '<isolated-build>/tmp',
        TZ: fixedEnvironment.TZ,
        LANG: fixedEnvironment.LANG,
        LC_ALL: fixedEnvironment.LC_ALL,
        CI: fixedEnvironment.CI,
        NO_UPDATE_NOTIFIER: fixedEnvironment.NO_UPDATE_NOTIFIER,
        SOURCE_DATE_EPOCH: fixedEnvironment.SOURCE_DATE_EPOCH,
        npm_config_cache: '<isolated-build>/npm-cache',
        npm_config_registry: fixedEnvironment.npm_config_registry,
        npm_config_globalconfig: '<isolated-build>/global.npmrc',
        npm_config_strict_ssl: fixedEnvironment.npm_config_strict_ssl,
        npm_config_package_lock: fixedEnvironment.npm_config_package_lock,
        npm_config_offline: fixedEnvironment.npm_config_offline,
        npm_config_prefer_offline: fixedEnvironment.npm_config_prefer_offline,
        npm_config_prefer_online: fixedEnvironment.npm_config_prefer_online,
        npm_config_ignore_scripts: fixedEnvironment.npm_config_ignore_scripts,
        npm_config_audit: fixedEnvironment.npm_config_audit,
        npm_config_fund: fixedEnvironment.npm_config_fund,
        npm_config_userconfig: '<isolated-build>/user.npmrc',
        WEB_IDE_RELEASE_PROVENANCE_PATH: '<isolated-build>/bundle-provenance.json',
        WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR: '<isolated-build>/licenses',
      },
      pathNormalization: '<isolated-build> replaces the absolute per-build directory outside the source checkout',
    },
  }
}

export async function settleIsolatedBuilds(builds) {
  return await settleOperations(builds, 'One or more isolated release builds')
}

export async function buildDeterministicCandidates({ outputDirectory, sourceCommit, configuration }) {
  const workRoot = path.join(outputDirectory, '.isolated-builds')
  await mkdir(workRoot, { recursive: false })
  try {
    const [first, second] = await settleIsolatedBuilds([
      buildOne({ workRoot, index: 1, sourceCommit, configuration }),
      buildOne({ workRoot, index: 2, sourceCommit, configuration }),
    ])
    if (!first.tarballBytes.equals(second.tarballBytes)) {
      throw new TypeError('Two clean isolated builds produced different package tarballs')
    }
    if (!first.provenanceBytes.equals(second.provenanceBytes)) {
      throw new TypeError('Two clean isolated builds produced different bundle provenance')
    }
    if (canonicalJSONString(first.inspection) !== canonicalJSONString(second.inspection)) {
      throw new TypeError('Two clean isolated builds produced different package inventories')
    }
    if (!first.licenseReportBytes.equals(second.licenseReportBytes) || !first.licenseTextBytes.equals(second.licenseTextBytes)) {
      throw new TypeError('Two clean isolated builds produced different license evidence')
    }
    if (canonicalJSONString(first.buildInputs) !== canonicalJSONString(second.buildInputs)) {
      throw new TypeError('Two clean isolated builds did not use identical normalized inputs')
    }
    const candidatePath = path.join(outputDirectory, configuration.releaseAssetFilename)
    await copyFile(
      path.join(workRoot, 'build-1', 'pack', configuration.releaseAssetFilename),
      candidatePath,
      fsConstants.COPYFILE_EXCL,
    )
    return {
      candidatePath,
      tarballBytes: first.tarballBytes,
      provenanceBytes: first.provenanceBytes,
      provenance: JSON.parse(first.provenanceBytes.toString('utf8')),
      inspection: first.inspection,
      licenseReportBytes: first.licenseReportBytes,
      licenseTextBytes: first.licenseTextBytes,
      buildInputs: first.buildInputs,
      determinism: {
        schemaVersion: 1,
        package: configuration.package,
        result: 'pass',
        isolatedBuildCount: 2,
        packageTarballsByteIdentical: true,
        bundleProvenanceByteIdentical: true,
        packageInventoriesCanonicalByteIdentical: true,
        licenseEvidenceByteIdentical: true,
      },
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

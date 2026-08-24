import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { settleOperations } from './process-utils.mjs'

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

async function pathState(target) {
  try {
    return await lstat(target, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertPlainDirectory(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must remain a plain directory`)
  }
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Validation gate environment options must be an object')
  }
  const allowed = new Set(['candidateTarball', 'playwrightBrowsersPath'])
  const unknown = Object.keys(options).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`Validation gate environment has unknown options: ${unknown.join(', ')}`)
  }
  if (
    options.candidateTarball !== undefined
    && (
      typeof options.candidateTarball !== 'string'
      || !path.isAbsolute(options.candidateTarball)
      || options.candidateTarball.includes('\0')
    )
  ) throw new TypeError('Validation gate candidate tarball must be an absolute path')
  if (
    options.playwrightBrowsersPath !== undefined
    && (
      typeof options.playwrightBrowsersPath !== 'string'
      || options.playwrightBrowsersPath.length === 0
      || options.playwrightBrowsersPath.includes('\0')
      || (options.playwrightBrowsersPath !== '0' && !path.isAbsolute(options.playwrightBrowsersPath))
    )
  ) throw new TypeError('Validation gate Playwright browser path must be absolute or 0')
}

async function cleanupWorkspace(workspace, expectedIdentity) {
  const parent = path.dirname(workspace)
  const quarantineRoot = await mkdtemp(path.join(parent, '.web-ide-validation-gate-cleanup-'))
  const quarantineIdentity = await pathState(quarantineRoot)
  assertPlainDirectory(quarantineIdentity, 'Validation gate cleanup quarantine')
  const quarantinedWorkspace = path.join(quarantineRoot, 'workspace')
  try {
    const currentIdentity = await pathState(workspace)
    if (!sameIdentity(currentIdentity, expectedIdentity)) {
      throw new TypeError('Validation gate workspace identity changed before cleanup')
    }
    assertPlainDirectory(currentIdentity, 'Validation gate workspace')
    await rename(workspace, quarantinedWorkspace)
    const movedIdentity = await pathState(quarantinedWorkspace)
    if (!sameIdentity(movedIdentity, expectedIdentity)) {
      throw new TypeError('Validation gate workspace identity changed during cleanup quarantine')
    }
    assertPlainDirectory(movedIdentity, 'Quarantined validation gate workspace')
    await rm(quarantinedWorkspace, { recursive: true })
    const finalQuarantineIdentity = await pathState(quarantineRoot)
    if (!sameIdentity(finalQuarantineIdentity, quarantineIdentity)) {
      throw new TypeError('Validation gate cleanup quarantine identity changed')
    }
    if ((await readdir(quarantineRoot)).length !== 0) {
      throw new TypeError('Validation gate cleanup quarantine gained an unexpected entry')
    }
    await rmdir(quarantineRoot)
  } catch (error) {
    throw new Error(
      `Validation gate workspace cleanup failed; inspect ${quarantineRoot}`,
      { cause: error },
    )
  }
}

export function defaultPlaywrightBrowsersPath(environment = process.env, platform = process.platform) {
  if (environment.PLAYWRIGHT_BROWSERS_PATH) return environment.PLAYWRIGHT_BROWSERS_PATH
  if (platform === 'win32') {
    return environment.LOCALAPPDATA
      ? path.join(environment.LOCALAPPDATA, 'ms-playwright')
      : undefined
  }
  if (!environment.HOME) return undefined
  return platform === 'darwin'
    ? path.join(environment.HOME, 'Library', 'Caches', 'ms-playwright')
    : path.join(environment.HOME, '.cache', 'ms-playwright')
}

export async function withValidationGateEnvironment(options, operation) {
  validateOptions(options)
  if (typeof operation !== 'function') {
    throw new TypeError('Validation gate environment operation must be a function')
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'web-ide-validation-gate-'))
  const workspaceIdentity = await pathState(workspace)
  assertPlainDirectory(workspaceIdentity, 'Validation gate workspace')
  const paths = {
    workspace,
    home: path.join(workspace, 'home'),
    temporary: path.join(workspace, 'tmp'),
    npmCache: path.join(workspace, 'npm-cache'),
    npmPrefix: path.join(workspace, 'npm-prefix'),
    xdgConfig: path.join(workspace, 'xdg-config'),
    xdgCache: path.join(workspace, 'xdg-cache'),
    npmGlobalConfig: path.join(workspace, 'global.npmrc'),
    npmUserConfig: path.join(workspace, 'user.npmrc'),
  }
  let operationResult
  let operationError
  try {
    await settleOperations([
      mkdir(paths.home),
      mkdir(paths.temporary),
      mkdir(paths.npmCache),
      mkdir(paths.npmPrefix),
      mkdir(paths.xdgConfig),
      mkdir(paths.xdgCache),
      writeFile(paths.npmGlobalConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
      writeFile(paths.npmUserConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    ], 'Validation gate environment setup')
    const environment = {
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
      ...(options.playwrightBrowsersPath
        ? { PLAYWRIGHT_BROWSERS_PATH: options.playwrightBrowsersPath }
        : {}),
      ...(options.candidateTarball
        ? { WEB_IDE_CANDIDATE_TARBALL: options.candidateTarball }
        : {}),
    }
    operationResult = await operation({ environment, paths: Object.freeze({ ...paths }) })
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    await cleanupWorkspace(workspace, workspaceIdentity)
  } catch (error) {
    cleanupError = error
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Validation gate operation and isolated-environment cleanup both failed',
    )
  }
  if (operationError) throw operationError
  if (cleanupError) throw cleanupError
  return operationResult
}

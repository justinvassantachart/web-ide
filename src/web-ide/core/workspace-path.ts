import type { WorkspaceFiles } from '../contracts/host'
import { isWellFormedUnicode } from '../public/canonical-contract'

/**
 * Converts a host/plugin file key into the one canonical VFS namespace.
 * Workspace seeds are data, so reject traversal instead of relying on a
 * filesystem implementation to normalize it for us.
 */
export function canonicalWorkspaceFilePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Workspace file paths must be non-empty strings')
  }
  if (path.includes('\0')) {
    throw new TypeError(`Workspace file path contains a NUL byte: ${JSON.stringify(path)}`)
  }
  if (path.includes('\\') || !isWellFormedUnicode(path)) {
    throw new TypeError(`Workspace file path is not canonical: ${JSON.stringify(path)}`)
  }

  const normalized = path.normalize('NFC')
  if (normalized === '/workspace') {
    throw new TypeError(`Workspace file path is not canonical: ${JSON.stringify(path)}`)
  }

  const relative = normalized.startsWith('/workspace/')
    ? normalized.slice('/workspace/'.length)
    : normalized.replace(/^\/+/, '')
  const segments = relative.split('/')

  if (
    relative.length === 0
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Workspace file path is not canonical: ${JSON.stringify(path)}`)
  }

  return `/workspace/${segments.join('/')}`
}

/**
 * Converts an execution-only resource key into the runtime's protected
 * `/sysroot` namespace. Accepting the existing `/workspace/` resource spelling
 * lets a contribution opt into the new scope without renaming every file key.
 */
export function canonicalExecutionFilePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Execution file paths must be non-empty strings')
  }
  if (path.includes('\0')) {
    throw new TypeError(`Execution file path contains a NUL byte: ${JSON.stringify(path)}`)
  }
  if (path.includes('\\') || !isWellFormedUnicode(path)) {
    throw new TypeError(`Execution file path is not canonical: ${JSON.stringify(path)}`)
  }

  const normalized = path.normalize('NFC')
  if (normalized === '/workspace' || normalized === '/sysroot') {
    throw new TypeError(`Execution file path is not canonical: ${JSON.stringify(path)}`)
  }

  let relative = normalized.replace(/^\/+/, '')
  if (normalized.startsWith('/workspace/')) {
    relative = normalized.slice('/workspace/'.length)
  } else if (normalized.startsWith('/sysroot/')) {
    relative = normalized.slice('/sysroot/'.length)
  }
  const segments = relative.split('/')

  if (
    relative.length === 0
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Execution file path is not canonical: ${JSON.stringify(path)}`)
  }

  return `/sysroot/${segments.join('/')}`
}

/** Matches the flat path namespace used by the browser runtime engine. */
export function runtimeRelativeFilePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Runtime file paths must be non-empty strings')
  }
  if (path.includes('\\') || !isWellFormedUnicode(path)) {
    throw new TypeError(`Runtime file path is not canonical: ${JSON.stringify(path)}`)
  }

  const normalized = path.normalize('NFC')
  if (normalized === '/workspace' || normalized === '/sysroot') {
    throw new TypeError(`Runtime file path is not canonical: ${JSON.stringify(path)}`)
  }

  let relative = normalized
  if (normalized.startsWith('/workspace/')) {
    relative = normalized.slice('/workspace/'.length)
  } else if (normalized.startsWith('/sysroot/')) {
    relative = normalized.slice('/sysroot/'.length)
  } else if (normalized.startsWith('/')) {
    relative = normalized.slice(1)
  }
  const segments = relative.split('/')

  if (
    relative.length === 0
    || normalized.includes('\0')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Runtime file path is not canonical: ${JSON.stringify(path)}`)
  }

  return segments.join('/')
}

/**
 * Fails before two differently scoped files can overwrite one another after
 * the runtime strips `/workspace` and `/sysroot` from engine-facing paths.
 */
export function assertNoFlattenedRuntimePathCollisions(
  files: Readonly<Record<string, string>>,
): void {
  const sourceByRuntimePath = new Map<string, string>()
  const paths = Object.keys(files).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ))

  for (const path of paths) {
    const runtimePath = runtimeRelativeFilePath(path)
    const existing = sourceByRuntimePath.get(runtimePath)
    if (existing !== undefined && existing !== path) {
      throw new TypeError(
        `Runtime file paths ${JSON.stringify(existing)} and ${JSON.stringify(path)} both flatten to ${JSON.stringify(runtimePath)}`,
      )
    }
    sourceByRuntimePath.set(runtimePath, path)
  }
}

/** Returns a fresh, prototype-safe map with canonical workspace paths. */
export function normalizeWorkspaceFiles(files: WorkspaceFiles): WorkspaceFiles {
  const normalized = Object.create(null) as WorkspaceFiles
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      throw new TypeError(`Workspace file content must be a string: ${JSON.stringify(path)}`)
    }
    normalized[canonicalWorkspaceFilePath(path)] = content
  }
  return normalized
}

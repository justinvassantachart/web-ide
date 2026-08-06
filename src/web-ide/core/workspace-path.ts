import type { WorkspaceFiles } from '../contracts/host'

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
  if (path === '/workspace') {
    throw new TypeError(`Workspace file path is not canonical: ${JSON.stringify(path)}`)
  }

  const relative = path.startsWith('/workspace/')
    ? path.slice('/workspace/'.length)
    : path.replace(/^\/+/, '')
  const segments = relative.split('/')

  if (
    relative.length === 0
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Workspace file path is not canonical: ${JSON.stringify(path)}`)
  }

  return `/workspace/${segments.join('/')}`
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

import type { IDEWorkspaceResourceContribution } from '../contracts/contributions'
import type { WorkspaceFiles } from '../contracts/host'
import { canonicalWorkspaceFilePath } from './workspace-path'

/**
 * Builds one runtime/VFS seed from ordered plugin resources and host files.
 * Later contributions replace earlier ones; host-owned files always win.
 */
export function mergeWorkspaceFiles(
  contributions: readonly IDEWorkspaceResourceContribution[],
  hostFiles?: WorkspaceFiles,
): WorkspaceFiles | undefined {
  if (contributions.length === 0 && hostFiles === undefined) return undefined

  const merged = Object.create(null) as WorkspaceFiles
  const merge = (files: WorkspaceFiles | undefined) => {
    for (const [path, content] of Object.entries(files ?? {})) {
      if (typeof content !== 'string') {
        throw new TypeError(`Workspace file content must be a string: ${JSON.stringify(path)}`)
      }
      merged[canonicalWorkspaceFilePath(path)] = content
    }
  }

  for (const { files } of contributions) merge(files)
  merge(hostFiles)
  return merged
}

/** Exact, order-independent dependency key for a complete workspace seed. */
export function workspaceFilesFingerprint(files?: WorkspaceFiles): string {
  if (files === undefined) return ''
  return JSON.stringify(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  )
}

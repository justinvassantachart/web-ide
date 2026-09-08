import type { IDEWorkspaceFeed } from '@/web-ide/contracts/workspace'
import type { Disposable } from '@/web-ide/core/disposable'
import { isCppPath } from './config'

export interface ClangdWorkspaceFileClient {
  writeFiles(files: Record<string, string>): void
  deleteFile(path: string): void
}

/** Diff-based synchronization driven exclusively by one public workspace feed. */
export function attachClangdWorkspaceSync(options: {
  workspace: IDEWorkspaceFeed
  client: ClangdWorkspaceFileClient
  readFiles(): Record<string, string>
  debounceMs?: number
  onReadError?(error: unknown): void
}): Disposable {
  const debounceMs = options.debounceMs ?? 500
  let previous = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let workspaceOwnedPaths = new Set<string>()

  const flush = () => {
    if (disposed) return
    timer = undefined
    let readError: unknown
    let next: Map<string, string>
    try {
      next = new Map(Object.entries(options.readFiles()))
    } catch (error) {
      // A provider is optional input. Preserve the last known-good support
      // plane while still reconciling every canonical workspace C/C++ path,
      // so a committed transaction can never leave provider text shadowing
      // the new workspace revision.
      readError = error
      next = new Map(previous)
    }

    const workspaceFiles = options.workspace.snapshot()
    const nextWorkspaceOwnedPaths = new Set<string>()
    for (const [path, content] of Object.entries(workspaceFiles)) {
      if (!isCppPath(path)) continue
      nextWorkspaceOwnedPaths.add(path)
      next.set(path, content)
    }
    if (readError !== undefined) {
      for (const path of workspaceOwnedPaths) {
        if (!nextWorkspaceOwnedPaths.has(path)) next.delete(path)
      }
    }

    for (const path of previous.keys()) {
      if (!next.has(path)) options.client.deleteFile(path)
    }
    const changed: Record<string, string> = {}
    for (const [path, content] of next) {
      if (previous.get(path) !== content) changed[path] = content
    }
    if (Object.keys(changed).length > 0) options.client.writeFiles(changed)
    previous = next
    workspaceOwnedPaths = nextWorkspaceOwnedPaths
    if (readError !== undefined) {
      try {
        if (options.onReadError) options.onReadError(readError)
        else console.warn('[clangd] workspace support refresh failed', readError)
      } catch {
        // Error reporting is observational and cannot interrupt feed sync.
      }
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }
  const unsubscribe = options.workspace.subscribe((change) => {
    if (change.origin.kind === 'local-user') {
      schedule()
      return
    }
    // Restore/provider/external transactions are already atomic snapshots and
    // must invalidate clangd before another UI action can observe stale files.
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    flush()
  })
  schedule()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      unsubscribe()
      previous.clear()
      workspaceOwnedPaths.clear()
    },
  }
}

import type { IDEWorkspaceFeed } from '@/web-ide/contracts/workspace'
import type { Disposable } from '@/web-ide/core/disposable'

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
}): Disposable {
  const debounceMs = options.debounceMs ?? 500
  let previous = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const flush = () => {
    if (disposed) return
    timer = undefined
    const next = new Map(Object.entries(options.readFiles()))
    for (const path of previous.keys()) {
      if (!next.has(path)) options.client.deleteFile(path)
    }
    const changed: Record<string, string> = {}
    for (const [path, content] of next) {
      if (previous.get(path) !== content) changed[path] = content
    }
    if (Object.keys(changed).length > 0) options.client.writeFiles(changed)
    previous = next
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
    },
  }
}

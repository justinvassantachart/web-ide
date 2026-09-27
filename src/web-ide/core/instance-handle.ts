import type { WorkspaceFiles } from '../contracts/host'
import type {
  IDEInstanceSnapshot,
  WebIDEInstanceHandle,
} from '../contracts/instance'
import {
  createPanelLayoutController,
  type PanelLayoutController,
} from './panel-layout'
import type { WorkbenchInstance } from '../react/workbench-instance-context'
import { normalizePublicWorkspacePath } from './workspace-controller'

function snapshot(
  panelLayout: PanelLayoutController,
  instance: WorkbenchInstance,
): IDEInstanceSnapshot {
  const editor = instance.editorStore.getState()
  const debug = instance.debugStore.getState()
  const tests = instance.testStore.getState()
  const breakpoints = Object.fromEntries(
    Object.entries(debug.breakpoints).map(([path, lines]) => [
      path,
      Object.freeze([...lines]),
    ]),
  )

  return {
    workspace: Object.freeze({ ...instance.workspace.snapshot() }),
    editor: {
      activeFile: editor.activeFile,
      openFiles: Object.freeze([...editor.openFiles]),
    },
    debug: {
      debugMode: debug.debugMode,
      currentLine: debug.currentLine,
      currentFile: debug.currentFile,
      currentFunc: debug.currentFunc,
      breakpoints: Object.freeze(breakpoints),
      callStack: Object.freeze([...debug.callStack]),
      memorySnapshot: debug.memorySnapshot,
    },
    rightPanel: panelLayout.getSnapshot() ?? '',
    tests: Object.freeze(
      tests.tests.map(({ name, status }) => Object.freeze({
        name,
        status: status === 'error' || status === 'skip' ? 'fail' : status,
      })),
    ),
  }
}

export interface WorkspaceInstanceLifecycle {
  flush(files: WorkspaceFiles): Promise<void>
  close(files: WorkspaceFiles): Promise<void>
}

export interface WebIDEInstanceController {
  readonly handle: WebIDEInstanceHandle
  /** Returns a token-scoped detach function so a stale mount cannot detach a replacement. */
  attachWorkspaceLifecycle(lifecycle: WorkspaceInstanceLifecycle): () => void
}

/** Creates the stable public ref object for one Web IDE mount. */
export function createWebIDEInstanceController(
  instance: WorkbenchInstance,
  panelLayout: PanelLayoutController = createPanelLayoutController(),
): WebIDEInstanceController {
  let workspaceLifecycle: WorkspaceInstanceLifecycle | undefined
  let lifecycleToken: object | undefined

  const persistedFiles = (): WorkspaceFiles => {
    return Object.freeze({ ...instance.workspace.persistedFiles() })
  }

  const editorStore = instance.editorStore
  const debugStore = instance.debugStore
  const executionStore = instance.executionStore
  const testStore = instance.testStore

  const handle: WebIDEInstanceHandle = {
    workspace: {
      snapshot: () => Object.freeze({ ...instance.workspace.snapshot() }),
      revision: () => instance.workspace.revision,
      subscribe: (listener) => instance.workspace.subscribe(listener),
      apply: (transaction) => instance.workspace.applyExternal(transaction),
    },
    persistence: {
      snapshot: () => instance.workspace.getPersistenceStatus(),
      subscribe: (listener) => instance.workspace.subscribePersistenceStatus(listener),
    },
    snapshot: () => snapshot(panelLayout, instance),
    subscribe(listener) {
      const unsubscribers = [
        editorStore.subscribe(listener),
        debugStore.subscribe(listener),
        executionStore.subscribe(listener),
        testStore.subscribe(listener),
        panelLayout.subscribe(listener),
        instance.workspace.subscribe(listener),
      ]
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
    },
    persistedFiles,
    flushWorkspace() {
      return workspaceLifecycle?.flush(persistedFiles()) ?? Promise.resolve()
    },
    close() {
      return workspaceLifecycle?.close(persistedFiles()) ?? Promise.resolve()
    },
    ensureFilesOpen(paths, primaryPath) {
      let canonicalPaths: string[]
      let canonicalPrimary: string | undefined
      try {
        canonicalPaths = [...new Set(paths.map(normalizePublicWorkspacePath))]
      } catch {
        return false
      }
      try {
        canonicalPrimary = primaryPath === undefined
          ? undefined
          : normalizePublicWorkspacePath(primaryPath)
      } catch {
        // Preserve the original optional-primary behavior: an invalid primary
        // that is not one of the requested files is ignored, never stored.
        canonicalPrimary = undefined
      }
      const exists = (path: string) => instance.workspace.fileExists(path)
      const read = (path: string) => instance.workspace.readFile(path)
      if (!canonicalPaths.every(exists)) return false
      const primary = canonicalPrimary && canonicalPaths.includes(canonicalPrimary)
        ? canonicalPrimary
        : undefined
      const ordered = [
        ...canonicalPaths.filter((path) => path !== primary).sort(),
        ...(primary ? [primary] : []),
      ]
      for (const path of ordered) {
        const editor = editorStore.getState()
        if (
          path === primary &&
          (!editor.openFiles.includes(path) || editor.activeFile === null)
        ) {
          editor.setActiveFile(path, read(path))
        }
        else editor.openFile(path)
      }
      const editor = editorStore.getState()
      const first = ordered[0]
      if (!editor.activeFile && first) editor.setActiveFile(first, read(first))
      return true
    },
    reset(options) {
      const breakpointFiles = new Set(Array.from(
        options?.breakpointFiles ?? [],
        normalizePublicWorkspacePath,
      ))
      if (breakpointFiles.size > 0) {
        debugStore.setState((state) => {
          const breakpoints: Record<string, number[]> = {}
          const cleared = new Set<string>()
          for (const [path, lines] of Object.entries(state.breakpoints)) {
            let canonical: string
            try {
              canonical = normalizePublicWorkspacePath(path)
            } catch {
              breakpoints[path] = lines
              continue
            }
            if (breakpointFiles.has(canonical)) cleared.add(canonical)
            else breakpoints[path] = lines
          }
          for (const canonical of cleared) breakpoints[canonical] = []
          return { breakpoints }
        })
      }
      debugStore.getState().reset()
      testStore.getState().reset()
      void instance.testingV2.snapshot()?.clearResults().catch(error => console.error('[web-ide] Could not clear test results', error))
    },
  }

  return {
    handle,
    attachWorkspaceLifecycle(lifecycle) {
      const token = {}
      workspaceLifecycle = lifecycle
      lifecycleToken = token
      return () => {
        if (lifecycleToken !== token) return
        workspaceLifecycle = undefined
        lifecycleToken = undefined
      }
    },
  }
}

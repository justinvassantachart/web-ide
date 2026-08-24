import { useDebugStore } from '@/store/debug-store'
import { useEditorStore } from '@/store/editor-store'
import { useExecutionStore } from '@/store/execution-store'
import { useTestStore } from '@/testing/test-store'
import {
  fileExists,
  getAllFiles,
  readFile,
  subscribeWorkspaceChange,
} from '@/vfs/volume'
import type { WorkspaceFiles } from '../contracts/host'
import type {
  IDEInstanceSnapshot,
  WebIDEInstanceHandle,
} from '../contracts/instance'
import { projectPersistedWorkspaceFiles } from './workspace-resources'

function snapshot(): IDEInstanceSnapshot {
  const editor = useEditorStore.getState()
  const debug = useDebugStore.getState()
  const execution = useExecutionStore.getState()
  const tests = useTestStore.getState()
  const breakpoints = Object.fromEntries(
    Object.entries(debug.breakpoints).map(([path, lines]) => [
      path,
      Object.freeze([...lines]),
    ]),
  )

  return {
    workspace: Object.freeze({ ...getAllFiles() }),
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
    rightPanel: execution.rightTab,
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
export function createWebIDEInstanceController(): WebIDEInstanceController {
  let workspaceLifecycle: WorkspaceInstanceLifecycle | undefined
  let lifecycleToken: object | undefined

  const persistedFiles = (): WorkspaceFiles => {
    const projected = projectPersistedWorkspaceFiles(getAllFiles())
    return Object.freeze({ ...projected })
  }

  const handle: WebIDEInstanceHandle = {
    snapshot,
    subscribe(listener) {
      const unsubscribers = [
        useEditorStore.subscribe(listener),
        useDebugStore.subscribe(listener),
        useExecutionStore.subscribe(listener),
        useTestStore.subscribe(listener),
        subscribeWorkspaceChange(listener),
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
      if (!paths.every(fileExists)) return false
      const primary = primaryPath && paths.includes(primaryPath) ? primaryPath : undefined
      const ordered = [
        ...paths.filter((path) => path !== primary).sort(),
        ...(primary ? [primary] : []),
      ]
      for (const path of ordered) {
        const editor = useEditorStore.getState()
        if (
          path === primary &&
          (!editor.openFiles.includes(path) || editor.activeFile === null)
        ) {
          editor.setActiveFile(path, readFile(path))
        }
        else editor.openFile(path)
      }
      const editor = useEditorStore.getState()
      const first = ordered[0]
      if (!editor.activeFile && first) editor.setActiveFile(first, readFile(first))
      return true
    },
    reset(options) {
      for (const path of options?.breakpointFiles ?? []) {
        useDebugStore.getState().setFileBreakpoints(path, [])
      }
      useDebugStore.getState().reset()
      useTestStore.getState().reset()
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

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
import type { RuntimeWarmupResult } from '../contracts/runtime'

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
  acquireRuntimeActivity(foreground: boolean): (() => void) | undefined
  beginRuntime(identity: object, dispose: () => Promise<void>): void
  retireRuntime(identity: object, dispose: () => Promise<void>): Promise<void>
  attachRuntimeWarmup(lifecycle: {
    identity?: object
    ready?(): void
    shutdown?(): Promise<void>
    suspend?(): Promise<void>
    resume?(): Promise<void>
    release?(options?: { signal?: AbortSignal }): Promise<'released' | 'cancelled'>
    warmup(): Promise<RuntimeWarmupResult>
    cancel(): Promise<void>
    compilationStatistics?(): unknown
  }): () => void
}

/** Creates the stable public ref object for one Web IDE mount. */
export function createWebIDEInstanceController(
  instance: WorkbenchInstance,
  panelLayout: PanelLayoutController = createPanelLayoutController(),
): WebIDEInstanceController {
  let workspaceLifecycle: WorkspaceInstanceLifecycle | undefined
  let lifecycleToken: object | undefined
  let runtimeWarmup: Parameters<WebIDEInstanceController['attachRuntimeWarmup']>[0] | undefined
  let runtimeIdentity: object | undefined
  let runtimeDisposer: (() => Promise<void>) | undefined
  let shutdown: Promise<void> | undefined
  let suspension: Promise<void> | undefined
  let suspended = false
  let predecessor: { ready: boolean; drain: Promise<void> } | undefined
  const activities = new Set<object>()
  const activityWaiters = new Set<() => void>()
  const releases = new Set<AbortController>()
  const abortReleases = () => { for (const request of releases) request.abort() }
  const acquireRuntimeActivity = (foreground: boolean): (() => void) | undefined => {
    if (shutdown || suspended || (predecessor && !predecessor.ready)) return undefined
    if (foreground) abortReleases()
    const token = {}
    activities.add(token)
    return () => {
      activities.delete(token)
      if (activities.size === 0) {
        for (const resolve of activityWaiters) resolve()
        activityWaiters.clear()
      }
    }
  }
  const drainActivities = (signal?: AbortSignal): Promise<void> => {
    if (!activities.size || signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        activityWaiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      activityWaiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  const beginRuntime = (identity: object, dispose?: () => Promise<void>): void => {
    if (runtimeIdentity === identity) {
      if (dispose) runtimeDisposer = dispose
      return
    }
    if (runtimeIdentity !== undefined) {
      if (shutdown) {
        const prior = { ready: false, drain: shutdown }
        predecessor = prior
        void prior.drain.then(() => { prior.ready = true }, () => {})
      }
      shutdown = undefined
      suspension = undefined
      suspended = false
    }
    runtimeIdentity = identity
    runtimeDisposer = dispose
  }

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
    async close() {
      await runtimeWarmup?.cancel()
      await workspaceLifecycle?.close(persistedFiles())
    },
    shutdownRuntime() {
      if (shutdown) return shutdown
      abortReleases()
      const lifecycle = runtimeWarmup
      // Fence the coordinator/session synchronously, before waiting for transform cleanup.
      let drain: Promise<void>
      try { drain = lifecycle?.shutdown?.() ?? runtimeDisposer?.() ?? lifecycle?.cancel() ?? Promise.resolve() }
      catch (error) { drain = Promise.reject(error) }
      shutdown = Promise.allSettled([drain, drainActivities(), predecessor?.drain]).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Runtime shutdown failed')
      })
      void shutdown.catch(() => {})
      return shutdown
    },
    suspendRuntime() {
      if (shutdown) return shutdown
      if (suspended) return suspension ?? Promise.resolve()
      suspended = true
      abortReleases()
      let drain: Promise<void>
      try { drain = runtimeWarmup?.suspend?.() ?? runtimeWarmup?.cancel() ?? Promise.resolve() }
      catch (error) { drain = Promise.reject(error) }
      suspension = Promise.all([drain, drainActivities()]).then(() => {})
      void suspension.catch(() => {})
      return suspension
    },
    async resumeRuntime() {
      const pending = suspension
      const lifecycle = runtimeWarmup
      await pending
      if (shutdown || pending !== suspension || lifecycle !== runtimeWarmup) return
      await lifecycle?.resume?.()
      if (shutdown || pending !== suspension || lifecycle !== runtimeWarmup) return
      suspended = false
      suspension = undefined
    },
    async releaseCompilerResources(options) {
      if (options?.signal?.aborted) return 'cancelled'
      if (shutdown) return 'released'
      const request = new AbortController()
      const abort = () => request.abort()
      options?.signal?.addEventListener('abort', abort, { once: true })
      releases.add(request)
      const lifecycle = runtimeWarmup
      try {
        await drainActivities(request.signal)
        if (request.signal.aborted) return 'cancelled'
        if (shutdown || !lifecycle) return 'released'
        if (lifecycle !== runtimeWarmup) return 'cancelled'
        return await lifecycle.release?.({ signal: request.signal }) ?? 'cancelled'
      } finally {
        releases.delete(request)
        options?.signal?.removeEventListener('abort', abort)
      }
    },
    warmup() {
      if (shutdown || suspended || (predecessor && !predecessor.ready)) return Promise.resolve({ status: 'skipped', diagnostics: [], reason: 'runtime-unavailable' })
      return runtimeWarmup?.warmup() ?? Promise.resolve({ status: 'skipped', diagnostics: [], reason: 'runtime-unavailable' })
    },
    cancelWarmup: () => runtimeWarmup?.cancel() ?? Promise.resolve(),
    compilationStatistics: () => {
      const statistics = runtimeWarmup?.compilationStatistics?.()
      return statistics === undefined ? undefined : structuredClone(statistics)
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
      void runtimeWarmup?.cancel()
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
    acquireRuntimeActivity,
    beginRuntime,
    retireRuntime(identity, dispose) {
      let drain: Promise<void>
      try { drain = runtimeIdentity === identity ? handle.shutdownRuntime() : dispose() }
      catch (error) { drain = Promise.reject(error) }
      const previous = predecessor?.drain
      const retirement = { ready: false, drain: Promise.all([previous, drain]).then(() => {}) }
      predecessor = retirement
      void retirement.drain.then(() => { retirement.ready = true }, () => {})
      return retirement.drain
    },
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
    attachRuntimeWarmup(lifecycle) {
      // StrictMode may reuse the public ref while EngineProvider creates a new session.
      // Only a different actual session identity may start a new attachment lifetime.
      if (lifecycle.identity) beginRuntime(lifecycle.identity)
      runtimeWarmup = lifecycle
      if (shutdown) {
        // A permanent close before the first session attachment is still final.
        // Retire the arriving session instead of letting effect timing reopen it.
        const prior = shutdown
        let late: Promise<void>
        try { late = lifecycle.shutdown?.() ?? lifecycle.cancel() }
        catch (error) { late = Promise.reject(error) }
        shutdown = Promise.all([prior, late]).then(() => {})
        void shutdown.catch(() => {})
      }
      const ready = () => {
        if (runtimeWarmup === lifecycle && !shutdown && !suspended) lifecycle.ready?.()
      }
      if (predecessor && !predecessor.ready) void predecessor.drain.then(ready, () => {})
      else ready()
      return () => {
        if (runtimeWarmup !== lifecycle) return
        runtimeWarmup = undefined
      }
    },
  }
}

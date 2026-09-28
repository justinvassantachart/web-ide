import type { DebugState } from '@/store/debug-store'
import type { StoreApi } from 'zustand/vanilla'
import type { WorkbenchInstance } from '../react/workbench-instance-context'
import type { IDEWorkspace, WorkspaceFiles } from '../contracts/host'
import { canonicalWorkspaceFilePath } from './workspace-path'

type BreakpointStorage = Pick<Storage, 'getItem' | 'setItem'>
const activeBindings = new WeakMap<StoreApi<DebugState>, object>()

function browserStorage(): BreakpointStorage | undefined {
  try { return window.localStorage } catch { return undefined }
}

function validBreakpoints(value: unknown, files: WorkspaceFiles): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [path, lines] of Object.entries(value)) {
    if (!Array.isArray(lines)) continue
    let canonical: string
    try { canonical = canonicalWorkspaceFilePath(path) } catch { continue }
    if (!Object.hasOwn(files, canonical)) continue
    const lineCount = files[canonical].split('\n').length
    result[canonical] = [...new Set(lines.filter((line): line is number =>
      Number.isInteger(line) && line > 0 && line <= lineCount,
    ))].sort((a, b) => a - b)
  }
  return result
}

/** Applies an opted-in host's seed once, then saves the user's breakpoint choices. */
export function bindWorkspaceBreakpoints(
  instance: Pick<WorkbenchInstance, 'debugStore' | 'workspace'>,
  workspace: IDEWorkspace,
  freshlySeeded: boolean,
  storage: BreakpointStorage | undefined = browserStorage(),
): () => void {
  if (workspace.initialBreakpoints === undefined) return () => {}
  const binding = {}
  const debugStore = instance.debugStore
  activeBindings.set(debugStore, binding)
  const persistent = workspace.localCache !== 'memory'
  const storageKey = `web-ide.workspace-breakpoints.v1:${workspace.id}`
  let saved: string | null = null
  if (persistent) {
    try { saved = storage?.getItem(storageKey) ?? null } catch { /* storage is optional */ }
  }
  let restored: unknown = freshlySeeded ? workspace.initialBreakpoints : {}
  if (saved !== null) {
    // A saved empty map means the user removed every breakpoint. Invalid saved
    // data also fails closed rather than silently bringing defaults back.
    try { restored = JSON.parse(saved) } catch { restored = {} }
  }
  const breakpoints = validBreakpoints(restored, instance.workspace.snapshot())
  const debug = debugStore.getState()
  for (const path of Object.keys(debug.breakpoints)) debug.setFileBreakpoints(path, [])
  for (const [path, lines] of Object.entries(breakpoints)) debug.setFileBreakpoints(path, lines)

  const save = () => {
    if (!persistent || activeBindings.get(debugStore) !== binding) return
    try {
      storage?.setItem(storageKey, JSON.stringify(
        validBreakpoints(debugStore.getState().breakpoints, instance.workspace.snapshot()),
      ))
    } catch { /* unavailable storage never blocks the workbench */ }
  }
  save()
  let previous = debugStore.getState().breakpoints
  const unsubscribe = debugStore.subscribe((state) => {
    if (state.breakpoints === previous) return
    previous = state.breakpoints
    save()
  })
  return () => {
    unsubscribe()
    if (activeBindings.get(debugStore) !== binding) return
    activeBindings.delete(debugStore)
    // Clear only this instance after its binding ends. Never persist teardown
    // as the user's choice or affect another concurrently mounted workbench.
    const debug = debugStore.getState()
    for (const path of Object.keys(debug.breakpoints)) debug.setFileBreakpoints(path, [])
  }
}

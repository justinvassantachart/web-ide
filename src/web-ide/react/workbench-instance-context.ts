import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import { createCompilerStore, type CompilerState } from '@/store/compiler-store'
import { createDebugStore, type DebugState } from '@/store/debug-store'
import { createEditorStore, type EditorState } from '@/store/editor-store'
import { createExecutionStore, type ExecutionState } from '@/store/execution-store'
import { createFilesStore, type FilesState } from '@/store/files-store'
import { createTestStore, type TestState } from '@/testing/test-store'
import { WorkspaceController } from '../core/workspace-controller'

export interface WorkbenchInstance {
  readonly editorStore: StoreApi<EditorState>
  readonly filesStore: StoreApi<FilesState>
  readonly debugStore: StoreApi<DebugState>
  readonly executionStore: StoreApi<ExecutionState>
  readonly compilerStore: StoreApi<CompilerState>
  readonly testStore: StoreApi<TestState>
  readonly workspace: WorkspaceController
}

export function createWorkbenchInstance(): WorkbenchInstance {
  const editorStore = createEditorStore()
  const filesStore = createFilesStore()
  const debugStore = createDebugStore()
  const executionStore = createExecutionStore()
  const compilerStore = createCompilerStore()
  const testStore = createTestStore()
  const workspace = new WorkspaceController({ editorStore, filesStore, debugStore })
  return {
    editorStore,
    filesStore,
    debugStore,
    executionStore,
    compilerStore,
    testStore,
    workspace,
  }
}

export const WorkbenchInstanceContext = createContext<WorkbenchInstance | null>(null)

export function useWorkbenchInstance(): WorkbenchInstance {
  const instance = useContext(WorkbenchInstanceContext)
  if (!instance) throw new Error('Workbench instance services require <WebIDE>')
  return instance
}

const identity = <T,>(state: T): T => state

export function useWorkbenchEditorStore<T = EditorState>(selector?: (state: EditorState) => T): T {
  return useStore(useWorkbenchInstance().editorStore, selector ?? (identity as (state: EditorState) => T))
}

export function useWorkbenchFilesStore<T = FilesState>(selector?: (state: FilesState) => T): T {
  return useStore(useWorkbenchInstance().filesStore, selector ?? (identity as (state: FilesState) => T))
}

export function useWorkbenchDebugStore<T = DebugState>(selector?: (state: DebugState) => T): T {
  return useStore(useWorkbenchInstance().debugStore, selector ?? (identity as (state: DebugState) => T))
}

export function useWorkbenchExecutionStore<T = ExecutionState>(selector?: (state: ExecutionState) => T): T {
  return useStore(useWorkbenchInstance().executionStore, selector ?? (identity as (state: ExecutionState) => T))
}

export function useWorkbenchCompilerStore<T = CompilerState>(selector?: (state: CompilerState) => T): T {
  return useStore(useWorkbenchInstance().compilerStore, selector ?? (identity as (state: CompilerState) => T))
}

export function useWorkbenchTestStore<T = TestState>(selector?: (state: TestState) => T): T {
  return useStore(useWorkbenchInstance().testStore, selector ?? (identity as (state: TestState) => T))
}

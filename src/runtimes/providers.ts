import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import type { RuntimeCapabilities, RuntimeProvider } from '@/web-ide/contracts/runtime'
import { BrowserRuntimeSession } from './BrowserRuntimeSession'

function createPythonEntrypointLauncher(runtimePath: string): string {
  const encodedPath = JSON.stringify(runtimePath)
  return [
    'import os as __web_ide_os',
    'import runpy as __web_ide_runpy',
    'import sys as __web_ide_sys',
    `__web_ide_entrypoint = ${encodedPath}`,
    '__web_ide_entrypoint_dir = __web_ide_os.path.dirname(__web_ide_entrypoint) or "/"',
    'if __web_ide_entrypoint_dir in __web_ide_sys.path:',
    '    __web_ide_sys.path.remove(__web_ide_entrypoint_dir)',
    '__web_ide_sys.path.insert(0, __web_ide_entrypoint_dir)',
    'if "/" not in __web_ide_sys.path:',
    '    __web_ide_sys.path.insert(1, "/")',
    '__web_ide_runpy.run_path(__web_ide_entrypoint, run_name="__main__")',
  ].join('\n')
}

const cppCapabilities = {
  debug: true,
  breakpoints: true,
  stdin: true,
  graphics: false,
  memoryVisualization: true,
} as const satisfies RuntimeCapabilities

const pythonCapabilities = {
  debug: true,
  breakpoints: true,
  stdin: true,
  graphics: false,
  memoryVisualization: false,
} as const satisfies RuntimeCapabilities

// Clang frontend/linker diagnostics reported while the engine is building.
// Anchoring the filename form avoids treating arbitrary runtime stderr text
// containing "error:" as a failed preparation.
const cppPreparationErrorPattern =
  /(^[^\s:]+:\d+:\d+:\s+(?:fatal\s+)?error:|^wasm-ld:\s+error:|^\d+\s+errors?\s+generated\.)/

export const cppRuntimeProvider: RuntimeProvider = {
  id: 'web-ide.runtime.cpp',
  label: 'C/C++',
  languageIds: ['c', 'cpp'],
  capabilities: cppCapabilities,
  createSession: () =>
    new BrowserRuntimeSession({
      id: 'web-ide.runtime.cpp',
      languageIds: ['c', 'cpp'],
      engineLanguage: 'c',
      capabilities: cppCapabilities,
      preparationErrorPattern: cppPreparationErrorPattern,
      debugFallbackPath: '/main.cpp',
      emitResumeOnCommand: true,
      breakpointChangesRequireRestart: true,
    }),
}

export const pythonRuntimeProvider: RuntimeProvider = {
  id: 'web-ide.runtime.python',
  label: 'Python',
  languageIds: ['python'],
  capabilities: pythonCapabilities,
  createSession: () =>
    new BrowserRuntimeSession({
      id: 'web-ide.runtime.python',
      languageIds: ['python'],
      engineLanguage: 'python',
      capabilities: pythonCapabilities,
      defaultEntrypoint: 'main.py',
      createEntrypointLauncher: createPythonEntrypointLauncher,
      debugFallbackPath: '/main.py',
      workspaceOnlyStackFrames: true,
      emitResumeOnCommand: true,
      deferBreakpointUpdatesWhileRunning: true,
      trustBreakpointValidation: false,
      resetAdapterAfterBreakpointClear: true,
      maxBreakpointConfigurationBytes: 3_500,
    }),
}

export const cppRuntimePlugin: IDEPlugin = {
  id: 'web-ide.runtime.cpp.plugin',
  contributes: { runtimeProviders: [cppRuntimeProvider] },
}

export const pythonRuntimePlugin: IDEPlugin = {
  id: 'web-ide.runtime.python.plugin',
  contributes: { runtimeProviders: [pythonRuntimeProvider] },
}

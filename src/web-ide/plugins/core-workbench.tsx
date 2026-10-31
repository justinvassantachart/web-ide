import { MemoryVisualizer } from '@/components/debug/MemoryVisualizer'
import { VariablesPanel } from '@/components/debug/VariablesPanel'
import { ExplorerView } from '@/components/sidebar/ExplorerView'
import type { IDEPlugin } from '../contracts/plugin'

export const coreWorkbenchPlugin: IDEPlugin = {
  id: 'web-ide.core-workbench',
  contributes: {
    activities: [
      {
        id: 'workbench.files',
        title: 'Explorer',
        icon: 'files',
        component: ExplorerView,
        order: 100,
      },
    ],
    panels: [
      {
        id: 'variables',
        title: 'Variables',
        component: VariablesPanel,
        order: 10,
        when: ({ runtimeCapabilities }) => runtimeCapabilities.debug,
      },
      {
        id: 'graph',
        title: 'Graph',
        component: MemoryVisualizer,
        order: 20,
        when: ({ runtimeCapabilities }) =>
          runtimeCapabilities.debug
          && runtimeCapabilities.memoryVisualization !== false,
      },
    ],
    // Launch commands stay visible for the whole run and are disabled while
    // the runtime is busy; Stop appears beside them for the whole run (and
    // while a preparation is still compiling) and shares the pipeline's stop.
    commands: [
      {
        id: 'workbench.run',
        title: 'Run',
        icon: 'play',
        surface: 'toolbar',
        group: 'run',
        tone: 'success',
        order: 10,
        enabled: ({ runState, runtimeReady, isCompiling }) =>
          runState === 'idle' && runtimeReady && !isCompiling,
        disabledReason: ({ runState, runtimeReady, isCompiling }) =>
          !runtimeReady ? 'Compiler is still downloading…'
            : isCompiling ? 'Preparing the current run…'
              : runState !== 'idle' ? 'A program is already running. Stop it first.'
                : undefined,
        execute: ({ execution }) => execution.start('run'),
      },
      {
        id: 'workbench.debug',
        title: 'Debug',
        icon: 'bug',
        surface: 'toolbar',
        group: 'run',
        order: 20,
        when: ({ runtimeCapabilities }) => runtimeCapabilities.debug,
        enabled: ({ runState, runtimeReady, isCompiling }) =>
          runState === 'idle' && runtimeReady && !isCompiling,
        disabledReason: ({ runState, runtimeReady, isCompiling }) =>
          !runtimeReady ? 'Compiler is still downloading…'
            : isCompiling ? 'Preparing the current run…'
              : runState !== 'idle' ? 'A program is already running. Stop it first.'
                : undefined,
        execute: ({ execution }) => execution.start('debug'),
      },
      {
        id: 'workbench.stop',
        title: 'Stop',
        icon: 'debug-stop',
        surface: 'toolbar',
        group: 'run',
        tone: 'danger',
        order: 100,
        // Foreground preparation is cancellable before a guest has started.
        // Initial warmup does not set the foreground isCompiling state.
        when: ({ runState, isCompiling }) => runState !== 'idle' || isCompiling,
        execute: ({ execution }) => execution.stop(),
      },
    ],
  },
}

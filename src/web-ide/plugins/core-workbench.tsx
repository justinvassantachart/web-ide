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
    commands: [
      {
        id: 'workbench.run',
        title: 'Run',
        icon: 'play',
        surface: 'toolbar',
        group: 'run',
        tone: 'success',
        order: 10,
        when: ({ runState }) => runState === 'idle',
        enabled: ({ runtimeReady, isCompiling }) => runtimeReady && !isCompiling,
        disabledReason: ({ runtimeReady }) =>
          runtimeReady ? undefined : 'Compiler is still downloading…',
        execute: ({ execution }) => execution.start('run'),
      },
      {
        id: 'workbench.debug',
        title: 'Debug',
        icon: 'bug',
        surface: 'toolbar',
        group: 'run',
        order: 20,
        when: ({ runState, runtimeCapabilities }) =>
          runState === 'idle' && runtimeCapabilities.debug,
        enabled: ({ runtimeReady, isCompiling }) => runtimeReady && !isCompiling,
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
        when: ({ runState }) => runState === 'running',
        execute: ({ execution }) => execution.stop(),
      },
    ],
  },
}

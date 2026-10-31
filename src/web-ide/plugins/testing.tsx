import { TestsPanel } from '@/testing/TestsPanel'
import type { IDEPlugin } from '../contracts/plugin'

export const testingPlugin: IDEPlugin = {
  id: 'web-ide.testing-ui',
  contributes: {
    panels: [
      { id: 'tests', title: 'Tests', component: TestsPanel, order: 40 },
    ],
    commands: [
      {
        id: 'workbench.test',
        title: 'Tests',
        icon: 'beaker',
        surface: 'toolbar',
        group: 'run',
        order: 30,
        when: ({ testingAvailable }) => testingAvailable,
        enabled: ({ runState, runtimeReady, isCompiling, testingAvailable }) =>
          testingAvailable && runState === 'idle' && runtimeReady && !isCompiling,
        disabledReason: ({ runState, runtimeReady, isCompiling }) =>
          !runtimeReady ? 'Compiler is still downloading…'
            : isCompiling ? 'Preparing the current run…'
              : runState !== 'idle' ? 'A program is already running. Stop it first.'
                : undefined,
        execute: ({ execution }) => execution.start('test'),
      },
    ],
  },
}

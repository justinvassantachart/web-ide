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
        when: ({ runState, testingAvailable }) =>
          testingAvailable && runState === 'idle',
        enabled: ({ runtimeReady, isCompiling, testingAvailable }) =>
          testingAvailable && runtimeReady && !isCompiling,
        execute: ({ execution }) => execution.start('test'),
      },
    ],
  },
}

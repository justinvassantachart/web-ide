import { Component, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type WebIDEConfiguration,
} from 'web-ide'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import { cppRuntimePlugin } from 'web-ide/runtimes'
import { cppTestingPlugin, testingPlugin } from 'web-ide/testing'
import 'web-ide/styles.css'

type DemoMode = 'full' | 'runtime-only' | 'missing-runtime'

const configurations: Record<DemoMode, WebIDEConfiguration> = {
  full: {
    runtimeProvider: 'web-ide.runtime.cpp',
    testProvider: 'web-ide.testing.cpp',
    plugins: [
      cppRuntimePlugin,
      cppTestingPlugin,
      coreWorkbenchPlugin,
      testingPlugin,
    ],
  },
  'runtime-only': {
    runtimeProvider: 'web-ide.runtime.cpp',
    plugins: [cppRuntimePlugin, coreWorkbenchPlugin],
  },
  'missing-runtime': {
    runtimeProvider: 'web-ide.runtime.cpp',
    testProvider: 'web-ide.testing.cpp',
    plugins: [cppTestingPlugin, coreWorkbenchPlugin, testingPlugin],
  },
}

const descriptions: Record<DemoMode, string> = {
  full: 'Run, Debug, and Tests are available.',
  'runtime-only': 'Run and Debug work; there is no Tests command or C++ test adapter.',
  'missing-runtime': 'The workbench cannot mount because the selected runtime was not registered.',
}

const plainProgram = [
  '#include <iostream>',
  '',
  'int main() {',
  '    std::cout << "Runtime plugin works!\\n";',
  '}',
].join('\n')

const testedProgram = [
  '#include <iostream>',
  '#include "nova_test.h"',
  '',
  'int square(int value) { return value * value; }',
  '',
  'STUDENT_TEST("square") {',
  '    EXPECT_EQUALS(square(4), 16);',
  '}',
  '',
  'int main() {',
  '    std::cout << "Click Run, Debug, or Tests.\\n";',
  '}',
].join('\n')

class DemoErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.message) {
      return (
        <pre style={{ margin: 0, padding: 24, color: '#f87171', whiteSpace: 'pre-wrap' }}>
          Expected mount error:{'\n'}{this.state.message}
        </pre>
      )
    }
    return this.props.children
  }
}

export function Demo() {
  const [mode, setMode] = useState<DemoMode>('full')
  const host = {
    workspace: {
      id: `plugin-demo-${mode}`,
      localCache: 'memory' as const,
      initialFiles: {
        '/workspace/main.cpp': mode === 'full' ? testedProgram : plainProgram,
      },
    },
  }

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr' }}>
      <header style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        <label htmlFor="mode">Composition:</label>
        <select
          id="mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as DemoMode)}
        >
          <option value="full">Runtime + C++ tests + Tests UI</option>
          <option value="runtime-only">Runtime only</option>
          <option value="missing-runtime">Missing runtime</option>
        </select>
        <span>{descriptions[mode]}</span>
      </header>
      <main style={{ minHeight: 0 }}>
        <DemoErrorBoundary key={mode}>
          <WebIDEHostProvider host={host}>
            <WebIDE configuration={configurations[mode]} />
          </WebIDEHostProvider>
        </DemoErrorBoundary>
      </main>
    </div>
  )
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(<Demo />)

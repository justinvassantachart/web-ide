import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type WebIDEConfiguration,
  type WorkspaceFiles,
} from 'web-ide'
import { cppRuntimePlugin, pythonRuntimePlugin } from 'web-ide/runtimes'
import { pythonTestingPlugin, testingPlugin } from 'web-ide/testing'
import { canvasPlugin, coreWorkbenchPlugin } from 'web-ide/plugins'
import 'web-ide/styles.css'

const searchParams = new URLSearchParams(window.location.search)
const useCppRuntime = searchParams.get('runtime') === 'cpp'
const useFailingPythonTest = searchParams.get('tests') === 'failing'

const configuration: WebIDEConfiguration = useCppRuntime
  ? {
      runtimeProvider: 'web-ide.runtime.cpp',
      brand: 'WEB·IDE',
      plugins: [cppRuntimePlugin, coreWorkbenchPlugin, canvasPlugin],
    }
  : {
      runtimeProvider: 'web-ide.runtime.python',
      testProvider: 'web-ide.testing.python-unittest',
      brand: 'WEB·IDE',
      plugins: [
        pythonRuntimePlugin,
        pythonTestingPlugin,
        coreWorkbenchPlugin,
        canvasPlugin,
        testingPlugin,
      ],
    }

const initialFiles: WorkspaceFiles = useCppRuntime
  ? {
      '/workspace/main.cpp': [
        '#include <iostream>',
        '',
        'int doubleValue(int value) {',
        '    int result = value * 2;',
        '    return result;',
        '}',
        '',
        'int main() {',
        '    int seed = 5;',
        '    int answer = doubleValue(seed);',
        '    std::cout << "Double " << seed << " is " << answer << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    }
  : {
      '/workspace/main.py': [
        'from helpers import double',
        '',
        'seed = 5',
        'answer = double(seed)',
        'print(f"Double {seed} is {answer}")',
        '',
        'def fail_from_main():',
        '    raise ValueError("failure from user main")',
      ].join('\n'),
      '/workspace/helpers.py': [
        'def double(value):',
        '    result = value * 2',
        '    return result',
      ].join('\n'),
      '/workspace/test_helpers.py': useFailingPythonTest
        ? [
            'import unittest',
            '',
            'from main import fail_from_main',
            '',
            '',
            'class MainLocationTests(unittest.TestCase):',
            '    def test_failure_location(self):',
            '        fail_from_main()',
          ].join('\n')
        : [
            'import unittest',
            '',
            'from helpers import double',
            '',
            '',
            'class DoubleTests(unittest.TestCase):',
            '    def test_double(self):',
            '        self.assertEqual(double(6), 12)',
          ].join('\n'),
    }

const host = {
  workspace: {
    id: useCppRuntime
      ? 'basic-example-cpp-v1'
      : useFailingPythonTest
        ? 'basic-example-python-failing-v1'
        : 'basic-example-python-v3',
    localCache: 'memory' as const,
    initialFiles,
  },
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebIDEHostProvider host={host}>
      <div style={{ width: '100vw', height: '100vh' }}>
        <WebIDE configuration={configuration} />
      </div>
    </WebIDEHostProvider>
  </StrictMode>,
)

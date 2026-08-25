import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  initWebIDETheme,
  type IDEPlugin,
  type IDEWorkspacePersistence,
  type WebIDEConfiguration,
  type WebIDEHost,
  type WorkspaceFiles,
} from 'web-ide'
import { cppRuntimePlugin, pythonRuntimePlugin } from 'web-ide/runtimes'
import { pythonTestingPlugin, testingPlugin } from 'web-ide/testing'
import { canvasPlugin, coreWorkbenchPlugin } from 'web-ide/plugins'
import { ExampleApplication } from './ExampleApplication'
import { ExecutionSourceProbe } from './ExecutionSourceProbe'
import {
  LayoutBrowserFixture,
  type LayoutBrowserMode,
} from './LayoutBrowserFixture'
import 'web-ide/styles.css'

const searchParams = new URLSearchParams(window.location.search)
const useCppRuntime = searchParams.get('runtime') === 'cpp'
const useFailingPythonTest = searchParams.get('tests') === 'failing'
const useExecutionOnlyResource = searchParams.get('resources') === 'execution-only'
const showLifecycleProbe = searchParams.get('lifecycle') === 'probe'
const showExecutionSourceProbe = searchParams.get('source') === 'probe'
const layoutMode = searchParams.get('layout') as LayoutBrowserMode | null

const executionOnlyResourcePlugin: IDEPlugin = {
  id: 'web-ide.example.execution-resource',
  contributes: {
    resources: [{
      id: 'web-ide.example.execution-resource.files',
      scope: 'execution-only',
      files: {
        '/protected_support.py': [
          'def protected_message():',
          '    return "Execution-only resource loaded"',
        ].join('\n'),
      },
    }],
  },
}

const executionSourceProbePlugin: IDEPlugin = {
  id: 'web-ide.example.execution-source-probe',
  contributes: {
    activities: [{
      id: 'web-ide.example.execution-source-probe.activity',
      title: 'Execution and source',
      icon: 'debug-alt-small',
      component: ExecutionSourceProbe,
      order: 10,
    }],
  },
}

const configuration: WebIDEConfiguration = useCppRuntime
  ? {
      runtimeProvider: 'web-ide.runtime.cpp',
      brand: 'WEB·IDE',
      plugins: [
        cppRuntimePlugin,
        ...(useExecutionOnlyResource ? [executionOnlyResourcePlugin] : []),
        coreWorkbenchPlugin,
        canvasPlugin,
      ],
    }
  : {
      runtimeProvider: 'web-ide.runtime.python',
      testProvider: 'web-ide.testing.python-unittest',
      brand: 'WEB·IDE',
      plugins: [
        pythonRuntimePlugin,
        pythonTestingPlugin,
        ...(useExecutionOnlyResource ? [executionOnlyResourcePlugin] : []),
        ...(showExecutionSourceProbe ? [executionSourceProbePlugin] : []),
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
  : useExecutionOnlyResource
    ? {
        '/workspace/main.py': [
          'from protected_support import protected_message',
          '',
          'print(protected_message())',
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

const workspaceId = useCppRuntime
  ? 'basic-example-cpp-v1'
    : showExecutionSourceProbe
      ? 'basic-example-python-execution-source-v1'
      : useFailingPythonTest
    ? 'basic-example-python-failing-v1'
    : useExecutionOnlyResource
      ? 'basic-example-python-execution-resource-v1'
      : 'basic-example-python-v3'

const lifecycleEvents: string[] = []
const lifecyclePersistence: IDEWorkspacePersistence = {
  save(files, context) {
    lifecycleEvents.push(
      `save:r${context.revision}:${context.reason}:${Object.keys(files).sort().join(',')}`,
    )
  },
  flush() {
    lifecycleEvents.push('flush')
  },
  dispose() {
    lifecycleEvents.push('dispose')
  },
}

const host: WebIDEHost = {
  workspace: {
    id: workspaceId,
    localCache: 'memory',
    initialFiles,
    ...(showLifecycleProbe ? { persistence: lifecyclePersistence } : {}),
  },
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {layoutMode === 'custom'
      || layoutMode === 'invalid'
      || layoutMode === 'invalid-activity'
      || layoutMode === 'multiple'
      || layoutMode === 'remount'
      || layoutMode === 'unavailable'
      ? (
          <LayoutBrowserFixture
            mode={layoutMode}
            configuration={configuration}
            host={host}
          />
        )
      : (
          <ExampleApplication
            configuration={configuration}
            host={host}
            lifecycleEvents={lifecycleEvents}
            showLifecycleProbe={showLifecycleProbe}
          />
        )}
  </StrictMode>,
)

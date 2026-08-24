import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type IDEPlugin,
  type RuntimeOutcome,
  type WebIDEConfiguration,
  type WebIDEInstanceHandle,
} from 'web-ide'
import { cppRuntimePlugin } from 'web-ide/runtimes'
import { cppTestingPlugin, testingPlugin } from 'web-ide/testing'
import { cppLanguageToolingPlugin } from 'web-ide/language-tools'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import 'web-ide/styles.css'

const webIDERef = createRef<WebIDEInstanceHandle>()

async function verifyPublicLifecycle(
  handle: WebIDEInstanceHandle,
): Promise<RuntimeOutcome> {
  handle.persistedFiles()
  await handle.flushWorkspace()
  await handle.close()
  return { type: 'stopped' }
}

// Compile this public contract against the clean installed tarball without
// closing the fixture automatically at runtime.
void verifyPublicLifecycle

const hostActivity: IDEPlugin = {
  id: 'consumer.notes',
  contributes: {
    activities: [
      {
        id: 'consumer.notes.activity',
        title: 'Notes',
        icon: 'note',
        component: ({ workspace }) => (
          <pre>{Object.keys(workspace.snapshot()).sort().join('\n')}</pre>
        ),
        order: 10,
      },
    ],
    resources: [
      {
        id: 'consumer.execution-resource',
        scope: 'execution-only',
        files: {
          '/support.hpp': '#pragma once\n',
        },
      },
    ],
  },
}

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.cpp',
  languageToolingProvider: 'web-ide.language-tooling.cpp',
  testProvider: 'web-ide.testing.cpp',
  plugins: [
    cppRuntimePlugin,
    cppLanguageToolingPlugin,
    cppTestingPlugin,
    hostActivity,
    coreWorkbenchPlugin,
    testingPlugin,
  ],
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <WebIDEHostProvider
    host={{
      workspace: {
        id: 'packed-consumer',
        localCache: 'memory',
        initialFiles: { '/workspace/main.cpp': 'int main() { return 0; }' },
      },
    }}
  >
    <main style={{ width: '100vw', height: '100vh' }}>
      <WebIDE ref={webIDERef} configuration={configuration} />
    </main>
  </WebIDEHostProvider>,
)

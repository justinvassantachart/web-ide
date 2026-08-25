import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  initWebIDETheme,
  type IDEPlugin,
  type IDEPanelServices,
  type IDESourceDecoration,
  type IDESourceLocation,
  type RuntimeBreakpointMap,
  type RuntimeOutcome,
  type WebIDEConfiguration,
  type WebIDEInstanceHandle,
  type WebIDEInitialLayout,
} from 'web-ide'
import { WebIDEHostProvider, type WebIDEHost } from 'web-ide/host'
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

const publicSourceLocation: IDESourceLocation = {
  path: '/workspace/main.cpp',
  line: 1,
}

const publicSourceDecoration: IDESourceDecoration = {
  ...publicSourceLocation,
  kind: 'current',
}

const publicBreakpointOverlay: RuntimeBreakpointMap = {
  '/workspace/main.cpp': [1],
}

void publicBreakpointOverlay

async function verifyPublicPanelServices(
  services: Pick<IDEPanelServices, 'execution' | 'source'>,
): Promise<void> {
  await services.execution.start('debug')
  await services.execution.stop()
  await services.execution.restart('run')
  services.source.replaceDecorations([publicSourceDecoration])
  services.source.reveal(publicSourceLocation)
  services.source.clearDecorations()
}

void verifyPublicPanelServices

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
        component: ({ workspace, execution, source }) => (
          <section>
            <pre>{Object.keys(workspace.snapshot()).sort().join('\n')}</pre>
            <button type="button" onClick={() => void execution.start('run')}>
              Run from Notes
            </button>
            <button
              type="button"
              onClick={() => {
                source.replaceDecorations([publicSourceDecoration])
                source.reveal(publicSourceLocation)
              }}
            >
              Reveal source
            </button>
          </section>
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

const initialLayout: WebIDEInitialLayout = {
  selectedActivityId: 'consumer.activity',
  selectedPanelId: 'variables',
  panelColumnPercent: 50,
  panelContentPercent: 85,
}

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.cpp',
  languageToolingProvider: 'web-ide.language-tooling.cpp',
  testProvider: 'web-ide.testing.cpp',
  initialLayout,
  plugins: [
    cppRuntimePlugin,
    cppLanguageToolingPlugin,
    cppTestingPlugin,
    hostActivity,
    coreWorkbenchPlugin,
    testingPlugin,
  ],
}

const host: WebIDEHost = {
  workspace: {
    id: 'packed-consumer',
    localCache: 'memory',
    initialFiles: { '/workspace/main.cpp': 'int main() { return 0; }' },
  },
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <WebIDEHostProvider host={host}>
    <main style={{ width: '100vw', height: '100vh' }}>
      <WebIDE ref={webIDERef} configuration={configuration} />
    </main>
  </WebIDEHostProvider>,
)

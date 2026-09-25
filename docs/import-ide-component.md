# Import IDE component

Import the `WebIDE` React component to add an editor, terminal, C++ execution,
and debugger to your own page. Your application supplies the workspace and can
connect its own saving backend. The component does not require a classroom
service or Firebase.

## Install the released package

The package is distributed through
[web-ide releases](https://github.com/justinvassantachart/web-ide/releases), not
through an npm registry publication. Use the verified `0.6.0` release below;
`npm install web-ide` alone does not identify this project.

Run these commands from an existing React/Vite application. React and React DOM
must satisfy `^18.3.0 || ^19.0.0`.

```sh
mkdir -p vendor
curl --fail --location \
  https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.6.0/web-ide-0.6.0.tgz \
  --output vendor/web-ide-0.6.0.tgz
printf '%s\n' 'a9e154d154f7903a0b1a13d89d92c3f38d1407dc9c1597baf48b7cad85671653  vendor/web-ide-0.6.0.tgz' | shasum -a 256 -c -
npm install --save-exact ./vendor/web-ide-0.6.0.tgz
npm install --save-dev vite-plugin-wasm buffer@6.0.3 events@3.3.0 path-browserify@1.0.1 process@0.11.10 stream-browserify@3.0.0
```

Continue only after the checksum command reports `OK`. Commit the tarball and
lockfile, or use the same immutable release asset in your dependency workflow.
The release includes its package checksum, source archive, dependency inventory,
and validation records. Its existing release bytes are unchanged by later
source or documentation commits.

For a complete source example without an existing application, follow
[Self-hosting](self-hosting.md). Its workspace dependency already resolves the
local library.

## Configure the browser build

Use the complete [example Vite configuration](../examples/basic/vite.config.ts)
as a starting point. It includes:

- `@vitejs/plugin-react` and `vite-plugin-wasm`.
- Browser aliases for `node:buffer`, `node:events`, `node:path`, and `node:stream`.
- React/React DOM deduplication, ES-module workers, and an `esnext` build target.
- `optimizeDeps: { exclude: ['debugger-sh'] }` for the runtime dependency.
- Browser isolation headers on development and preview responses.

The application performs the final bundle. Copying only the React component
without this build configuration is insufficient for the bundled WebAssembly
runtime. Production hosting must also send the isolation headers described in
[Self-hosting](self-hosting.md#use-another-static-host).

## Add the C++ workbench

Place this code in your React entry point. `index.html` must contain
`<div id="root"></div>`.

```tsx
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'
import { cppRuntimePlugin } from 'web-ide/runtimes'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import { cppTestingPlugin, testingPlugin } from 'web-ide/testing'
import 'web-ide/styles.css'

const configuration: WebIDEConfiguration = {
  brand: 'web-ide',
  runtimeProvider: 'web-ide.runtime.cpp',
  testProvider: 'web-ide.testing.cpp',
  plugins: [
    cppRuntimePlugin,
    cppTestingPlugin,
    coreWorkbenchPlugin,
    testingPlugin,
  ],
}

const host: WebIDEHost = {
  workspace: {
    id: 'my-cpp-workspace-v1',
    localCache: 'opfs',
    initialFiles: {
      '/workspace/main.cpp': [
        '#include <iostream>',
        '',
        'int main() {',
        '    int value = 21;',
        '    std::cout << value * 2 << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    },
  },
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <WebIDEHostProvider host={host}>
    <div style={{ width: '100%', height: '80vh', minHeight: 480 }}>
      <WebIDE configuration={configuration} />
    </div>
  </WebIDEHostProvider>,
)
```

Click **Run** to print `42`. Set a breakpoint beside `int value = 21;`, then
click **Debug** and **Step Over** to inspect the variable. Use multiple entries
in `initialFiles` for a multi-file program. Canonical visible source paths start
with `/workspace/`.

The component needs a container with a defined height. Keep the workspace ID
stable for the same learner/activity. Change it when selecting a different
workspace. `initialFiles` seed a new workspace; they do not overwrite an
existing browser-local workspace. Use `localCache: 'memory'` for a disposable
example that starts fresh each time it is mounted.

## Save workspace files

Browser-local storage is useful for return visits. To save to your own service,
provide an `IDEWorkspacePersistence` adapter:

```tsx
import type { IDEWorkspacePersistence, WebIDEHost } from 'web-ide'

const persistence: IDEWorkspacePersistence = {
  async save(files, context) {
    const response = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: context.workspaceId,
        revision: context.revision,
        files,
      }),
    })
    if (!response.ok) throw new Error('Workspace save failed')
  },
}

const savedHost: WebIDEHost = {
  workspace: {
    id: 'learner-42-exercise-1',
    initialFiles: loadedFiles,
    persistence,
  },
}
```

Here `loadedFiles` is the `WorkspaceFiles` map your application fetched before
mounting the component, and `/api/workspace` is an endpoint you implement.
Your server owns authentication, authorization, storage, and version-conflict
handling. The example `revision` is monotonic within a component mount, not a
global database version.

Adapters may also implement `flush` and `dispose`. Use the public instance
handle's awaited close lifecycle before replacing or navigating away from a
workspace when your app must wait for saving. See
[Awaited host workspace close](../README.md#awaited-host-workspace-close) and the
[host contract](../src/web-ide/contracts/host.ts) for the complete API.

## Add optional language tools

For C++ completion, diagnostics, hover, and navigation, add
`cppLanguageToolingPlugin` from `web-ide/language-tools` to `plugins` and set
`languageToolingProvider: 'web-ide.language-tooling.cpp'`. The language service is
optional and has its own worker and asset downloads; execution does not depend
on enabling it.

See the [package exports](../README.md#package-surface),
[plugin guide](../README.md#bring-your-own-runtime-or-plugin), and
[runnable example](../examples/basic/src/main.tsx) for additional configuration.

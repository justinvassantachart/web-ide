# Web IDE

Web IDE is an embeddable browser workbench extracted from Nova. It provides a
Monaco editor, virtual workspace, terminal, debugging UI, contribution
registries, typed runtime events, host persistence, and plugin lifecycle APIs.

This public source repository is preparing the MIT-licensed `0.3.0` source
candidate. The package remains `private: true` and is not published to npm.
Hamilton distribution is limited to exact integrity-checked tarballs from
immutable releases in Hamilton's private repository. Deterministic P2.5
candidate, SBOM, license, runtime-receipt, source-archive, and strict-manifest
tooling is implemented; the package is not released until the final tagged
candidate, paired Karel gate, immutable release, and download receipts pass.
The current
built-in browser runtime providers support
C/C++ and Python execution and source-level debugging. Rust is not claimed as
supported here. The provider-neutral session contract does not expose the
underlying engine package.

## Quick start

```tsx
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type WebIDEConfiguration,
} from 'web-ide'
import { cppRuntimePlugin } from 'web-ide/runtimes'
import { cppTestingPlugin, testingPlugin } from 'web-ide/testing'
import { cppLanguageToolingPlugin } from 'web-ide/language-tools'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import 'web-ide/styles.css'

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.cpp',
  languageToolingProvider: 'web-ide.language-tooling.cpp',
  testProvider: 'web-ide.testing.cpp',
  plugins: [
    cppRuntimePlugin,
    cppLanguageToolingPlugin,
    cppTestingPlugin,
    coreWorkbenchPlugin,
    testingPlugin,
  ],
}

initWebIDETheme()
createRoot(document.getElementById('root')!).render(
  <WebIDEHostProvider
    host={{
      workspace: {
        id: 'example-v1',
        initialFiles: { '/workspace/main.cpp': 'int main() { return 0; }' },
      },
    }}
  >
    <div style={{ width: '100vw', height: '100vh' }}>
      <WebIDE configuration={configuration} />
    </div>
  </WebIDEHostProvider>,
)
```

The runnable example is in `examples/basic`.

The packaged browser runtime providers currently use Debugger.sh internally,
but that implementation name is not part of the public provider/session API.
Because the consuming application performs the final bundle, configure
`vite-plugin-wasm`, the dependency pre-bundling exclusion, an `esnext` build
target, and the narrow browser shims used by the virtual filesystem. Install
exact versions of `buffer@6.0.3`, `events@3.3.0`,
`path-browserify@1.0.1`, `process@0.11.10`, and
`stream-browserify@3.0.0`; a whole-stdlib Node polyfill plugin is neither
required nor recommended. The `esnext` target deliberately keeps the
WebAssembly loader's top-level await for current evergreen browsers and avoids
an unnecessary transform step:

```ts
plugins: [wasm()],
resolve: {
  alias: {
    'node:buffer': 'buffer',
    'node:events': 'events',
    'node:path': 'path-browserify',
    'node:stream': 'stream-browserify',
  },
  dedupe: ['react', 'react-dom'],
},
optimizeDeps: { exclude: ['debugger-sh'] },
worker: { format: 'es', plugins: () => [wasm()] },
build: { target: 'esnext' },
```

See `examples/basic/vite.config.ts` for the complete local configuration,
including the response headers required by the runtime.

## Package surface

- `web-ide` — React component, host provider, runtime/event/plugin contracts,
  and the narrow `WebIDEInstanceHandle` host facade.
- `web-ide/host` — lightweight host provider, hook, and host/event types. This
  subpath is safe to import in Node-side rendering and tests.
- `web-ide/plugins` — optional core workbench and Canvas contributions. It
  retains `testingPlugin` as a compatibility alias.
- `web-ide/runtimes` — optional C/C++ and Python browser runtime providers.
- `web-ide/testing` — the generic Tests UI plus C++ and Python unittest
  testing providers.
- `web-ide/language-tools` — the optional C/C++ clangd provider and its
  preference helpers. Core imports do not load the clangd worker integration.
- `web-ide/styles.css` — compiled workbench styles and Codicon assets.

Internal React contexts, registries, VFS modules, Monaco objects, and Zustand
stores are not package exports. Rendered plugin panels/activities receive only
public runtime, execution, source-presentation, workspace, and panel facades.

## How the pieces fit

| Piece | Owns | Does not own |
| --- | --- | --- |
| Web IDE core | editor, VFS, terminal, workbench layout, typed contracts, registries, lifecycle | a language toolchain, test framework, LMS, lessons, replay, or Karel |
| Runtime provider | one language backend session: prepare files, start/stop, stdin, debug operations, and typed runtime events | workspace persistence, panels, or test-framework parsing |
| Test provider | framework support files, per-run transforms/runner, and translation into generic `TestEvent` values | process execution or the Tests UI |
| Language-tooling provider | optional Monaco language service and its worker/cleanup | program execution |
| Plugin | declarative panels, activities, commands, resources, and any providers it chooses to contribute | private Web IDE stores |
| Host application | composition, workspace identity/persistence, chrome, routing, and application features | Web IDE internals |

The host selects providers by ID and passes their plugins in
`WebIDEConfiguration`. Registration and selection are separate on purpose: a
host may register several implementations but selects exactly one runtime and,
optionally, one test and language-tooling provider for a workbench.

For a Python workbench with the generic Tests UI:

```tsx
import { pythonRuntimePlugin } from 'web-ide/runtimes'
import { pythonTestingPlugin, testingPlugin } from 'web-ide/testing'
import { coreWorkbenchPlugin } from 'web-ide/plugins'

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  testProvider: 'web-ide.testing.python-unittest',
  plugins: [
    pythonRuntimePlugin,
    pythonTestingPlugin,
    coreWorkbenchPlugin,
    testingPlugin,
  ],
}
```

Python supports line breakpoints, Continue, Step Over, Step Into, Step Out,
call stacks, and expandable variables. Its runtime does not expose the native
address/heap model used by the C/C++ Graph panel, so Graph is hidden by a
capability predicate while Variables remains available. Monaco supplies Python
syntax support without requiring a separate language-tooling backend.

## Initial workbench layout

An embedding host may provide only the initial presentation it needs without
importing workbench state:

```tsx
const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  initialLayout: {
    selectedPanelId: 'example.preview',
    panelColumnPercent: 50,
    panelContentPercent: 85,
  },
  plugins,
}
```

`selectedPanelId` must exactly name an installed panel that is visible for the
selected runtime. Unknown or initially unavailable panels reject the
configuration; Web IDE does not silently choose another panel. The panel
column accepts 15–57 percent so the existing editor/sidebar minimums remain
possible, and panel content accepts 25–90 percent so both it and the terminal
retain their existing minimums. Omitted fields preserve the established first
visible panel and 27/70 proportions. These are per-mount initial values only:
later tab selection and resizing remain local UI state and are not persisted.

With the currently validated Python backend, breakpoint edits made while the
program is freely running are queued and applied at the next pause before it
resumes. The backend does not authoritatively relocate breakpoints from blank or
non-executable lines, so Web IDE leaves those gutter markers at the requested
line instead of claiming that they were bound.

Generic runtime workflows that need temporary source stops can use the
optional `RuntimeSession.replaceBreakpointOverlay(owner, breakpoints)` and
`clearBreakpointOverlay(owner)` methods. `RuntimeBreakpointMap` contains
canonical source paths and positive one-based lines. The owner must be a
non-null object and is compared by identity within one session; replacing or
clearing it cannot mutate another workflow's overlay or the editor's gutter
breakpoints. The built-in browser sessions atomically merge the editor set and
all owner overlays, reject the whole update if the provider's merged
configuration quota would be exceeded, and never publish overlay-only lines as
editor breakpoint-validation events. An empty replacement is a clear. The
workflow should clear its owner during stop/unmount cleanup; session disposal
also discards all remaining overlays.

The validated C/C++ backend can add breakpoints during configuration but cannot
replace or remove them safely inside an active debug run. Web IDE therefore
rejects live C/C++ breakpoint edits and restores the existing gutter markers;
stop the run, edit the breakpoints, and start Debug again.

The built-in Python engine reserves runtime `/main.py`. A custom TestProvider
that selects a different entrypoint while the workspace also contains
`main.py` must copy that user file to an ephemeral execution-plan path first.
The bundled unittest provider already performs this staging; host workspace
files are not renamed or deleted.

## Bring your own runtime or plugin

`RuntimeProvider` is the stable boundary around any execution engine, whether
it is a browser library, worker, remote service, or host implementation:

```ts
import type { IDEPlugin, RuntimeProvider } from 'web-ide'

const myRuntimeProvider: RuntimeProvider = {
  id: 'my-app.runtime.python',
  label: 'My Python runtime',
  languageIds: ['python'],
  capabilities: {
    debug: false,
    breakpoints: false,
    stdin: true,
    graphics: false,
  },
  createSession() {
    return new MyPythonRuntimeSession()
  },
}

export const myRuntimePlugin: IDEPlugin = {
  id: 'my-app.runtime.python.plugin',
  contributes: { runtimeProviders: [myRuntimeProvider] },
}
```

`MyPythonRuntimeSession` implements the exported `RuntimeSession` contract. A
new instance receives a copied `RuntimeExecutionPlan` in `prepare`, starts the
backend in `start`, publishes only the typed event channels, stops promptly,
and releases workers/listeners in `dispose`. Custom 0.1 providers remain valid
with the void `stop`/`dispose` methods. Providers that support deterministic
cleanup may additionally expose `waitForSettlement`, `stopAndWait`, and
`disposeAndWait`; those methods resolve one `RuntimeOutcome` (`completed`,
`stopped`, or `error`) per start without changing numeric exit events. The
transient-breakpoint overlay methods are additive and optional too, so an
integrating workflow must feature-detect them and fail clearly when they are a
required capability. The session never receives React stores or host
credentials. See
`src/web-ide/contracts/runtime.ts` and the contract tests under
`tests/contracts` for the exact lifecycle.

Rendered panels and sidebar activities receive one `IDEExecutionController`
using the same prepare/start/stop/restart path as toolbar commands. Its
`stop()` return remains compatible with synchronous callers and is awaitable
when the selected session supplies settled termination. The same component gets
an owner-bound source facade. One mount-owned coordinator is shared by toolbar,
panel, and hotkey controllers. Awaited stop/restart invalidate and drain any
pending test-provider or runtime preparation, so a cancelled pipeline cannot
start after it reports settlement:

```tsx
const activity: IDEActivityContribution = {
  id: 'example.trace',
  title: 'Trace',
  icon: 'debug-alt-small',
  component: ({ execution, source }) => (
    <>
      <button onClick={() => void execution.start('debug')}>Start</button>
      <button onClick={() => void execution.stop()}>Stop</button>
      <button onClick={() => {
        const location = { path: '/workspace/main.py', line: 4 } as const
        source.replaceDecorations([{ ...location, kind: 'historical' }])
        source.reveal(location)
      }}>
        Show recorded line
      </button>
    </>
  ),
}
```

Source locations must be canonical visible `/workspace` files with valid
one-based line/column bounds. Decorations use only the generic `current`,
`historical`, and `error` meanings, replace atomically per owner, and are
removed automatically when that rendered contribution unmounts. The facade
never exposes editor models, arbitrary CSS/HTML, private debug history, or
another owner's state.

Generic debug variables do not need to invent native memory. `VariableNode`
address/size/pointer fields and `StackFrame.sp` are optional; provide them only
when they are real. Set `memoryVisualization: false` when a debugger cannot
drive Graph. The field is additive for older custom providers: omitting it keeps
the legacy debug-and-Graph composition.

## Testing providers

Testing is a workbench workflow, not a runtime mode. A `TestProvider` receives
an immutable workspace snapshot and returns an ephemeral `RuntimeExecutionPlan`
plus a fresh output parser. The runtime session sees only prepared files, an
optional entrypoint, and ordinary `run`/`debug` execution. The parser translates
framework-specific output into public structured `TestEvent` values consumed by
the optional generic Tests panel.

`cppTestingPlugin` preserves Nova's `nova_test.h`, `STUDENT_TEST`, and
`EXPECT_EQUALS` behavior. It supplies the header and implementation for Tests
or when ordinary C++ source references `nova_test.h`; unrelated Run
and Debug commands do not pay for an extra test-framework compilation. Tests
also add a copied hidden-main transform and synthetic runner.
`pythonTestingPlugin` supplies an ephemeral standard-library `unittest`
discovery runner. Neither provider writes generated files to the workspace,
local cache, explorer, or host persistence.

Hosts may set `configuration.testProvider` explicitly. When it is omitted, Web
IDE selects a provider only if exactly one registered provider supports a
language exposed by the selected runtime; ambiguous matches leave testing
unavailable until the host chooses one.

Test providers may expose ephemeral `editorSupportFiles`. The selected language
tooling provider can index those declarations without adding them to the VFS,
file explorer, host snapshot, or persistence. The C++ provider uses this seam to
offer completion for `STUDENT_TEST` and `EXPECT_EQUALS` from `nova_test.h`.

## Language tooling providers

Language tooling is optional and selected independently from execution and
testing. A host opts into the packaged C/C++ backend by registering
`cppLanguageToolingPlugin` and setting `languageToolingProvider` to
`web-ide.language-tooling.cpp`. A selected provider must share at least one
language ID with the selected runtime; mismatches fail fast as configuration
errors. Omitting both leaves Monaco usable with its built-in syntax support;
editor focus, the status bar, and settings remain safe for Python, Karel, or
custom runtimes without a language backend.

The C/C++ provider preserves lazy startup, completion, hover, signatures,
definitions, symbols, diagnostics, and the existing clangd preference. A
read-only workspace disables backend startup. Provider effects own the worker,
Monaco registrations, workspace synchronization, diagnostics, and teardown.

## Host-created plugins are first class

Any consuming application can create, own, register, omit, or replace a plugin:

```tsx
import type { IDEPlugin } from 'web-ide'

export const notesPlugin: IDEPlugin = {
  id: 'my-app.notes',
  contributes: {
    activities: [{
      id: 'my-app.notes.activity',
      title: 'Notes',
      icon: 'note',
      component: ({ workspace }) => (
        <pre>{Object.keys(workspace.snapshot()).join('\n')}</pre>
      ),
    }],
    resources: [{
      id: 'my-app.notes.seed',
      files: { '/activity/readme.txt': 'Host-owned plugin resource' },
    }, {
      id: 'my-app.notes.runtime-support',
      scope: 'execution-only',
      files: () => ({
        '/current-settings.json': JSON.stringify(readCurrentSettings()),
      }),
    }],
  },
  activate(context) {
    if (context.runtime) {
      context.register(context.runtime.events.stdout.subscribe(console.log))
    }
  },
}
```

An omitted resource scope keeps the existing editable `/workspace` seed
behavior. `execution-only` files are copied under `/sysroot` for each runtime
plan, do not enter the VFS, explorer, host snapshot, or persistence, and may use
a synchronous callback that is evaluated exactly once per prepare. The runtime
rejects unsafe paths, non-string bytes, exact execution-plan overlap, and any
`/workspace`/`/sysroot` pair that would flatten to the same engine path. This is
an ownership and presentation boundary, not a confidentiality boundary:
executing browser code may still read or print support resources.

## Awaited host workspace close

Attach a ref when navigation must wait for persistence:

```tsx
import { createRef } from 'react'
import type { WebIDEInstanceHandle } from 'web-ide'

const ideRef = createRef<WebIDEInstanceHandle>()

<WebIDE ref={ideRef} configuration={configuration} />

// The host may offer this projection as an authorized local export.
const files = ideRef.current?.persistedFiles()
await ideRef.current?.flushWorkspace()
await ideRef.current?.close()
```

`persistedFiles` returns only the copied `/workspace` plane. `flushWorkspace`
saves that projection and waits for the host adapter. `close` saves, flushes,
and only then disposes persistence. A save or flush failure rejects without
disposing the adapter, so the host can keep navigation blocked and retry. A
React unmount still performs best-effort legacy cleanup to avoid leaking an
adapter when the host cannot await.

Karel is deliberately not present in this repository. The separately
maintained `@web-ide/karel` companion lives in the local sibling
`../web-ide-karel` repository. It consumes this same public plugin API, owns its
panel/Python library/world/protocol, and is supplied by the host. It does not
provide or import a Python interpreter; the host composes it with any selected
Python runtime provider. Web IDE does not maintain a closed plugin catalog.

## Local development

Requires Node `^20.19.0` or `>=22.12.0`, matching the supported Vite runtime.

```sh
npm install
npm run validate
npm run dev
```

`npm run validate` checks lint, types, the unit/integration suite, the library
and example builds, package contents, and a fresh consumer that installs the
packed tarball from its committed lockfile without source aliases or sibling
imports. Before installation, it copies the candidate to `web-ide.tgz`, streams
that destination's SHA-512, and requires the exact locked integrity and local
resolution. Its script-disabled clean install uses disposable home, temporary,
cache, and npm-config paths plus an explicit registry and scrubbed build
environment.
The consumer packs current source into an OS temporary directory by default, so
it does not leave a tarball in the repository. Release tooling can validate an
already-built candidate by setting
`WEB_IDE_CANDIDATE_TARBALL` to its absolute path.

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser` for the real Python debugger flow or
`npm run test:browser:headed` to watch it. `npm run validate:production` runs
the complete static/package gate followed by the production-build browser test.
See [Testing](docs/testing.md) for suite placement, browser-test rules, and the
required validation matrix for future changes.

For a normal sibling Nova clone, use `"web-ide": "file:../web-ide"`, build Web
IDE first, and add `resolve.dedupe: ['react', 'react-dom']` while locally linked.
The isolated Codex worktree uses an absolute `file:` dependency only for local
verification; that path is not a publishing strategy.

The source license and package version do not themselves complete a release.
See [Publishing readiness](docs/publishing-readiness.md) for candidate,
finalization, immutable-release, and downstream-consumption evidence.

## Browser and runtime requirements

Debugger.sh and the optional clangd provider use WebAssembly and
`SharedArrayBuffer`. A host using either backend must serve IDE pages with:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The package cannot set response headers. The basic example configures them for
Vite development and preview. The host is also responsible for compatible CSP,
CORS/CORP, service-worker, authentication, and route policies.

Monaco, Debugger.sh toolchains, and optional clangd assets are online runtime
dependencies today. Web IDE pins Monaco's loader runtime to `0.56.0` on
jsDelivr, matching its reviewed editor API/types; production CSP and availability
policy must admit or self-host that exact asset set. `VITE_CLANGD_WASM_URL` and
`VITE_CLANGD_JS_URL` can point to
host-owned, versioned clangd assets. The public upstream service is only a
best-effort default.

## Current limitations

- One mounted `<WebIDE>` per JavaScript realm is supported. Runtime sessions and
  plugin managers are mount-scoped; legacy workbench stores and VFS are not yet.
- `workspace.readOnly` disables editing, explorer mutation, and selected
  language-tooling startup, but it is a UI policy rather than a security boundary.
- Workspace-scoped resources seed a workspace. Version the workspace ID when a
  plugin resource upgrade must replace browser-local cached content.
- Execution-only resources are non-editable and non-persisted, but they are not
  secret or trusted grading inputs; student code and browser tooling remain an
  untrusted execution boundary.
- C++ and Python run/debug are verified. Python debugging includes line
  breakpoints, stepping, call stacks, and variables; Python does not provide the
  C/C++ native-memory Graph. The separate Karel companion has its own browser
  coverage but is not included in this package. Python unittest execution is
  browser-tested; Rust and end-to-end graphics output remain future
  provider/plugin work.
- The C++ clangd backend still ships in this package, isolated behind the
  opt-in `web-ide/language-tools` subpath rather than independently versioned.

See [Architecture](docs/architecture.md), [Testing](docs/testing.md),
[Nova migration](docs/nova-migration.md), and
[Publishing readiness](docs/publishing-readiness.md).

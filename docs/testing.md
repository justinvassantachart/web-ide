# Testing Web IDE

Web IDE is an embeddable workbench around browser workers, WebAssembly, a
virtual filesystem, and host-provided plugins. A green unit suite alone is not
enough: runtime changes must also prove that the production bundle works in an
isolated browser with the real execution backend.

## Standard commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run Vitest contract, integration, workflow, and workbench tests once. |
| `npm run test:watch` | Run Vitest while developing. |
| `npm run test:consumer` | Pack Web IDE and build a fresh consumer without source aliases. |
| `npm run test:browser` | Build the library/basic example and run Playwright headlessly. |
| `npm run test:browser:headed` | Run the same browser suite with a visible browser. |
| `npm run validate` | Run lint, Vitest, types, builds, packed consumer, and package-content checks. |
| `npm run validate:production` | Run `validate` and then the production-build browser suite. |

For a fresh checkout:

```sh
npm ci
npx playwright install chromium
npm run validate:production
```

Linux CI may need `npx playwright install --with-deps chromium`. The Python and
C/C++ browser backends download toolchain/runtime assets, so runtime browser
tests require network access unless those assets are explicitly self-hosted.

## Where tests belong

All new tests and fixtures stay under `tests`; do not put test files beside
production source.

- `tests/contracts` verifies public contracts, provider metadata, lifecycle,
  cleanup, event order, path translation, and backend protocol requests with
  controlled fakes.
- `tests/integration` verifies provider/plugin composition and workbench
  visibility without depending on private stores as a public API.
- `tests/testing` verifies test-provider transforms, generated support files,
  parsers, and generic `TestEvent` behavior.
- `tests/workbench` verifies isolated UI helpers and workbench behavior.
- `tests/consumer` installs the packed artifact and proves its export map,
  declarations, styles, assets, and peer dependency workflow.
- `tests/browser` exercises production-built examples in a real browser with
  the actual runtime dependency.

Prefer the lowest layer that can prove a behavior, then add a browser test when
the behavior crosses a browser/runtime boundary. Do not replace focused
contract tests with a single large end-to-end test.

## Required matrix for a change

Use the affected row as the minimum, adding adjacent layers when the change
crosses their boundary.

| Change | Required verification |
| --- | --- |
| Public contract, provider, or lifecycle | Contract tests, integration tests, typecheck, build, packed consumer. |
| Debug protocol, runtime paths, stdin/stdout, worker, or WASM loading | Contract tests plus a real-browser scenario using the actual backend. |
| Command, panel, capability, or contribution visibility | Integration test; add browser coverage when it controls a runtime workflow. |
| Test provider/parser | `tests/testing`; add browser coverage before claiming the framework's end-to-end workflow. |
| Export, dependency, CSS, binary, or package metadata | Build, packed consumer, `npm pack --dry-run`, and dependency/license review. |
| Host integration used by Nova | Web IDE validation plus Nova's unit, type, build, and browser regression pass. |

Bug fixes should include a regression that fails for the original bug. Test the
negative behavior too: unsupported commands stay hidden, disposed sessions do
not emit, stale runs cannot mutate replacements, and generated files do not
leak into the host workspace.

Treat `RuntimeExecutionPlan.files` as an execution-scoped view, not the durable
host workspace. Test providers may remove, rename, or add ephemeral files. Any
runtime state that persists across runs (including breakpoints) must survive a
Debug → Tests → Debug sequence unless the host explicitly resets it.

## Browser-test rules

`playwright.config.ts` builds Web IDE and `examples/basic`, serves the generated
files through Vite preview, and runs one Chromium worker. The one-worker policy
avoids several heavyweight WASM runtimes competing for browser memory and
network caches.

Browser scenarios must:

1. Use the production build, not a development server or source-only alias.
2. Verify `Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: require-corp`, and
   `window.crossOriginIsolated === true` before using the runtime.
3. Drive the public workbench UI or host/plugin facade. Do not import Zustand
   stores, VFS internals, or development-only window globals from the test.
4. Wait for observable state such as a status-bar pause, variable value, panel,
   terminal output, or exit. Do not use fixed sleeps to hide races.
5. Fail on uncaught page errors, console errors, failed network requests, and
   HTTP error responses. If an upstream failure is intentionally tolerated,
   narrow and document the exception instead of broadly suppressing errors.
6. Assert both capability presence and absence. For example, Python exposes
   Debug and Variables but not the native-memory Graph panel.
7. Leave tracing, screenshots, and video enabled on failure. Artifacts are
   written under `test-results/browser` and `playwright-report`.

The Python scenario in `tests/browser/python-debugging.spec.ts` is the reference
runtime test. It sets a real Monaco breakpoint and proves pause, Variables,
Step Over, Step Into, Step Out, Continue, imported-module source mapping, a real
unittest pass and staged-source failure-location mapping, terminal output, clean
exit, browser isolation, and clean diagnostics against the installed backend.
`tests/browser/cpp-runtime.spec.ts` is the matching C++ run/debug/step regression
for shared runtime changes, including the required rejection of breakpoint
edits that debugger-sh 0.3.15 cannot safely apply during a live native session.

When changing Python debugging, preserve the imported workspace-module and
unittest browser paths. When changing shared debugger code, rerun the C++
scenario as well; generic runtime code must not gain Python-only assumptions.

## Reviewing failures

Classify a failure before changing a timeout:

- A contract failure usually indicates a session state, mapping, event-order,
  or cleanup regression.
- A packed-consumer failure indicates an export, declaration, asset, peer, or
  source-alias leak.
- A missing `crossOriginIsolated` value indicates host response headers, not a
  debugger timing issue.
- A browser request failure may be the local preview server, a blocked CORP/CORS
  response, or an upstream toolchain outage. Record the exact URL and status.
- A pause that never arrives should be diagnosed through the trace and DAP
  lifecycle before increasing timeouts.

Do not weaken assertions merely because a browser failure is intermittent.
Reproduce it headed, identify the state transition or external dependency, and
fix or narrowly document the cause.

## Handoff checklist

Every implementation handoff should state:

- the exact commands run and whether each passed;
- browser name/version and whether the production bundle was used;
- which language/runtime workflows were exercised;
- any skipped suite and the concrete reason;
- remaining limitations or external dependencies;
- whether package, remote, deployment, or repository state changed.

Passing `npm run validate:production` is the local production gate. Publishing
or deploying still requires the separate decisions and host checks in
[Publishing readiness](publishing-readiness.md).

For dependency changes, record both `npm audit --omit=dev` and the full
`npm audit` result. Web IDE bundles some packages classified as development
dependencies during the library build, so a clean production-only audit does
not by itself clear the shipped artifact.

At the current lockfile baseline, both the production-only and full audits
report zero known vulnerabilities. The production browser matrix also proves
the exact direct browser shims that replaced the former whole-stdlib polyfill
plugin. Refresh this baseline whenever dependency metadata or the lockfile
changes.

The built-in browser providers are currently certified against exactly
`debugger-sh@0.3.15`, which is intentionally pinned in `package.json`. A runtime
dependency upgrade must update that exact version and lockfile, review upstream
protocol and asset changes, run the focused provider/lifecycle suites, run
`npm run validate:production`, repeat the browser suite at least three times,
and then rerun Nova's host regression. Do not widen the supported version range
until the same compatibility matrix has passed for every version in the range.

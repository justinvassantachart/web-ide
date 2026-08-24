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
| `npm run test:consumer` | Pack Web IDE in an OS temp directory and build a locked fresh consumer without source aliases. |
| `npm run test:release` | Run deterministic-evidence, safe-tar, runtime-lock, strict-schema, source-state, SBOM, and finalization-boundary tests. |
| `npm run test:browser` | Build the library/basic example and run Playwright headlessly. |
| `npm run test:browser:headed` | Run the same browser suite with a visible browser. |
| `npm run validate` | Run lint, Vitest, types, builds, packed consumer, and package-content checks. |
| `npm run validate:production` | Run `validate` and then the production-build browser suite. |
| `npm run release:licenses:check` | Compare generated current-provenance license evidence with the shipped text. |
| `npm run release:runtime-assets:verify` | Stream and verify every reviewed runtime-asset receipt into an external output directory. |
| `npm run release:preflight` | Exercise candidate and finalization orchestration with disposable remote/tag/synthetic-log fixtures and mark outputs nonfinal. |
| `npm run release:candidate` | Generate the final two-build candidate from clean, pushed, annotated-tagged source. |
| `npm run release:gate -- <gate-id>` | Run one reviewed local gate and emit its bounded, path-normalized, candidate/source-bound machine-receipted log only on success. |
| `npm run release:finalize` | Independently rebuild/revalidate the candidate, verify machine-receipted normalized logs, and transactionally close the strict artifact manifest. |

For a fresh checkout:

```sh
npm ci
npx playwright install chromium
npm run validate:production
```

Linux CI may need `npx playwright install --with-deps chromium`. The Python and
C/C++ browser backends download toolchain/runtime assets, so runtime browser
tests require network access unless those assets are explicitly self-hosted.

Release scripts require absolute output/input paths outside the repository.
The license check requires an absolute `WEB_IDE_RELEASE_PROVENANCE_PATH`; the
runtime verifier requires an external `WEB_IDE_RELEASE_OUTPUT_DIR`.
`release:candidate` rejects a dirty checkout, a detached or non-`main` branch,
local/remote divergence, a wrong remote, a missing/lightweight/unpushed
`web-ide-v0.2.0-source-r4` tag, or a toolchain mismatch. The earlier `v0.2.0`
`web-ide-v0.2.0-source`, `web-ide-v0.2.0-source-r2`, and
`web-ide-v0.2.0-source-r3` tags are retained
abandoned prepublication source checkpoints. The first path-normalization
revision emitted no retained log because its real gate capture failed closed
on a public HTTPS documentation URL misclassified as a UNC path; the next
revision failed closed on Vitest's ANSI-prefixed repository path. None is an
accepted candidate or release identity. Use
`release:preflight` before the real source tag; its result is explicitly
nonfinal and cannot be passed to
`release:finalize`. See [Publishing readiness](publishing-readiness.md) for the
exact five normalized-log gates and release sequencing.

`release:gate` runs npm with two distinct empty temporary user/global npmrc
files and isolated home, temporary, cache, prefix, and XDG directories. It
removes that workspace on success or failure. After the bounded subprocess has
fully exited and its canonical receipt is final, the gate normalizes the
complete log in one pass, including paths split across subprocess chunks. It
uses only the source-supported repository, home, candidate, and temporary
roots, replaces their bounded plain, JSON-slash, file-URL, and percent-encoded
forms with `<repository-root>`, `<home>`, `<web-candidate>`, and
`<execution-root>`, and rejects every residual encoded separator or local path.
The secret scan uses terminal-decoded inspection text, while retained bytes are
never token-masked. Publication pins raw and normalized dev/inode/size/mtime,
requires the current user's non-group/world-writable directory, creates the
final name with a no-clobber hard link, and verifies that exact inode before
removing owned temporary names. The configured or platform default Playwright
browser cache is passed explicitly so production browser validation can use the
already reviewed browser installation without exposing the user's npm
configuration or cache.

The packed consumer uses its committed `tests/consumer/package-lock.json`,
copies the candidate to the stable fixture name `web-ide.tgz`, and runs
`npm ci --ignore-scripts` with isolated home, temporary, cache, and user/global
npm-config paths, an explicit registry, and no inherited build variables.
Before npm runs, the
gate requires both manifest and lock to resolve exactly `file:web-ide.tgz`,
streams SHA-512 from the copied destination, and matches it to the committed
lock integrity. Mismatched bytes are deleted without invoking installation, so
an existing global cache cannot satisfy a corrupted candidate. The gate then
proves a single React/React DOM identity, runs the production-only audit, and
builds every exercised public export. The default command packs current source
into an OS temporary directory and leaves no repository tarball. To verify an
already-built release candidate, provide an absolute path:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.2.0.tgz \
  npm run test:consumer
```

The committed fixture lock is tied to the exact packed artifact. Regenerate and
review it whenever a shipped manifest, distribution file, or dependency changes;
an integrity mismatch is a gate failure, not a reason to fall back to
`npm install`.

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
- `tests/release` proves canonicalization, Rollup/lock ownership, fail-closed
  archive parsing (including concatenated gzip and unused header/PAX/padding
  channels), shared secret-like text rejection, bounded
  subprocess logs with descendant process-group settlement, runtime streaming,
  exact consumer-lock closure, executable byte pins for strict schemas,
  hermetic Git control files, deterministic source archives,
  Git-plus-independent-GitHub annotated remote tags, concurrent publication
  and staging-inode ownership/recovery, prepublication source/inventory guards,
  production rejection of every synthetic preflight
  receipt, and nonfinal-preflight rejection.

Prefer the lowest layer that can prove a behavior, then add a browser test when
the behavior crosses a browser/runtime boundary. Do not replace focused
contract tests with a single large end-to-end test.

## Required matrix for a change

Use the affected row as the minimum, adding adjacent layers when the change
crosses their boundary.

| Change | Required verification |
| --- | --- |
| Public contract, provider, or lifecycle | Contract tests, integration tests, typecheck, build, packed consumer. |
| Transient breakpoint overlay | Owner/session isolation, editor-plus-overlay merge, atomic combined-quota rejection, hidden editor validation, clear/reset/dispose lifecycle, ordinary-breakpoint regression, packed public types, and a real-runtime browser workflow when an integration depends on the stops. |
| Execution-only resource or persistence projection | Path/resource contracts, packed consumer, and a real-runtime production browser scenario proving execution succeeds while the resource remains absent from editable/persisted views. |
| Debug protocol, runtime paths, stdin/stdout, worker, or WASM loading | Contract tests plus a real-browser scenario using the actual backend. |
| Command, panel, capability, or contribution visibility | Integration test; add browser coverage when it controls a runtime workflow. |
| Panel execution or source presentation | Owner/instance isolation, bounds, Strict Mode cleanup, packed public types, and production-browser run/debug/stop/navigation/decorations with clean diagnostics. |
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
   Source-switch scenarios must exercise the pinned Monaco `0.56.0` runtime;
   canceled model/view-state work is a failure, not an allowed diagnostic.
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
`tests/browser/execution-resources.spec.ts` runs Python against a real dynamic
`/sysroot` support module, proves that module is absent from the explorer and
persisted-file projection, and drives the public awaited host close through
save, flush, and dispose.
`tests/browser/execution-source-services.spec.ts` drives a host-authored
activity through only public panel services. It proves real Python run/debug/
awaited-stop, exact current/historical/error source navigation, owner cleanup,
and isolation between two production workbench realms. The staged unittest
failure scenario separately proves that two concurrently mounted source owners
clean up independently. Focused jsdom coverage executes React's development
Strict Mode setup/cleanup replay, which a production build intentionally does
not perform.

`tests/browser/initial-layout.spec.ts` proves the production bundle preserves
the 27/70 defaults, applies requested proportions, displays the exact initial
panel without a click, rejects unknown or initially hidden panels before a
usable workbench appears, supports keyboard tab navigation, resets on remount,
and keeps simultaneous layout controllers independent.

`tests/contracts/run-pipeline-execution.test.ts` also creates two controllers
for one runtime, defers preparation through one, and stops through the other. It
proves the mount-owned coordinator drains cancellation cleanup without allowing
a late `start`, including re-entrant host events and ordered stop/restart races.

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
or consuming a release still requires P2.5's complete bundled-license inventory,
production SBOM, two-build deterministic artifact proof, exact Web IDE/Karel
candidate compatibility, immutable release receipts, and Hamilton host checks
in [Publishing readiness](publishing-readiness.md).

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

# Upstream Engine migration

The migration is opt-in per runtime provider. `createPythonRuntimeProvider({ backend: 'upstream' })`
and `createCppRuntimeProvider({ backend: 'upstream', ...options })` select the reviewed upstream
artifact. Existing exports and omitted options retain the legacy backend. Recreate the provider
when changing account/project scope. Backend choice belongs to the host's build configuration;
it is never stored in a student's project.

## Architecture and parity

| Behavior | Upstream | Shared Web IDE adapter | Host or companion |
| --- | --- | --- | --- |
| Text and binary inputs | Owned filesystem writes | Snapshot mounts; clear run files, retaining only the reserved per-session C++ cache namespace; clear all Python files | Course support assets and project images |
| Compile, Run, Debug, Stop | Process, kill, pooled workers, DAP | Session settlement, cancellation during mounting, output/exit events, existing breakpoint/source mapping | Run scheduling and course policies remain in their hosts |
| Interactive stdin | Explicit `stdin: true` | Serialized line input and EOF closure | Existing terminal UI |
| Graphics and AI | Exported `Duplex` device | One `/dev/debugger-sh-host` read/write path per run; abort and close on exit/Stop | Existing framing, request correlation, graphics/AI services and permissions |
| C++ exceptions | Upstream exception toolchain and exception-stack fix `d14753f` | Existing debugger presentation and source aliases | Representative course exception projects |
| PCH and archives | Compiler/linker flags and binary filesystem | Keep PCH enabled; pass archives and PCH; reject incompatible required compiler/sysroot digests | Rebuilt Stanford `upstream-v1` PCH/support archives using upstream libc++ ABI |
| Object reuse | Source/header dependency hashes and compile flags | Keep only `/.web-ide-build` across runs; generation includes compiler/sysroot/PCH bytes and system-header overlays | Prewarm and foreground scheduling remain in Web IDE/course host |
| Compiler retention | Compiled modules, sysroots, pooled workers | Toolchain-only prewarm and explicit release/disposal | Benchmarks must distinguish this from the fork's retained compiler instance |
| Deque formatting | Open upstream PR #23, ABI-v2 block-size fix | No duplicate formatter implementation | Course ADT and linked-list graph regression fixtures |
| Error recovery | Retry failed toolchain downloads | Probe known-zero isolated host commands before guest mounts; report `EngineLoadError`, preserve guest exit codes, reject stale work, drain disposal | Show runtime-unavailable without parsing student stderr; no persistence migration |

The Engine baseline is main plus deque PR #23, commit
`28b6738e5746e2c2950c5b60e0b5a7cc746429b0`, which includes the exception-stack fix
`d14753f4ee78f3655db8f555f685102f64b61dc2`. PR #30 was closed; its bundled runtime/API
extensions are not prerequisites. The owned package build resolves package-relative WASM
and records source/toolchain receipts. The adapter does not depend on an unbuilt Git checkout
or floating main. Any unavoidable internal Engine defect must be demonstrated separately
against this baseline before a new upstream PR is proposed.

The owned Engine candidate has one three-line runtime fix: clear the shared initialization
promise when initial WASM loading rejects. Without it, a single initial HTTP 503 poisons all
later `Engine.create()` calls in that page. Web IDE cannot clear this module-private promise.
The regression fails on unmodified main plus PR #23 and passes with the fix in Chromium and
WebKit. This fix is kept in the owned fork; proposing it upstream requires owner approval.

Compile-only preparation uses the public debugger's initial configuration barrier: after
compilation and linking, the worker supplies debug information before WASM instantiation or
entry. The adapter kills that private job without sending `configurationDone`, so constructors
and main never execute. The regression uses a constructor with side effects and an infinite
main. Instrumentation overhead is included in preparation benchmarks, not hidden as execution.
No `compileOnly`, `ProcessResult.error`, or `toolchainProvenance` Engine extension is required.

The built candidate pins compiler and sysroot bytes under
`https://justinvassantachart.github.io/engine/toolchains/sha256/<digest>/<filename>`.
Web IDE's exported `upstream-toolchains.json` records publisher origins, mirrored URLs and
verified SHA-256 values. Release checks verify those bytes; failed downloads remain retryable. The host contains only
public toolchain artifacts and preserves previously published digest directories.

The adapter uses a private compiler output path rather than exposing `CppBuildPlan.outputPath`;
the existing runtime has no compiled-output export API. The upstream Python debugger already
filters its internal frames, so the legacy `filterInternals` assignment needs no extra transport.

## Artifact and browser verification

`npm run test:upstream:consumer` packs the current built package, verifies its SHA-512 receipt,
installs it into an empty consumer using a generated exact lock, checks both Engine package
integrities, and compiles declarations plus a production bundle. The existing stable-release
consumer fixture remains pinned to its historical release receipt; the upstream prerelease has
its own explicit gate and cannot pass that historical receipt by changing its integrity check.
`npm run test:upstream:viewer` runs the existing viewer behavior suite from the same clean
candidate consumer; the historical viewer command remains bound to its stable receipt.

The `Upstream Engine candidate` CI workflow requires an immutable source-qualified Engine
release URL and lock integrity, runs unit/type/lint/build checks and the clean consumer, runs
the production runtime fixture in Chromium and WebKit, then builds/packs twice and compares
the tarballs byte-for-byte. Its artifact contains the candidate, source commit, SHA-256, clean
consumer receipt, and browser report. Publication must use that artifact, not a local rebuild.

`npm run test:upstream` uses built package exports and covers Python stdin/UTF-8/binary input,
single-path duplex requests, Stop with a reply outstanding, rejected old responses, cold Stop,
blocked input, immediate rerun, multi-file C++ exceptions, explicit source lists, source mapping,
stopping at a breakpoint, project/tab isolation and asset-outage recovery without confusing
guest exit 127 with a host failure. A Playwright WebKit result is not a native Safari result;
record those separately. A course regression also verifies that source reveal exposes Code
from compact Output, including repeated reveals of the same location.
The initial Engine download is held by a regression while Stop completes; a rerun can start
immediately and only its new source executes after the download resumes. Acquisition belongs
to the cancellable adapter operation, and an instance arriving after cancellation is disposed.
The cache regression observes actual compiler worker jobs: two on a cold two-source build,
zero unchanged, one after a one-source edit, and correct invalidation after header, flag and
same-path binary PCH changes. Changed builds are compared with clean-session outputs.

All worker responses, **including HTTP 304**, must carry the page's cross-origin isolation
headers. Vite's `preview.headers` alone omits these on conditional responses; the fixture uses
middleware before its static handler. Do not hide this problem by disabling cache or opening
a new tab for every rerun.

## Rollout and rollback

1. Build and verify the pinned Engine prerelease in CI, then publish its exact tarball as a
   GitHub prerelease. Record source SHA, tarball digest and toolchain manifest.
2. Pin that immutable URL in Web IDE, run the candidate CI workflow, and publish the exact
   verified Web IDE prerelease artifact.
3. Build the Stanford companion's separate upstream profile against the same toolchain;
   retain its legacy profile. Verify and publish its immutable prerelease artifact.
4. Pin the exact same Web IDE/Engine packages in CS106B and THS. Run each host's checks, build
   both backend configurations, and deploy only the configured staging targets.
5. The owner performs authenticated staging acceptance using synthetic projects/accounts.
   Stable publication and production-default changes remain a separate explicit decision.

Rollback redeploys the same host source with `backend: 'legacy'`, or restores the recorded
last-good immutable host build. Recreate runtime sessions on page reload. No database,
project-file, image-storage, submission, account, or student-data rollback is involved.
Verify both editor and public player where applicable, and compare their backend/build stamps.
Never run database rollback migrations to switch execution backends.

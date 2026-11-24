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
| Deque formatting | Merged upstream PR #23, ABI-v2 block-size fix | No duplicate formatter implementation | Course ADT and linked-list graph regression fixtures |
| Error recovery | Retry failed toolchain downloads | Probe known-zero isolated host commands before guest mounts; report `EngineLoadError`, preserve guest exit codes, reject stale work, drain disposal | Show runtime-unavailable without parsing student stderr; no persistence migration |

Web IDE `0.12.0-upstream.1` uses the **unmodified official npm release**
`debugger-sh@0.4.2`, aliased as `debugger-sh-upstream` to retain the legacy rollback package.
The exact npm integrity, tarball digest, upstream source
`c7c74ed8d4635acadea94683ce5774272ad8b82d`, installed-file hashes and runtime WASM URL are
exported in `web-ide/upstream-engine.json`. Upstream PRs #23 (deque formatting) and #31
(failed initialization retry) are merged into this release. PR #30 remains unnecessary.
No new Engine patch, build or upstream PR is required.

Version 0.4.1 inlines the worker and fixes reentrant debugger events. Version 0.4.2 adds
`fs.exists` and skips linking unchanged programs. Its linker reuse does not account for
removed sources or replacement archive bytes: real Chromium and WebKit regressions reproduced
an obsolete executable after either change. The shared adapter fingerprints mounted inputs,
source selection and flags, then removes only its cached executable through public `fs.remove`
when those inputs change. Upstream's compiled objects remain reusable. Failed relinks also
cannot revive the old executable on a retry. Unchanged runs retain both object and link reuse.

Compile-only preparation uses the public debugger's initial configuration barrier: after
compilation and linking, the worker supplies debug information before WASM instantiation or
entry. The adapter kills that private job without sending `configurationDone`, so constructors
and main never execute. The regression uses a constructor with side effects and an infinite
main. Instrumentation overhead is included in preparation benchmarks, not hidden as execution.
No `compileOnly`, `ProcessResult.error`, or `toolchainProvenance` Engine extension is required.

The official release loads its versioned Engine WASM from
`https://cdn.jsdelivr.net/npm/debugger-sh@0.4.2/dist/engine_bg.wasm` and its toolchains from
the publisher's `debugger-sh.github.io` URLs. The exported `upstream-toolchains.json` binds
those exact URLs and SHA-256 values, retaining the previous checksum-addressed mirrors as
rollback references. All six toolchain downloads remain byte-identical to the previous
candidate, so existing Stanford and Nova PCH/archive bytes keep the same ABI. The CDN Engine
WASM is verified against the file in the npm tarball. Consumers permit only the needed
runtime download origins and the inline Blob worker; no new CDN script permission is needed.

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

The `Upstream Engine candidate` CI workflow requires the exact official npm Engine
version, lock integrity and all installed-file hashes, runs unit/type/lint/build checks and the clean consumer, runs
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
same-path binary PCH changes. Source removal, explicit source-selection changes, same-path
archive replacement and failed-link retries are checked against clean-session results;
unchanged runs are also required to perform zero linker jobs.

All worker responses, **including HTTP 304**, must carry the page's cross-origin isolation
headers. Vite's `preview.headers` alone omits these on conditional responses; the fixture uses
middleware before its static handler. Do not hide this problem by disabling cache or opening
a new tab for every rerun.

## Rollout and rollback

1. Verify the official Engine npm tarball, registry signature/provenance, source tag and
   installed files. Pin its exact npm alias and integrity; retain the legacy package.
2. Run the Web IDE candidate CI workflow and publish its exact reproducible prerelease artifact.
3. Refresh the Stanford companion's exact peer pin and toolchain provenance, retaining its
   byte-identical upstream PCH/archive payload and legacy profile.
4. Pin the same Web IDE/Engine tuple in CS106B, THS and Nova. Run host checks, both backend
   builds and browser regressions before updating their existing deployment targets.
5. Keep authenticated owner acceptance separate from synthetic browser/AI integration checks.
   New production activation still requires explicit owner authorization.

Rollback redeploys the same host source with `backend: 'legacy'`, or restores the recorded
last-good immutable host build. Recreate runtime sessions on page reload. No database,
project-file, image-storage, submission, account, or student-data rollback is involved.
Verify both editor and public player where applicable, and compare their backend/build stamps.
Never run database rollback migrations to switch execution backends.

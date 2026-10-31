# Publishing readiness

Web IDE's source repository is public and its `0.9.0` source candidate is
licensed under MIT. The npm manifest deliberately remains `private: true`: this
checkpoint does not configure an npm publication. The distribution path is an
exact integrity-checked tarball attached to an immutable release in the owner's
public `justinvassantachart/web-ide` repository. This candidate adds permanent
runtime disposal, compiler release/suspend/resume, foreground-priority
compile-only warmup and optional validated cache inputs. The standard C++
provider retains its conservative defaults.
It retains the optional debug formatter contributions and shared Pretty/Raw
presentation in Variables and Graph. Existing runtime providers remain
supported; course-specific formatters are companion plugins. The Stanford
companion compatibility target is `0.6.0`, with an exact Web IDE `0.9.0`
peer and engine `0.3.15-webide.0.9.0.1`. These target versions are not published
releases. The completed `0.8.1` release and its evidence remain unchanged.

Release metadata preparation does not establish an accepted engine artifact.
The committed engine input now binds the exact local `0.3.15-webide.0.9.0.1` candidate
archive and embedded runtime bytes. Its planned immutable URL is not yet
published. The consumer fixture binds the `0.9.0` candidate integrity before
preflight; no provisional digest or local dependency path is a production pin.

The candidate retains the 0.7.3 Python host byte device and the 0.7.2 compiler
diagnostic correction. The 0.7.0 release introduced
shared C++ and Python testing, frozen execution
snapshots, selected-test debugging, and authoritative test reports. Its migration
from the earlier provider contract to Testing V2 remains in effect.
Published historical releases and their evidence remain unchanged; release
configuration alone does not establish publication or downstream compatibility.

## Source checkpoint complete

- The manifest records the public GitHub source, issue tracker, homepage,
  semantic version, and MIT source license without changing the export map or
  React peer ranges.
- The candidate runtime engine pin selects the exact
  `0.3.15-webide.0.9.0.1` fork, adding scoped C++ object caching, immutable
  compiler code retention, compile-only preparation and owned timing statistics.
  These features remain off for the standard provider. The fork retains the
  cumulative debugger formatter and C++/Python host-device fixes. Its exact
  GitHub release URL is reserved for the verified artifact; publication and
  immutable download verification remain separate release gates. This is
  neither an upstream registry release nor an npm publication of this project.
  `release/engine-fork-input.json` is the committed exact fork input record
  (fork source commit, build toolchain, GitHub release asset identity, and the
  engine WebAssembly that the fork embeds in its module instead of fetching).
  The record binds the exact fork artifact and the complete packed-consumer graph;
  release tools reject any dependency, integrity, or embedded-engine drift.
  Release gates require those published dependencies and clean, tagged source;
  sibling checkouts and mutable dependency substitutions do not satisfy them.
  The pending `0.9.0` tuple must preserve the legacy compiler profile for generic
  consumers. Its course cache profile uses the unmodified stock compiler with
  an engine-approved certificate; source, PCH, invocation and observed input
  checks determine admission. Package preparation alone does not prove those
  checks or the required browser performance gates.
- Host-neutral ESM exports, declarations, compiled CSS, clangd worker output,
  and raw C++ test resources remain package inputs.
- The clean packed consumer imports the root and `web-ide/host` public exports,
  requires the committed local resolution and SHA-512 before installation,
  installs with lifecycle scripts disabled plus disposable home, temporary,
  cache, and user/global npm-config paths under an explicit registry policy,
  proves one React/React DOM version, runs a production-only audit, and builds
  without source aliases or sibling imports.
- Unit, integration, and production-browser coverage must prove the exact
  candidate's C/C++ and Python behavior before release. The separately maintained Karel companion is not
  part of this package.
- Source and distribution scans exclude LMS, Firebase, lessons, replay, Karel,
  absolute developer paths, unresolved `@/` aliases, copied compiler/sysroot
  archives, Stanford library files, service workers, and deployment assets.
- At this source baseline, `npm audit --omit=dev` and the full `npm audit`
  report no known vulnerabilities. Both remain required because the library
  build can bundle development-classified inputs.

## P2.5 release-evidence implementation

The repository now contains fail-closed release tooling; this source state is
not itself a released artifact. A final candidate can be generated only from a
clean `main` whose HEAD equals both local and live `origin/main`, using Node
`24.11.1`/npm `11.6.2`, with a pushed annotated
`web-ide-v0.9.0-source` tag object peeled to that exact commit. The immutable
`web-ide-v0.8.1-source` identity remains unchanged. The immutable
`web-ide-v0.7.3-source` and `web-ide-v0.7.2-source` identities remain unchanged. The initial
`web-ide-v0.7.1-source` checkpoint is retained unchanged and did not produce a
package release: a browser check found that asynchronous clangd startup could drop the initial
workspace files. The retained `web-ide-v0.7.1-source-r2` checkpoint corrects
worker message ordering before language-server initialization, but its packed
viewer gate exposed a launcher pinned to the previous package filename. The r3
checkpoint selects the filename from validated npm pack output, keeps the exact
consumer integrity check, and waits for real native visibility and settled
initial layout in the browser lifecycle harness. Neither earlier checkpoint
produced a package release. The immutable `web-ide-v0.7.1-source-r3` tag
produced the published 0.7.1 package and remains unchanged. The previous
`web-ide-v0.7.0-source`, `web-ide-v0.6.0-source`, `web-ide-v0.5.0-source` and
`web-ide-v0.4.0-source-r4` release identities remain
unchanged. The initial
`web-ide-v0.4.0-source` checkpoint is retained after its native browser gate
exposed a macOS test-launch issue. The subsequent
`web-ide-v0.4.0-source-r2` checkpoint is retained after the Karel Prepare gate
exposed unstable contribution workspace callbacks during execution updates.
The current candidate preserves those callbacks for each workspace. The
`web-ide-v0.4.0-source-r3` checkpoint is retained after its OPFS browser test
removed the last editor model during a pending lazy worker download. The test
now waits for that download before its hierarchy replacement. The immutable
`web-ide-v0.3.1-source` and `web-ide-v0.3.0-source` tags remain earlier release
identities. The earlier
shared `v0.2.0`, `web-ide-v0.2.0-source`,
`web-ide-v0.2.0-source-r2`, and `web-ide-v0.2.0-source-r3` tags are abandoned
prepublication source checkpoints. The first failed before retained gate
evidence; the second was
withheld because its capture did not yet enforce path-normalized logs; and the
r2 capture failed closed after misclassifying a public HTTPS documentation URL
as a local UNC path. The r3 capture failed closed on the ANSI color prefix that
Vitest writes immediately before its repository path. No release or release
asset was created from any of these tags, and all remain unchanged. The
forward-only `web-ide-v0.2.0-source-r4` tag is the sole final Web IDE 0.2 source
identity.
Candidate construction then:

- makes two isolated no-hardlink checkouts, installs from `package-lock.json`
  with lifecycle scripts disabled and separate empty caches, and scrubs the
  inherited environment before both builds;
- records Rollup's actual output-module ownership, compares canonical
  provenance, license evidence, file inventories, and tarball bytes across the
  two builds, and retains one exact candidate;
- inspects `npm pack --json` and the gzip/tar bytes without extracting them,
  accepting only one pinned canonical npm gzip member and USTAR representation
  and
  rejecting traversal, links, every PAX/global metadata channel, nonzero
  padding/reserved bytes, noncanonical modes/headers/end markers, control
  characters, duplicate/case-colliding paths, missing exports/notices,
  internal paths, secret-like text, publication configuration, unexpected file
  types/files, or compressed, expanded, per-entry, and entry-count violations;
- validates a candidate-digest-bound CycloneDX 1.6 SBOM against pinned upstream
  CycloneDX, SPDX, and JSF schemas;
- emits a complete machine inventory and the exact generated
  `THIRD_PARTY_LICENSES.txt` shipped inside the tarball; and
- streams all 26 reviewed reachable runtime assets under timeout and exact
  size, SHA-256, final URL, zero-redirect, content-type, CORS, and CORP checks.
  The engine WebAssembly is no longer one of them: the fork build embeds it, so
  it is represented as the fork record's embedded-module evidence instead of a
  jsDelivr npm CDN download.

The source verifier neutralizes system/global Git configuration, system
attributes, and replacement objects; rejects worktree configuration, includes,
URL rewrites, archive
attributes, grafts, alternates, and active info excludes; compares the actual
configured origin with both Git's live remote refs and an independent bounded,
unauthenticated GitHub REST lookup; and rechecks that control state immediately
around the locally generated archive. The
deterministic manifest binds the package contract, package and lock
digests, exact annotated tag object and peeled commit, locally generated source
archive, npm SHA-512 integrity, full tar inventory, toolchain/platform, scrubbed
build environment and argv, runtime/debugger identities, candidate SHA-256,
and copied machine-receipted validation-log digests. It records only intended
release names before publication; it has no post-publication ID or downstream
manifest dependency.

This release retains the runtime composition identity `cs106b.source/2` and the
manifest kind `web-ide-capability-package-artifact`. This identity describes the
source-runtime composition, whose engine and ordinary Run/Debug contract remain
unchanged; it is not the testing protocol version. The new package version and
candidate digest bind the Testing V2 API migration and its compatibility proof.
Historical Hamilton and
Karel identities, including the 0.4.0 pair `hamilton.python/4` and
`hamilton.python-karel/8`, remain bound to their earlier bytes. The four local
Web IDE gates retain package, browser, consumer, and dependency-audit checks;
the exact CS106B companion and course-host browser proof must additionally bind
the released candidate digest before downstream deployment. Hamilton and Karel
adoption likewise requires separately retained compatibility evidence against
the new bytes and each host's accepted release policy. Those consumer checks
do not become public package evidence merely by updating the release profile.

The repository does not claim npm availability, Rust, bundled Karel behavior,
offline operation, collaboration transport, presence, or graphics output.
Multiple simultaneous embeds in one JavaScript realm are supported and covered
with overlapping canonical workspace paths; each mount owns its workspace,
stores, subscriptions, persistence lifecycle, and internal Monaco namespace.
Remote
Debugger.sh, Monaco, clangd, LLVM/WASI, and Python assets remain subject to the
host's reviewed CSP, CORS/CORP, caching, availability, integrity, and privacy
policy; they are not silently converted into bundled release assets. The
runtime lock is observation evidence, not a claim that mutable upstream URLs
are content-addressed or that their complete binary builds are reproducible.
Rust payloads are excluded because the exported C/C++ and Python providers
cannot select the dormant Debugger.sh Rust branch. Redistribution or
self-hosting requires a separate complete binary notice and source-offer review.

## Candidate and finalization gates

After committing the source but before creating the immutable real tag, run the
orchestration preflight. It uses a disposable bare remote and annotated tag,
runs the same strict candidate generator, independently rebuilds/reparses that
candidate, and exercises receipt parsing, manifest/schema closure, and
transactional directory replacement with explicitly synthetic nonrelease gate
receipts. Those receipts use a separate prefix, kind, mode, and emitter; every
one is rejected by the production receipt parser. It
then retains only the `nonrelease-preflight` candidate plus
`NON_RELEASE_PREFLIGHT.json`; it does not claim the real gates passed or retain
a publishable draft manifest. The production finalizer rejects that state and
marker, and there is no production bypass flag.

```sh
WEB_IDE_RELEASE_OUTPUT_DIR=/absolute/empty/external/preflight \
  npm run release:preflight
```

For the real candidate, push the final source commit to `origin/main`, create
and push the annotated `web-ide-v0.9.0-source` tag at that commit, and use an
absent or empty plain directory outside the repository. Generation is staged
beside that path.
Publication exclusively reserves the target name, verifies its inode while
moving the exact regular-file set, pins and safely quarantines the staging
directory by inode, keeps the reservation nonempty with a private sentinel,
revalidates source plus candidate inventory immediately before close, removes
the sentinel, re-hashes the closed result, and writes a content-digest-named
completion marker beside (never inside) the artifact directory as the final
publication action:

```sh
WEB_IDE_RELEASE_OUTPUT_DIR=/absolute/empty/external/candidate \
  npm run release:candidate
```

Run the four local gates through the reviewed receipt emitter, using one new
log path per gate:

```sh
WEB_IDE_RELEASE_OUTPUT_DIR=/absolute/external/candidate \
WEB_IDE_RELEASE_GATE_LOG=/absolute/external/logs/validate-production.log \
  npm run release:gate -- validate-production
```

The other local gate IDs are `consumer-exact-candidate`, `audit-production`,
and `audit-full`. Each receipt is the final
log line, has production mode `release-gate`, and binds the exact gate
ID/command, Web source commit, candidate SHA-256, reviewed emitter identity,
and exit code zero. The local emitter uses distinct empty, disposable npm
user/global configuration files plus isolated home, temporary, cache, prefix,
and XDG directories; the explicit Playwright browser cache is the only
host-tool cache passed through. It kills
the complete process group on a 30-minute timeout or a 16 MiB combined-log
limit. After a successful subprocess exit, it normalizes the completed bounded
UTF-8 capture in one pass so chunk boundaries cannot evade normalization. The
known repository, home, candidate, and temporary roots, including their
reviewed JSON-slash, file-URL, and percent-encoded forms, become the explicit
stable placeholders `<repository-root>`, `<home>`, `<web-candidate>`, and
`<execution-root>`. Both path boundaries must be explicit; embedded
placeholders and residual encoded separators fail closed. Raw and normalized
dev/inode/size/mtime stay pinned through a no-clobber hard-link publication in
a current-user-owned, non-group/world-writable directory, and the linked inode
is verified before owned temporary names are removed.
The canonical receipt remains byte-for-byte unchanged as the final line.
Residual local path forms, secret-like text found after terminal-control
decoding, or receipt drift remove the owned partial capture and fail the gate;
the retained bytes are never token-masked.
Record exactly one normalized UTF-8 log for each of the four gates in
`release/validation-summary.template.json`, fill its absolute regular-file path,
size, SHA-256, the exact source commit, and candidate SHA-256, then finalize:

```sh
WEB_IDE_RELEASE_OUTPUT_DIR=/absolute/external/candidate \
WEB_IDE_RELEASE_VALIDATION_INPUT=/absolute/external/validation-input.json \
  npm run release:finalize
```

Candidate/final outputs stay outside the repository. Before finalization, the
tool independently performs two new clean installs/builds, reparses the tar,
revalidates every canonical sidecar and cross-link, verifies the committed
consumer manifest plus the complete normalized transitive lock graph against
the candidate SRI, and reconstructs the exact source archive. External
input/log paths must be bounded regular non-symlink files and
are read once, copied into a staging directory, and hashed again after the
destination write. The finalized set is published only after every check and
exact file-set closure succeeds. A pre-publication failure leaves the original
candidate untouched; replacement compares the exact original inventory around
backup, never overwrites a concurrent owner, removes any completion marker it
created on a failed close, and reports retained original or partial bytes by an
explicit recovery path.

The retained upstream schema SHA-256 values are:

- CycloneDX 1.6: `bf8177eee4e8979f2ef15dd131f0ef55eaa2168382b5f888ff8a6d1c7e4d09b3`
- SPDX: `9688c076891e4147cfe978d5fa3196c740b1ff79b25b146d94178a3db6066180`
- JSF 0.82: `8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae`

The validator verifies these three byte digests before parsing or compiling
the schemas; a locally modified retained schema fails before SBOM validation.

`ajv@8.20.0` is the sole new direct development dependency. It is MIT,
integrity-locked, runs only local pinned-schema checks, is not a runtime
dependency, and is not bundled in or installed from the Web IDE tarball. The
existing optional Tailwind WASI build chain is also constrained to its bundled
`@emnapi/wasi-threads@1.2.2` so npm cannot reinterpret that upstream range as a
newer unbundled version during `npm ci`; the exact integrity-locked root record
is build-only and is not a Web IDE runtime dependency.

Publication requires the full `validate:production` run, exact candidate
consumer and audit logs, and immutable public release upload/download
receipts. CS106B consumption additionally requires its companion and course-host
proof against those exact bytes. See [Testing](testing.md) for the behavior and
evidence matrix.

## Candidate measurements before publication

Compiler acceptance and the course's M9 measurements precede publication. Freeze
candidate source commits, exact proposed versions, lock graphs, tarball hashes,
all installed package files, compiler/companion profiles and asset bytes, and the
actual served bundle. An isolated development consumer may install these frozen
candidate tarballs locally; record that substitution and never place it in a
production manifest or claim it is an immutable published install.

The disposable release preflight creates a synthetic `main` at the captured
clean candidate commit even when the real repository is on a feature branch.
It does not move real `main` or change the final release rules. The normal final
candidate still requires clean real `main`, live origin agreement, the annotated
source tag, two deterministic clean builds, and the exact published upstream
engine dependency. Preflight evidence is explicitly nonfinal.

Before that engine URL is published, the nonfinal preflight alone may accept
`WEB_IDE_PREFLIGHT_ENGINE_TARBALL=/absolute/verified/engine-candidate.tgz`.
The committed engine input must already describe its exact proposed version,
planned immutable URL, source commit, SHA-256, SHA-512 integrity, size and embedded
runtime identities. Preflight verifies the supplied package and seeds only its
owned disposable npm caches before the unchanged locked installs. It verifies
the installed package manifest and embedded runtime bytes, records this transport
in candidate state and deterministic-build evidence, and repeats verification
during the independent rebuild. Source manifests and locks keep their planned
HTTPS dependency. This transport is not evidence that the URL exists or is
immutable; the production finalizer rejects the variable and nonfinal state.

After merging/tagging and dependency-order publication, install the immutable
packages in a clean consumer. Compare their complete inventories with the
measured candidate. Prefer identical complete tarballs. If source tags, archive
headers or generated source/evidence metadata differ, record every changed path
and both hashes, explain the change, and separately require byte equality for
all executable JavaScript, WASM, CSS, declarations, profile manifests, compiler,
sysroot, exception/PCH/archive bytes and other runtime resources. Changed
package dependency/peer/export metadata requires clean graph/public-type checks.
Any runtime or asset difference invalidates the corresponding candidate
measurements until the affected correctness/performance gates are rerun. A
version label or similar output is not an equivalence proof.

Finally verify the serving revision and its complete asset tuple and run the
deployed smoke checks. Neither preflight nor M9 replaces immutable clean-install
validation, repository review/merge protections, release evidence finalization,
or the actual deployment verification.

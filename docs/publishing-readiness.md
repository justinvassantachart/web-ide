# Publishing readiness

Web IDE's source repository is public and its `0.2.0` source candidate is
licensed under MIT. The npm manifest deliberately remains `private: true`: this
checkpoint does not authorize or configure an npm publication. Hamilton's
accepted distribution path is an exact integrity-checked tarball attached to an
immutable release in Hamilton's private repository.

## Source checkpoint complete

- The manifest records the public GitHub source, issue tracker, homepage,
  semantic version, and MIT source license without changing the export map,
  React peer ranges, or exact `debugger-sh@0.3.15` runtime pin.
- Host-neutral ESM exports, declarations, compiled CSS, clangd worker output,
  and raw C++ test resources remain package inputs.
- The clean packed consumer imports the root and `web-ide/host` public exports,
  requires the committed local resolution and SHA-512 before installation,
  installs with lifecycle scripts disabled plus disposable home, temporary,
  cache, and user/global npm-config paths under an explicit registry policy,
  proves one React/React DOM version, runs a production-only audit, and builds
  without source aliases or sibling imports.
- Unit, integration, and production-browser coverage proves the current C/C++
  and Python runtime claims. The separately maintained Karel companion is not
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
`24.11.1`/npm `11.6.2`, with a pushed annotated `v0.2.0` tag object peeled to
that exact commit. Candidate construction then:

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
- streams all 27 reviewed reachable runtime assets under timeout and exact
  size, SHA-256, final URL, zero-redirect, content-type, CORS, and CORP checks.

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
Hamilton release names before publication; it has no post-publication ID and no
Karel-manifest dependency. The Karel compatibility log can therefore finalize
Web evidence before Karel binds the resulting Web manifest.

The repository does not claim npm availability, Rust, bundled Karel behavior,
offline operation, multiple simultaneous embeds, or graphics output. Remote
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
and push the annotated `v0.2.0` tag at that commit, and use an absent or empty
plain directory outside the repository. Generation is staged beside that path.
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
and `audit-full`. The paired Karel gate emits its one log with the reviewed
`karel:release-compatibility-gate@2` receipt contract. Each receipt is the final
log line, has production mode `release-gate`, and binds the exact gate
ID/command, Web source commit, candidate SHA-256, reviewed emitter identity,
and exit code zero. The local emitter kills
the complete process group on a 30-minute timeout or a 16 MiB combined-log
limit and removes every partial log on failure. Record exactly one raw
UTF-8 log for each of the five gates in
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

The remaining publication gate is the full `validate:production` run, exact
candidate consumer and audit logs, paired Karel compatibility log, immutable
private release upload/download receipts, and Hamilton's pinned installation
proof. See [Testing](testing.md) for the behavior and evidence matrix.

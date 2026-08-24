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
  installs with lifecycle scripts disabled and a disposable empty npm cache,
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

## P2.5 release evidence still required

The MIT source license is not by itself a complete distribution-license audit.
Before calling `0.2.0` released or allowing Hamilton to depend on it, P2.5 must
also produce and verify:

- a complete license inventory for every file and dependency bundled in the
  exact tarball, with required notices retained;
- a production-dependency SBOM tied to the candidate SHA-256;
- byte-for-byte deterministic tarballs from two clean isolated builds;
- the full `validate:production` gate and an exact-candidate clean consumer
  gate, followed by the paired Karel compatibility gate;
- a private immutable GitHub release asset, independently downloaded and
  matched to its recorded SHA-256, size, source commit, and release identity;
- Hamilton's pinned asset receipt and clean installation proof.

The repository does not claim npm availability, Rust, bundled Karel behavior,
offline operation, multiple simultaneous embeds, or graphics output. Remote
Debugger.sh, Monaco, clangd, LLVM/WASI, and Python assets remain subject to the
host's reviewed CSP, CORS/CORP, caching, availability, integrity, and privacy
policy; they are not silently converted into bundled release assets.

## Candidate gate

Run `npm ci`, install the pinned Playwright Chromium build, and run
`npm run validate:production`. Inspect `npm pack --dry-run`, run both dependency
audits, audit the candidate's bundled licenses, and pass the packed consumer
against the exact absolute candidate path:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.2.0.tgz \
  npm run test:consumer
```

See [Testing](testing.md) for the behavior and release-evidence matrix.

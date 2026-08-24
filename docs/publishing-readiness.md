# Publishing readiness

The local repository is ready for review and a single initial commit, but it is
not authorized or configured for public distribution.

## Completed locally

- Host-neutral package metadata, ESM export map, declarations, compiled CSS,
  clangd worker emission, and raw C++ test resources.
- Separate exports for host APIs, built-in plugins, browser runtime providers,
  generic/language-specific testing providers, and optional C/C++ language
  tooling.
- Nova consuming only public package exports through a local file dependency.
- Unit/integration tests in dedicated test folders and a production-build
  Playwright regression for Python breakpoints, variables, and stepping.
- Real example and packed-tarball consumer builds without a Nova alias.
- Public panel execution and owner-scoped source-presentation contracts,
  including strict path/position validation, bounded decorations, deterministic
  cleanup, packed-consumer compilation, and production-runtime browser proof.
- Source/dist scans excluding LMS, Firebase, lessons, replay, Karel, absolute
  developer paths, and unresolved `@/` aliases.
- No copied compiler/sysroot archive, Stanford library, Firebase service worker,
  deployment file, or local yowasp tarball.
- `npm audit --omit=dev` and the full `npm audit` currently report no known
  vulnerabilities. The former whole-stdlib polyfill plugin and its vulnerable
  elliptic dependency chain were replaced by the five exact browser shims the
  runtime actually uses, and the production runtime matrix proves those shims.
  Because the library build can bundle code from development-classified inputs,
  continue running both audits before publication rather than relying only on
  `--omit=dev`.

## Decisions required before publication

- Open-source license and confirmation of redistribution rights.
- Final npm name/scope and semantic version.
- GitHub organization/owner, visibility, branch protections, and CI policy.
- npm, Git dependency, or release-tarball distribution strategy.
- Whether Monaco, Debugger.sh, clangd, LLVM/WASI, and toolchain assets remain
  externally hosted or become audited self-hosted release assets.
- CSP, CORS/CORP, caching, uptime, version pinning, and privacy policy for those
  runtime downloads.

Until those decisions are made, keep `private: true`, `license: UNLICENSED`, no
remote, and no releases.

## Pre-publish gate

Run `npm ci`, install the pinned Playwright Chromium build, and run
`npm run validate:production`. Inspect `npm pack --dry-run`, audit the actual
tarball and third-party licenses, test it in a clean browser consumer, and repeat
Nova's unit/build/browser regression pass. Python source debugging and unittest
execution have production-build browser regressions; publication should still
not claim Rust, bundled Karel functionality, offline use, multiple simultaneous
embeds, or working graphics output until each has the required browser-level
tests. The separately maintained Karel
companion has its own real Python browser coverage; that does not make Karel
part of the Web IDE package. See [Testing](testing.md) for the release gate.

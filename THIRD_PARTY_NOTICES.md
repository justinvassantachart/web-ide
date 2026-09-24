# Third-party notices and provenance

The Web IDE source is licensed under MIT. This file records notable provenance.
The package also ships generated `THIRD_PARTY_LICENSES.txt`. For this maintenance
artifact, external evidence records the exact bundle ownership, installed lock,
engine fork identity, filtered current remote assets, and generated license
inventory. The retained historical release generator is not a maintenance receipt.

Notable retained dependencies and source provenance include:

- Debugger.sh — MIT. The exact `0.3.15-webide.legacy.1` fork is distributed as an
  immutable GitHub release asset, not an npm registry release. It contains the
  minimal zero-length stdin-read correction on upstream `0.3.15`, embeds rebuilt
  engine Wasm, and retains the original remote Python/LLVM toolchain URLs.
  `release/maintenance-engine-input.json` records its source and build hashes.
  It retains the upstream MIT license. The immutable engine release additionally
  supplies its Rust-crate license inventory and license texts; these are separate
  release assets, not part of this package’s generated license index.
- Monaco Editor — MIT and its bundled third-party notices.
- `@monaco-editor/react` — MIT.
- VS Code Codicons — CC BY 4.0 for icons/font and MIT-licensed code files.
- Material Icon Theme — MIT; this package bundles only a curated SVG subset.
- xterm.js, XYFlow, React, React DOM, Zustand, Radix UI, and
  react-resizable-panels — MIT-family project licenses as shipped upstream.
- class-variance-authority and memfs — Apache-2.0.
- Lucide — ISC.
- `src/clangd/json-stream.ts` is adapted from clangd-in-browser, MIT.
- VS Code light/dark theme values retained from the MIT-licensed theme defaults
  are covered by the generated source-attribution record and license text.

The remote language toolchain artifacts used by Debugger.sh and optional clangd
are not copied into this repository or tarball. The engine Wasm itself is embedded
in the exact external engine dependency. Their exact reachable runtime
receipts, reviewed source relationships, retained license texts, and known
provenance limitations are recorded under `release/`. Those records support
current remote loading; they do not establish complete binary notice/source
compliance for later self-hosting or redistribution. Rust payloads are not
reachable through the package's supported providers and are not included in
the runtime lock.

Intentionally excluded from this repository: Nova's local yowasp-clang tarball,
`public/sysroot.zip` and backup, Stanford library files, Firebase service worker,
and all deployment/application assets. Their provenance was not needed for this
package and was not assumed.

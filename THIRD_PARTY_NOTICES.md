# Third-party notices and provenance

The Web IDE source is licensed under MIT. This file records notable provenance.
The package ships generated `THIRD_PARTY_LICENSES.txt` from exact bundle,
dependency, and runtime evidence. This 0.4.1 maintenance artifact has a separate
license inventory and verification record; the retained historical 0.4.0
release generator does not certify it.

Notable retained dependencies and source provenance include:

- Debugger.sh — MIT; exact `0.3.15-webide.legacy.1` embeds the engine Wasm
  containing the single empty-stdin-read correction. Source and artifact
  provenance are in `release/maintenance-engine-input.json`; its immutable fork
  release also retains Rust dependency license evidence. Language toolchain
  assets retain their existing remote loading.
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

Remote language/toolchain artifacts used by Debugger.sh and optional clangd
are not copied into this repository or tarball. Their exact reachable runtime
receipts, reviewed source relationships, retained license texts, and known
provenance limitations are recorded under `release/`. Those records support
historical remote loading; the legacy engine CDN record is excluded from the
maintenance inventory because the selected fork embeds that engine. They do
not establish complete binary notice/source
compliance for later self-hosting or redistribution. Rust payloads are not
reachable through the package's supported providers and are not included in
the runtime lock.

Intentionally excluded from this repository: Nova's local yowasp-clang tarball,
`public/sysroot.zip` and backup, Stanford library files, Firebase service worker,
and all deployment/application assets. Their provenance was not needed for this
package and was not assumed.

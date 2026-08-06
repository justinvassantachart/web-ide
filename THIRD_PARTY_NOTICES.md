# Third-party notices and provenance

This file is an audit aid, not a substitute for the license texts shipped by
dependencies. Before public distribution, generate a full production dependency
license report and have the intended project license reviewed.

Notable retained dependencies and source provenance include:

- Debugger.sh — MIT; dynamically loads its engine and language toolchain assets.
- Monaco Editor — MIT and its bundled third-party notices.
- `@monaco-editor/react` — MIT.
- VS Code Codicons — CC BY 4.0 for icons/font and MIT-licensed code files.
- Material Icon Theme — MIT; this package bundles only a curated SVG subset.
- xterm.js, XYFlow, React, React DOM, Zustand, Radix UI, and
  react-resizable-panels — MIT-family project licenses as shipped upstream.
- class-variance-authority and memfs — Apache-2.0.
- Lucide — ISC.
- `src/clangd/json-stream.ts` is adapted from clangd-in-browser, MIT.
- VS Code light/dark theme values and interaction conventions are identified in
  source comments; verify any required attribution before redistribution.

Remote WebAssembly/toolchain artifacts used by Debugger.sh and optional clangd
are not copied into this repository. LLVM, Clang, WASI, Python, Rust, and any
transitive binary notices must be audited if those assets are later self-hosted
or redistributed.

Intentionally excluded from this repository: Nova's local yowasp-clang tarball,
`public/sysroot.zip` and backup, Stanford library files, Firebase service worker,
and all deployment/application assets. Their provenance was not needed for this
package and was not assumed.

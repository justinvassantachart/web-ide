# Third-party notices and provenance

The Web IDE source is licensed under MIT. This file records notable provenance.
The package also ships generated `THIRD_PARTY_LICENSES.txt`; final candidate
generation compares that file byte-for-byte with license evidence derived
inside both exact isolated installs. The external release-evidence directory
contains the canonical machine inventory and candidate-digest-bound CycloneDX
SBOM.

Notable retained dependencies and source provenance include:

- Debugger.sh — MIT; dynamically loads its language toolchain assets. Web IDE
  0.5.0 pins one exact immutable public fork release asset instead of the
  upstream npm release; `release/engine-fork-input.json` records that exact fork
  input, including the engine WebAssembly the fork embeds in its module rather
  than downloading. The package keeps its top-level MIT license and still does
  not ship a generated license inventory for the Rust crates compiled into that
  embedded engine WebAssembly. Its C++ exception-handling objects are compiled
  into the same WebAssembly and are also shipped as
  `assets/cpp-exceptions/runtime.tar.gz` inside the installed engine package;
  the libc++abi and libunwind license texts, notice, and provenance for those
  objects travel inside that archive under `share/licenses/cpp-exceptions/`
  rather than in this repository's generated inventory.
- Monaco Editor — MIT and its bundled third-party notices.
- `@monaco-editor/react` — MIT.
- VS Code Codicons — CC BY 4.0 for icons/font and MIT-licensed code files.
- Material Icon Theme — MIT; this package bundles only a curated SVG subset.
- xterm.js, XYFlow, React, React DOM, Zustand, Radix UI, and
  react-resizable-panels — MIT-family project licenses as shipped upstream.
- `react-remove-scroll-bar@2.3.8` declares MIT in its package metadata but omits
  the license file from its npm archive. Its supplemental text is copied without
  modification from upstream commit
  [`7301c160fda44cb8cf2b9fdfde61efad35736196`](https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE),
  retained at `release/licenses/react-remove-scroll-bar-7301c160-LICENSE.txt`
  (SHA-256 `a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84`).
  The explicit license-policy entry includes this text in the generated package
  inventory; it does not waive license evidence for other dependencies.
- class-variance-authority and memfs — Apache-2.0.
- Lucide — ISC.
- `src/clangd/json-stream.ts` is adapted from clangd-in-browser, MIT.
- VS Code light/dark theme values retained from the MIT-licensed theme defaults
  are covered by the generated source-attribution record and license text.

Remote WebAssembly/toolchain artifacts used by Debugger.sh and optional clangd
are not copied into this repository or tarball. Their exact reachable runtime
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

# Release ownership

This repository owns the source **and** the release channel for the `web-ide`
package. Releases were previously published to the private
`justinvassantachart/ths-ide` repository, which is the THS/Hamilton
application and does not own this package. They were rehomed here on
2026-09-16.

This file is not part of the published package: `package.json` `files` lists
only `dist`, `docs`, `README.md`, `LICENSE.md`, `THIRD_PARTY_LICENSES.txt` and
`THIRD_PARTY_NOTICES.md`, so adding it does not change any release artifact.

## Canonical releases

| Version | Canonical release | Package download |
| --- | --- | --- |
| 0.6.0 | [`web-ide-v0.6.0`](https://github.com/justinvassantachart/web-ide/releases/tag/web-ide-v0.6.0) | [`web-ide-0.6.0.tgz`](https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.6.0/web-ide-0.6.0.tgz) |
| 0.5.0 | [`web-ide-v0.5.0`](https://github.com/justinvassantachart/web-ide/releases/tag/web-ide-v0.5.0) | `https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.5.0/web-ide-0.5.0.tgz` |

`web-ide-0.6.0.tgz` — 603,744 bytes, SHA-256
`a9e154d154f7903a0b1a13d89d92c3f38d1407dc9c1597baf48b7cad85671653`, SHA-512
integrity
`sha512-NZyMBiJgo0sJIP3VcDIAciEb+sM9UzoBqkc2RXOSWu27GyHappd/PXIso21Zpk8a+l7aacV6Qt6GO+G1aYd5ew==`.
Built from source commit `b030dade955b21873f83cea3ce82d5006ce7c265`, annotated
source tag [`web-ide-v0.6.0-source`](https://github.com/justinvassantachart/web-ide/tree/web-ide-v0.6.0-source).

The four source-bound gates passed: `npm run validate:production`, the packed
consumer check against the exact candidate, `npm audit --omit=dev`, and
`npm audit`. The finalizer independently reproduced the source archive, package,
bundle provenance and license evidence. All 18 published assets were downloaded
again and matched the finalized bytes; GitHub reports the release immutable,
and `gh release verify` passed its release attestation. The
[published artifact manifest](https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.6.0/artifact-manifest.json)
and [validation summary](https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.6.0/validation-summary.json)
record the exact source, inventory and gate receipts. Public evidence contains
no private companion gate output; consuming applications retain their separate
composition evidence.

`web-ide-0.5.0.tgz` — 600,749 bytes, SHA-256
`dffa2c1293d2014832f855fcb3d183f865ea1ea74c58fc6666026a92a04ff84d`, SHA-512
integrity
`sha512-4K1lmDYKhj8jRD7syRsUT9i68xZUGpc9rgEy+sVmk3S0astKSQlxXogTgz/CwyRFVBkLrSqFTVE68rB/OBVJJw==`.
Built from source commit `9d7700e527005306a35bb15dd1e348044882dc5b`, source tag
`web-ide-v0.5.0-source`.

The 0.5.0 release here is a byte-exact mirror of the original
`ths-ide` `web-ide-v0.5.0` release. That original is retained, immutable and
still resolvable, so previously pinned URLs keep working. Its evidence was
generated against the `ths-ide` channel — see the mirror's release notes.

## Releases deliberately **not** rehomed

`web-ide-v0.2.0`, `web-ide-v0.3.0`, `web-ide-v0.3.1` and `web-ide-v0.4.0`
remain **only** in the private `ths-ide` repository. Each of their
`artifact-manifest.json` files hash-binds an evidence entry
`validation-log:karel-compatibility:0` whose asset `karel-compatibility.log` is
the private `@web-ide/karel` gate output. It contains that private package's
tarball digests, its source commit, its internal script paths, its Playwright
test titles and its production screenshot hashes.

Mirroring those asset sets verbatim into this **public** repository would
disclose private companion internals. Dropping the asset is equally
unacceptable: the manifest binds its digest, so a redacted copy would be a
release that fails its own evidence-closure check. 0.5.0 is unaffected because
its release profile removed that external Karel gate entirely — it has 14
evidence entries and no Karel entry.

Those four releases stay reachable at
`https://github.com/justinvassantachart/ths-ide/releases/tag/<tag>`. The live
Hamilton application additionally pins `web-ide` 0.3.1 from that repository by
design, so those URLs must not be retired.

## Current release configuration

Web IDE `0.7.1` is the prepared patch to the published `0.7.0` release;
publication is not established by this source change. Its version-specific
configuration, manifest schema, evidence tools and fixtures name the public
canonical `justinvassantachart/web-ide` channel with mechanism
`public-github-release-asset`, source tag `web-ide-v0.7.1-source-r3`, release tag
`web-ide-v0.7.1`, and asset `web-ide-0.7.1.tgz`.

The patch preserves the shared C++/Python Testing V2 provider and session API,
terminal behavior, and independent workbench instances from `0.7.0`. It adds
optional initial breakpoints, graph layout improvements, native clangd symbol
rename, and a bounded opt-in PCH rejection fallback for Debug compilation.
Rename applies only edits returned by clangd; open relevant source/header files
once per session so clangd can index them before renaming.

The runtime composition identity remains `cs106b.source/2`; the engine remains
`debugger-sh@0.3.15-webide.0.5.0.2`, which contains the separately reviewed
empty-stdin-read correction in [engine PR 1](https://github.com/justinvassantachart/engine/pull/1).
Existing published release assets, source tags and manifests remain immutable.
The unpublished `web-ide-v0.7.1-source` and `web-ide-v0.7.1-source-r2` checkpoints
are retained: the first exposed a clangd bootstrap ordering defect, and the
second exposed a packed-viewer launcher pinned to the previous package filename.
The current checkpoint derives that filename from validated npm pack output
and settles native visibility and initial layout before lifecycle assertions.

The four local gates, finalizer and immutable download verification in
[Publishing readiness](docs/publishing-readiness.md) must bind the final `0.7.1`
candidate before publication. Historical release evidence remains bound to its
original bytes. Each consuming application must verify its own exact package
composition. The npm manifest remains `private: true`; no npm publication is
configured.

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
| 0.5.0 | [`web-ide-v0.5.0`](https://github.com/justinvassantachart/web-ide/releases/tag/web-ide-v0.5.0) | `https://github.com/justinvassantachart/web-ide/releases/download/web-ide-v0.5.0/web-ide-0.5.0.tgz` |

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

The next release is Web IDE `0.6.0`. Its version-specific configuration,
manifest schema, evidence tools and fixtures name the public canonical
`justinvassantachart/web-ide` channel with mechanism
`public-github-release-asset`, source tag `web-ide-v0.6.0-source`, release tag
`web-ide-v0.6.0`, and asset `web-ide-0.6.0.tgz`.

The minor version records the terminal's new bottom panel beneath the editor
and the corresponding initial-layout contract. The exact engine successor
`debugger-sh@0.3.15-webide.0.5.0.2` contains the separately reviewed five-line
empty-stdin-read correction in [engine PR 1](https://github.com/justinvassantachart/engine/pull/1).
It retains the preceding engine source apart from that correction, regression
coverage and release metadata. Existing published release assets, source tags and manifests
remain immutable. The `0.5.0` source tag retains tooling for validating its
original release identity and channel.

This configuration is preparation, not evidence of publication. Complete the
four local gates and finalizer in
[Publishing readiness](docs/publishing-readiness.md), then verify the immutable
release downloads and each consuming application's exact package composition
before recording `0.6.0` as a canonical published release above. The npm
manifest remains `private: true`; no npm publication is configured.

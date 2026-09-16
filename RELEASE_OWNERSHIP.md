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

## Release configuration is still pinned to the old channel — on purpose

`release/release-input.json` (`releaseRepository`),
`release/schemas/artifact-manifest.schema.json` and
`scripts/release/artifact-manifest.mjs` (`mechanism:
'private-github-release-asset'`) all still name the `ths-ide` channel.

**Do not "fix" them in isolation.** Those values are pinned per release
version — the schema hard-codes `intendedTag: "web-ide-v0.5.0"` and
`fileName: "web-ide-0.5.0.tgz"` — and they correctly describe the 0.5.0
artifact **as it was actually published**. Changing them without cutting a new
version would make this repository's own tooling reject the 0.5.0
`artifact-manifest.json` it already published.

### Checklist for the next release

Update these together, as part of the version bump, so the next release
publishes to this repository:

1. `release/release-input.json` — set `releaseRepository` to
   `justinvassantachart/web-ide` along with the new `package`, `releaseTag`,
   `sourceTag` and asset filenames.
2. `release/schemas/artifact-manifest.schema.json` — update the
   `distribution.repository`, `intendedTag` and `intendedAssetFilename` consts,
   and the `mechanism` const if the channel is public.
3. `scripts/release/artifact-manifest.mjs` — the `mechanism` literal appears
   twice (generator and validator); both must change together if the channel
   becomes public. Consider `public-github-release-asset`.
4. `tests/release/release-evidence.test.mjs` — update the `releaseRepository`
   fixture.
5. `docs/publishing-readiness.md` — it currently states the distribution path
   is "an immutable release in the owner's private `ths-ide` release
   repository". Note that `docs/` **is** packaged, so editing it changes the
   package bytes and therefore belongs to a version bump, never to a
   standalone edit.

Then run the normal four local gates and the finalizer described in
`docs/publishing-readiness.md`. Nothing in this migration bypassed or re-ran
any release gate.

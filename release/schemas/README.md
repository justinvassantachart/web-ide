# Pinned release schemas

These schemas are build-time validation inputs. They were reviewed on
2026-08-24 from CycloneDX `specification` commit
`e02a34ae42a48239f54e04f75280b9000b29f1fb`:

- `cyclonedx-1.6.schema.json` comes from
  `schema/bom-1.6.schema.json`; it is JSON-minified with one trailing newline
  and has SHA-256
  `bf8177eee4e8979f2ef15dd131f0ef55eaa2168382b5f888ff8a6d1c7e4d09b3`.
- `cyclonedx-spdx.schema.json` comes from `schema/spdx.schema.json`; it is
  JSON-minified with one trailing newline and has SHA-256
  `9688c076891e4147cfe978d5fa3196c740b1ff79b25b146d94178a3db6066180`.
- `cyclonedx-jsf-0.82.schema.json` comes from
  `schema/jsf-0.82.schema.json`; its retained upstream bytes have SHA-256
  `8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae`.

The immutable upstream base URL is
`https://raw.githubusercontent.com/CycloneDX/specification/e02a34ae42a48239f54e04f75280b9000b29f1fb/schema/`.
CycloneDX publishes these schemas under Apache-2.0. Complete Apache-2.0 terms
are retained in this repository under `release/licenses/` and in the generated
`THIRD_PARTY_LICENSES.txt`. The schemas are not part of the Web IDE npm pack;
they validate the external release SBOM.

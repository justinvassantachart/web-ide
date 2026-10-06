# Python host byte device

Decision: Accepted on 2026-10-06 under the owner’s explicit student AI and
Python graphics implementation request. This is an additive language extension
to the existing public byte-device contract, not a new service protocol.

The built-in C/C++ and Python providers permit one idle
`RuntimeSession.registerHostDevice` registration. The cumulative owner engine
fork exposes its existing `/dev/debugger-sh-host` device to both languages.
Hosts and companions own framing, routes, graphics, authentication, credentials,
quotas, and external services. Web IDE transports bytes and preserves per-run
cleanup. It does not enable `hostChannels` or `registerRuntimeHostService`, and
no engine RPC, Python helper, or Hamilton policy belongs in this package.

Version 0.7.3 retains the current main branch’s compiler/editor changes and
consumes only the new exact cumulative engine artifact. Historical artifacts
and host capability pins remain unchanged. The engine fork must retain its
C++ exception, precompiled-input, packaging, and stdin fixes.

Verification includes the identical lifecycle suite for both providers, public
consumer types, production-built byte exchange with independent stdin, debug,
Stop/restart, two instances, disposal, and omitted-device behavior. Downstream
AI or graphics claims require the host/companion’s separate evidence.

## Release dependency review

Accepted on 2026-10-06 under the current implementation authorization after the
required full audit found new advisories in the pre-existing dependency graph.
The production-only audit was clear, but build-classified packages can enter the
bundle and therefore are not exempt from the release gate.

Update DOMPurify to exact 3.4.16 for GHSA-p98j-92pf-mc4p and
GHSA-6688-9rhm-gjv2. Resolve `brace-expansion`, `fast-uri`, and `source-map-js`
to patched releases within their existing dependency ranges. `sprintf-js`
(GHSA-hp3w-g68c-fv3c) has no patched version: update exact `vite-plugin-dts`
from 4.5.4 to 5.1.2, whose maintained implementation makes API Extractor optional.
This package emits individual declarations and does not request bundled types,
so the unused API Extractor/argparse/sprintf chain is removed instead of
forcing an incompatible parser override. The plugin import and declaration
configuration remain unchanged. The plugin is MIT and DOMPurify retains its
MPL-2.0-or-Apache-2.0 license; neither introduces install scripts or a runtime
network service. Declaration inventory/type checks, exact license generation,
packed-consumer validation, production browser checks, and both audits remain
required before release. No broad audit fix or toolchain replacement is selected.

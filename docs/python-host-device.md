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

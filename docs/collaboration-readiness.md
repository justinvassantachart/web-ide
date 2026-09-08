# Collaboration-ready workspace boundary

**Status:** Implemented foundation; integration and release approval remain
separate. This document defines the compatibility boundary implemented by the
workbench; it does not add a collaboration transport or user interface.

## Decision

Every `WebIDE` mount creates one workbench instance. That instance owns its
workspace controller, in-memory volume, editor/files/debug/execution/compiler/
testing stores, change subscriptions, host-persistence attachment, runtime
session, and Monaco URI authority. Two mounts may therefore use the same public
path, such as `/workspace/main.cpp`, concurrently in one JavaScript realm
without selecting a global active workspace.

The workspace controller is the sole editable-workspace mutation owner. Local
editor writes and Explorer create/delete/rename actions, bootstrap and restore
replacement, provider replacement, and external authoritative transactions all
pass through that controller. A transaction is validated and applied to a
candidate snapshot before the controller swaps the instance volume, reconciles
the instance stores, advances its monotonic revision, and emits one change.
Failed transactions do not partially mutate the live workspace.

The public instance handle exposes only canonical `/workspace/*` snapshots, a
read-only revisioned change feed, and an external-application method. External
transactions retain their caller-supplied transaction ID, source, and optional
echo token so a provider can suppress feedback. The method accepts only an
`external-authority` origin and validates the same paths, text, operation
limits, expected revision, and optional content digests used by the internal
controller. It exposes no Monaco, memfs, Zustand, or React object.

Read-only and optional mutation policies govern local-user actions. They do not
block a validated authoritative external transaction. Bootstrap, restore, and
provider replacement also have distinct origins rather than masquerading as a
local edit.

Public paths stay canonical for host callbacks, persistence, diagnostics,
runtime plans, and testing. Monaco model URIs use a mount-specific authority;
providers receive a narrow namespace translator and may not enumerate or
dispose models owned by another mount.

Full-snapshot host persistence remains the default compatible behavior. One
coordinator attaches to one workspace feed and can be replaced with the host
workspace configuration. A replacement is immediately seeded from the current
full snapshot; late status from the retired adapter cannot overwrite the new
binding. Save failures retain the newest snapshot for a later retry; explicit
flush and close remain retryable. Its status feed is additive and extensible.
Connection and presence state belong to a future provider and must not be
encoded as persistence status.

A change to the host workspace ID is a hard instance boundary even when the
outer React mount is retained. The old controller and its persistence/runtime/
tooling resources drain only to the old namespace, while a new controller is
created for the new ID. The new persistence adapter is not attached or seeded
until that controller's exact bootstrap or browser-local restore completes.
Changing only the persistence adapter for the same workspace ID retains the
existing controller and preserves immediate full-snapshot replacement seeding.

Provider-supplied editor support under `/workspace/*` is fallback-only for
language tooling. A canonical workspace file at the same path is authoritative,
whether created locally or by external application. If refreshing optional
provider inputs fails after clangd boots, feed synchronization still reconciles
all canonical C/C++ paths and removes deleted workspace-owned paths rather than
leaving stale provider text at the committed revision.

Directories are projections of canonical text-file paths, not independently
persisted entities. Empty-folder creation is unavailable; rename and delete of
a nonempty projected directory lower to one atomic transaction containing its
file operations. This avoids unversioned directory markers outside the public
transaction vocabulary.

## Lifecycle and proof

Unmount removes each instance subscription, disposes its runtime/plugin/
language-tooling resources, drains browser-local writes, and disposes its host
persistence coordinator. React StrictMode's development replay reuses the
same mount binding and the deferred cleanup is cancelled, so the real unmount
closes the coordinator exactly once.

The executable contract is covered by:

- `tests/contracts/web-ide-instance-isolation.test.tsx` for two simultaneous
  real workbench mounts in one realm, overlapping paths, editor/Monaco,
  panels, clangd, focus-scoped hotkeys, independent stores/breakpoints/feeds/
  persistence, unmount-one/retain-one, mounted Testing V2, replacement-adapter
  failure isolation, delayed workspace-identity restoration, and StrictMode
  cleanup;
- `tests/contracts/workspace-controller.test.ts` for atomicity, emit-once,
  reentrant revision ordering, external origin/echo identity, complete
  plain-data validation, read-only separation, directory lowering, and
  throwing-observer isolation;
- `tests/testing/testing-controller-v2.test.ts` and
  `tests/contracts/configurable-clangd.test.ts` for invalidation after a
  remote-like transaction through the shared feed, workspace-authoritative
  local/external support-file creation, and provider-refresh error containment;
- `tests/contracts/workspace-persistence.test.ts` for coalescing, retryable
  flush/close, latest-snapshot retention, status, and disposal behavior;
- `tests/contracts/browser-runtime-session-lifecycle.test.ts` for configured,
  unsupported, concurrent-instance, deferred-unregister, and session-close
  host-service lifecycles.

## Explicit exclusions

This boundary contains no synchronization library, networking, global
workspace switch, iframe isolation, identity model, awareness/presence
protocol, collaboration UI, or course-specific behavior. A future optional
provider must consume the public transaction/feed surface and must not reach
into editor models, stores, or the in-memory filesystem.

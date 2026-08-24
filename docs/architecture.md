# Architecture

## Dependency direction

```text
consuming application (Nova or another host)
  -> WebIDEHostProvider + WebIDEConfiguration
  -> host-created and optional packaged IDEPlugin values
  -> WebIDE
       -> per-composition contribution registries
       -> per-mount RuntimeSession
       -> workbench UI
       -> workspace bootstrap and host persistence facade
```

The dependency direction is one way. Web IDE contains no router, Firebase,
authentication, LMS, assignment, lesson, replay, or Karel implementation. Nova
is the first consumer and owns all of those concerns.

Release tooling is a source/distribution trust boundary, not runtime product
code. It is activated in Vite only by an absolute external provenance-output
path, executes in clean isolated installs with a scrubbed environment, and
keeps generated evidence outside the repository. It derives ownership from the
actual Rollup module graph plus `package-lock.json`, validates packed bytes
without extracting them, and binds exact source/tag, runtime receipts, SBOM,
licenses, machine-receipted gate logs, and package inventory in one
deterministic manifest. Each local gate first completes one bounded temporary
log, then replaces the known repository, home, candidate, and temporary roots
and their reviewed file/percent encodings with stable explicit placeholders.
Replacement requires boundaries on both sides; residual local path forms,
embedded placeholders, ANSI-obscured secret-like text, or any changed/nonfinal
receipt footer fail closed. Publication pins the captured and normalized file
identities plus their owner-controlled, non-writable-by-others directory, uses
a no-clobber hard link, and verifies the exact linked inode before removing
owned temporary names. Candidate
creation and finalization stage complete
file sets beside the external target, reserve the target name exclusively,
pin the staging-directory inode through checked quarantine cleanup, keep the
target reservation nonempty while moving each regular file, verify both
identities, revalidate source and inventory immediately before close, remove
the sentinel, re-hash the closed set, and write the deterministic adjacent
completion marker as the final publication action. The marker is outside the
exact candidate/final artifact directory. Replacement compares the prior
directory's complete inventory around backup and retains the prior directory
at a named recovery path if publication cannot complete;
finalization independently rebuilds and reparses the candidate before closure.
The package remains private and is not published to npm; Hamilton consumes only
the independently verified immutable private-release tarball.

## Stable contracts

`RuntimeProvider` selects and lazily creates a session per mount.
`RuntimeSession` owns prepare/start/stop/debug operations and typed event
channels. Its execution mode is only `run` or `debug`; runtime implementations
do not receive workbench stores or know about a test framework. The additive
settlement methods let capable providers expose one awaited `completed`,
`stopped`, or `error` outcome for each start while legacy void stop/dispose and
numeric exit events remain compatible.

Each mounted runtime owns one run-pipeline coordinator shared by the workbench's
toolbar, panels, and hotkeys. Stop and restart invalidate pending test-provider
or runtime preparation, await that pipeline's cancellation cleanup, and
re-check the coordinator generation after asynchronous and re-entrant host
boundaries. A cancelled preparation cannot start a late runtime after stop has
already reported settlement.

The optional transient-breakpoint overlay API is the generic boundary for a
workflow that must add temporary debug stops without taking ownership of the
editor gutter. Each contribution is keyed by an object-identity token scoped to
one session. Replacement and clearing are atomic: browser providers normalize
workspace paths and one-based lines, merge editor breakpoints with every owner,
and apply the provider's byte quota to that complete candidate before changing
state. Adapter validation updates only editor-owned lines, so overlay-only
stops remain invisible to the editor event stream. Owners clear their overlay
when their workflow settles or unmounts; session disposal clears every owner,
and adapter reset/empty-set handling removes stale backend breakpoints. Custom
providers may omit the two methods, preserving the existing session contract.

`LanguageToolingProvider` is an independent optional selection. Its component
publishes a provider-neutral editor service through the public callback prop,
may lazily start on file engagement, and owns backend/Monaco cleanup. The
workbench owns the internal context and resets it when the provider unmounts;
custom providers never import internal React state. With no selected provider,
the default service is disabled and safe. File-extension mapping for Monaco
and status labels is core-owned and currently covers C/C++ and Python. Explicit
tooling selections must overlap the selected runtime's language IDs.

`TestProvider` is a separate language/framework contribution. Its preparation
hook runs for ordinary executions when a language needs ephemeral support files
and receives `executeTests: true` only for the Tests workflow. A test execution
returns a copied `RuntimeExecutionPlan` and per-run `TestOutputParser`. The
workbench attaches a provider-neutral stream interceptor that filters framed
control output and dispatches structured `TestEvent` values before the runtime
publishes its exit event. Generated files never enter the workspace or its
persistence layer.

`WebIDEHost` supplies workspace identity, seed files, local-cache policy,
read-only policy, persistence callbacks, chrome choices, and typed event sinks.
The workbench does not import a database or host SDK.

`IDEPlugin` has declarative activity, command, panel, workspace-resource,
runtime-provider, test-provider, and language-tooling-provider contributions.
`activate` receives scoped registrars and the selected runtime facade. Every
registered callback/listener/disposable is released on deactivation; static
registrations are released when the manager is disposed.

Workspace resources have two generic planes. The default `/workspace` plane
seeds the editable VFS and is eligible for host persistence. The
`execution-only` plane is normalized to `/sysroot`, copied into a runtime plan
after test-provider preparation, and never enters the VFS. A synchronous
execution-only snapshot callback may supply current bytes exactly once per
prepare. The boundary rejects traversal, invalid bytes, exact plan overlap, and
flattened cross-plane collisions. It prevents accidental editing/persistence;
it does not claim secrecy from code executing in the browser.

`IDEPanelServices` is the shared public component facade for panels and sidebar
activities: selected runtime, the same instance-bound execution pipeline used
by commands, one automatically revoked source-presentation owner, immutable
workspace snapshot, and panel reveal. It intentionally contains no React
context implementation, Monaco object, owner identifier, or Zustand handle.
Source presentation accepts only canonical current visible `/workspace` files,
valid one-based bounds, and `current`/`historical`/`error` decorations. It
prunes invalidated paths after workspace mutations and clears every owner's
Monaco decorations on owner/editor/workspace disposal. Panel visibility may be
gated by the same immutable workbench snapshot used by commands. The packaged
Variables and Graph panels therefore disappear for a run-only runtime rather
than presenting impossible debugging affordances.

`WebIDEConfiguration.initialLayout` is the narrow host-owned initial
presentation boundary. Its exact contributed-panel ID is validated before a
usable workbench commit, and its bounded panel-column and panel-content
percentages feed the existing resizable groups. A small controller owns panel
selection per mounted `WebIDE`; commands, tests, activities, the public
instance snapshot, and accessible tabs use that controller instead of the
execution store. The controller has no storage, synchronization, theme, or
application-specific policy. This isolation applies to layout state only and
does not change the known single-workbench-per-realm VFS/store boundary.

Web IDE pins the loader runtime to Monaco `0.56.0`, matching its reviewed
editor API/types dependency. The React wrapper's module-global, path-keyed
view-state cache is disabled: Monaco models retain content and undo state per
IDE instance, while debug/source reveal requests own navigation without cross-
instance view state or canceled restore work.

`WebIDEInstanceHandle` is a per-mount host integration seam for snapshots,
subscriptions, ensuring files are open, resetting a session, projecting only
persistable workspace files, and awaiting flush/close. Explicit close disposes
the host persistence adapter only after save and flush succeed; failures remain
retryable. Consuming applications use this handle instead of importing package
state.

## Built-ins and optional pieces

The package root owns the workbench and contracts. Optional subpaths expose:

- core debug panels and run/debug/stop commands;
- the Canvas panel surface;
- the generic Tests panel/command;
- the C/C++ and Python browser runtime providers;
- the C++ compatibility and Python `unittest` testing providers;
- the optional C/C++ clangd language tooling provider.

`web-ide/runtimes` is runtime-only. The generic UI and both language test
providers are exported canonically from `web-ide/testing`; `web-ide/plugins`
retains the UI export only as a compatibility alias.
The clangd implementation is exported only from `web-ide/language-tools`, so
the package root and runtime/testing subpaths do not eagerly import its worker.

Canvas consumes the typed graphics channel. The current C++ runtime declares
`graphics: false`; the existing panel remains available, but graphics output is
not claimed complete.

## Karel boundary

There is no Karel code, asset, world, event parser, or package in this
repository. The local sibling `web-ide-karel` repository is a separate
companion library that depends on Web IDE. It owns its Python library, panel,
world resources, framed events, and cleanup while deliberately providing no
interpreter. A host registers it alongside any Python runtime provider exactly
as it can register its own activity plugin, and may omit or replace either
piece independently.

The public runtime names remain provider/session oriented. Packaged providers
may wrap a third-party execution library internally, but neither plugins nor
hosts depend on that library's object model. This intermediary is what lets a
host substitute another local engine or remote service without changing the
workbench, testing providers, or Karel companion.

## Known extraction boundary

This is a behavior-preserving first package, not the final multi-package split.
Runtime/plugin manager instances are isolated, while VFS and UI stores remain
module singletons. The supported topology is therefore one workbench per realm.
Before stable 1.0, move those services behind an instance context. The C++
language tooling/runtime/testing implementations have separate opt-in subpaths
but are not yet independently versioned packages.

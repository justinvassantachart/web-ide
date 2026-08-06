# Nova integration and migration

Nova consumes this repository as an ordinary local package. Its host
configuration imports `WebIDE` and public types from `web-ide`, the C++ runtime
provider from `web-ide/runtimes`, the C++ provider and generic Tests UI from
`web-ide/testing`, the optional clangd provider from `web-ide/language-tools`,
and selected built-ins from `web-ide/plugins`. Nova explicitly selects
`web-ide.testing.cpp` and `web-ide.language-tooling.cpp`; generic workbench UI
has no C++ protocol, source-transform, or clangd knowledge.

Nova itself supplies `nova.assignment-activity`. That plugin owns the Assignment
view and its LMS context. Assignment, Firebase, routing, lessons, replay, and
authentication remain entirely in Nova.

Guided lessons hold a `WebIDEInstanceHandle` ref. They observe immutable public
snapshots and request intent-level open/reset actions. They no longer import IDE
stores, VFS, debugger, or test modules.

## Local link workflow

For sibling clones:

1. Run `npm install && npm run build:library` in `web-ide`.
2. Add `"web-ide": "file:../web-ide"` to Nova.
3. Add React/ReactDOM deduplication to Nova's Vite resolver.
4. Import `web-ide/styles.css` once at application startup.
5. Run validation in both repositories.

The Codex worktree cannot use `file:../web-ide` because its physical location is
under `.codex/worktrees`. Its uncommitted Nova manifest therefore points to the
absolute local repository path. Replace that value with the chosen registry,
Git, tarball, or portable sibling dependency before committing Nova integration.

## Next migration stages

1. Instance-scope VFS, Monaco model ownership, and all UI stores.
2. Decide whether the provider-owned C++ clangd/runtime/testing subpaths should
   become independently installable language packages.
3. Add a Rust provider independently. Python source debugging, imported-module
   stepping, and unittest execution are covered in Web IDE's production browser
   suite.
4. Move any future graphics implementation behind a runtime/plugin package.
5. Review, license, and eventually publish the existing sibling Karel companion
   independently; do not copy it into this repository or Nova's LMS layer.
6. Choose package/repository license, visibility, name/scope, and asset hosting.

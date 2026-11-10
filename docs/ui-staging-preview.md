# UI staging preview

`0.10.2-ui.0` is a branch-built prerelease for review in a consuming application's
staging environment. It does not replace a stable release and is not a canonical
release candidate from the strict main-only release pipeline. Historical release
configuration and immutable tags remain unchanged.

Hosts can synchronize their palette without importing workbench internals:

```tsx
<WebIDE configuration={{ ...configuration, brand: false, theme,
  onThemeChange: setTheme, responsive: { breakpoint: 900 } }} />
```

`theme` is controlled; update it after `onThemeChange`. Omitting it retains the
persisted IDE preference. These presentation updates preserve the mounted
workspace/runtime when the existing plugin and initial-layout identities remain
stable. Below the container breakpoint, Workspace, Code and Output views occupy
one full column while the editor, terminal and output remain mounted. Set
`responsive: false` to keep the existing desktop composition.

`SourceEditor` is a standalone controlled authoring field without a runtime:

```tsx
<SourceEditor value={starter} onChange={setStarter} language="python"
  ariaLabel="Assignment starter code" theme={theme} height={320} />
```

It also accepts `readOnly`. Import the public stylesheet once. Workbench resets
and utility rules are now compiled with selectors confined to `.web-ide-root`;
host headings and form defaults retain their own styles. Hosting examples set
their own document margin/height explicitly.

Manage and Explorer menus support keyboard invocation, directional navigation,
activation and focus return. File operations show visible errors; deletion has
an Undo action until dismissed or replaced by another deletion. Undo never
overwrites a file that has since reused the deleted path. The Explorer is live,
so its previously inert refresh button has been removed.

The preview is validated with unit/contract tests, production-built Chromium
journeys, type checking, linting and library builds. Its release notes and
staging manifest record exact source and package hashes. Stable-release
publication and approval for production remain separate.

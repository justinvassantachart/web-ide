# web-ide guides

Use web-ide to edit, run, and debug C++ in a browser, or import its React IDE
component into your own application.

- [Teaching with web-ide](teaching.md): try a debugging activity, use the ten
  hosted lessons, and prepare classroom assignments.
- [Import IDE component](import-ide-component.md): install the released package,
  configure a React application, and connect workspace saving.
- [Self-hosting](self-hosting.md): build and deploy the standalone example with
  the browser headers required by the compiler and debugger.

The [current interactive demo](https://deploy-preview-16--nova-ide.netlify.app) is a deploy preview with an editable
linked-list workspace and a guided debugger tour. The existing
[hosted website](https://webide.org) provides lessons and the classroom interface.
This repository provides the reusable IDE component and runnable examples;
accounts, lessons, and assignment management are application features outside
the component.

For developers, see [Architecture](architecture.md), [Testing](testing.md),
[the API overview](../README.md#package-surface), and
[release verification](publishing-readiness.md). Published packages and their
checksums are available in [Releases](https://github.com/justinvassantachart/web-ide/releases).

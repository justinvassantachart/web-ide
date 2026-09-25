# Self-hosting web-ide

This repository contains the React IDE component and runnable example
applications. You can serve the C++ example as a static website; compilation and
debugging run in the browser, so no compilation server is required.

The ten lessons and classroom account interface at [webide.org](https://webide.org)
are features of that hosted application. Cloning this component repository
provides the examples described below, not those application routes. To build
course features into your own site, use [Import IDE component](import-ide-component.md)
and supply your own content, authentication, and storage.

## Run the example locally

Use Node.js `^20.19.0` or `>=22.12.0` and the pinned npm `11.6.2`, as
specified in [`package.json`](../package.json). The command below runs that npm
version without changing your global installation.

```sh
git clone https://github.com/justinvassantachart/web-ide.git
cd web-ide
npx --yes npm@11.6.2 ci
npm run dev
```

Open the local address printed by Vite and append `?runtime=cpp` to select C++.
The example defaults to Python when that query parameter is absent. Set a
breakpoint beside an executable line, click **Debug**, then step through the
example. The example uses an in-memory workspace that resets on page reload.

`npm run dev` builds the library before starting the example. When editing the
library itself, run `npm run build:library` again or use `npx vite build --watch`
in a second terminal so the example receives the updated library.

## Build a static site

From the repository root:

```sh
npm run build:library
npm run build:example
npm --workspace @web-ide/basic-example run preview
```

The website output is `examples/basic/dist/`. The root `dist/` contains the
library package, not a deployable website. The checked-in
[example Vite configuration](../examples/basic/vite.config.ts) supplies the
required browser headers during local development and preview.

To change the default language, starter files, or selected plugins, edit
[`examples/basic/src/main.tsx`](../examples/basic/src/main.tsx). For your own React
site, follow the [component import guide](import-ide-component.md) instead of
copying internal workbench modules.

## Deploy to Netlify

Import a fork or checkout of this repository into Netlify. Use the repository
root as the base directory and these settings:

| Setting | Value |
| --- | --- |
| Build command | `npm run build:library && npm run build:example` |
| Publish directory | `examples/basic/dist` |
| Node version | A version satisfying the package's Node requirement |
| npm version | `11.6.2` |

Add a `netlify.toml` at the repository root with the build settings and headers:

```toml
[build]
  command = "npm run build:library && npm run build:example"
  publish = "examples/basic/dist"

[build.environment]
  NPM_VERSION = "11.6.2"

[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

This is a configuration to add to your deployment; the component repository
does not include a Netlify project. Continuous deployment on Git pushes is a
setting of your connected Netlify site. After deploying, open `/?runtime=cpp`
and verify both Run and Debug.

## Use another static host

Configure the host to:

- Serve the generated static files over HTTPS. Localhost is allowed during
  development.
- Send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on IDE documents.
- Serve `.wasm` files as `application/wasm` and allow the editor and runtime asset
  downloads required by your deployment's CSP and CORS/CORP policies.
- Serve real assets before falling back to `index.html` for application URLs.
- Revalidate HTML and assets with stable names. Fingerprinted Vite assets can
  use immutable caching.

Check `window.crossOriginIsolated === true` in the browser console before
checking compilation. If an IDE is in an iframe, its top-level page also needs
compatible isolation headers. Authentication popups may need a separate,
non-isolated route; the standalone example does not implement authentication.

## Runtime assets and saved work

The editor, compiler toolchains, and optional language service download runtime
assets. Serving the website yourself does not make the runtime fully offline.
The current defaults and asset requirements are described in
[Browser and runtime requirements](../README.md#browser-and-runtime-requirements).
The optional clangd provider accepts `VITE_CLANGD_WASM_URL` and
`VITE_CLANGD_JS_URL` for host-owned assets.

Use a stable site origin and a stable `workspace.id` for returning learners.
The component can use browser-local OPFS storage or a host-provided persistence
adapter. The basic example explicitly uses memory storage. See
[workspace saving](import-ide-component.md#save-workspace-files) before relying
on the example to retain student work. The standalone component has no Firebase
requirement.

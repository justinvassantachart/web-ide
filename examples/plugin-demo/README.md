# Plugin composition demo

This minimal example compares three Web IDE configurations:

- **Full:** the C++ runtime, C++ test provider, and generic Tests UI.
- **Runtime only:** Run and Debug remain, but testing is not registered.
- **Missing runtime:** the selected provider cannot be resolved, so Web IDE throws before mounting.

From the repository root:

```sh
npm install
npm run build:library
npm --workspace @web-ide/plugin-demo run dev
```

Open the printed local URL and change **Composition** at the top of the page.

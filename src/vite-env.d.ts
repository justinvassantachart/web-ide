/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Override the URL clangd's wasm is fetched from (default: upstream CDN). */
    readonly VITE_CLANGD_WASM_URL?: string
    /** Override the URL clangd's emscripten loader is fetched from. */
    readonly VITE_CLANGD_JS_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}

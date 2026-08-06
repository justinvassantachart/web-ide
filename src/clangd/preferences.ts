// User opt-in for the in-browser LSP.
// Resolution: URL flag > localStorage > default-off.

const STORAGE_KEY = 'web-ide.clangd.enabled'
const URL_DISABLE = 'nolsp'
const URL_ENABLE = 'lsp'

export function isClangdEnabled(): boolean {
    // Non-browser returns false — no Monaco/Worker to talk to.
    if (typeof window === 'undefined') return false

    const params = new URLSearchParams(window.location.search)
    if (params.has(URL_DISABLE)) return false
    if (params.has(URL_ENABLE)) return true

    try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (stored === 'true') return true
        if (stored === 'false') return false
    } catch { /* storage blocked (private mode) — fall through to default */ }

    // Default off — clangd is a ~120 MB Emscripten WASM that reserves up
    // to 4 GB of virtual address space per WebAssembly.Memory on Safari,
    // which Activity Monitor surfaces as multi-GB tab memory. The
    // in-editor squigglies / completion / hover are nice but not
    // critical; the compiler still flags errors at run time. Opt in via
    // `?lsp` URL flag or `localStorage['web-ide.clangd.enabled']='true'`.
    return false
}

export function setClangdEnabled(enabled: boolean): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
    } catch { /* best-effort */ }
}

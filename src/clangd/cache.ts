// Main-thread helpers for the Cache API layer used by the worker.

import { CLANGD_CACHE_KEY, CLANGD_CACHE_PREFIX } from './config'

/**
 * Ask the browser to keep our origin's storage around under quota
 * pressure. Best-effort; never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    try {
        return await navigator.storage.persist()
    } catch {
        return false
    }
}

/** Delete cache entries from prior clangd versions. */
export async function purgeOldClangdCaches(): Promise<void> {
    if (typeof caches === 'undefined') return
    let keys: string[]
    try {
        keys = await caches.keys()
    } catch {
        return
    }
    await Promise.all(
        keys
            .filter((k) => k.startsWith(CLANGD_CACHE_PREFIX) && k !== CLANGD_CACHE_KEY)
            .map((k) => caches.delete(k).catch(() => false)),
    )
}

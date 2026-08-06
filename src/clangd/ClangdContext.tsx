// React glue for clangd.
//
// - Lazy boot: clangd.wasm is ~120 MB. We only download it after `arm()`
//   (called by Editor.tsx on first focus/keystroke). Hosts pass `disabled`
//   for read-only flows so it never downloads.
// - Sibling to EngineProvider: clangd lives for the whole session, the
//   engine is per-Run. Keeping them independent makes that easy to read.

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'

import { getAllFiles, subscribeWorkspaceChange } from '@/vfs/volume'
import { useSafeMonaco } from '@/lib/use-monaco'
import type { IDisposable } from 'monaco-editor'
import type {
    LanguageToolingProviderComponentProps,
    LanguageToolingService,
} from '@/web-ide/contracts/language-tooling'

import { bootClangd } from './bootstrap'
import { purgeOldClangdCaches, requestPersistentStorage } from './cache'
import type { ClangdClient, ClangdStatus } from './ClangdClient'
import { isCppPath } from './config'
import { isClangdEnabled } from './preferences'
import { clearClangdMarkers, registerClangdProviders } from './providers'
import { CLANGD_SETTING, CPP_LANGUAGE_TOOLING_PROVIDER_ID } from './plugin-config'

const IDLE_STATUS: ClangdStatus = { state: 'idle' }
const DISABLED_STATUS: ClangdStatus = { state: 'disabled' }

export function ClangdProvider({
    disabled = false,
    supplementalFiles,
    publishService,
}: LanguageToolingProviderComponentProps) {
    const effectivelyEnabled = !disabled && isClangdEnabled()
    const monaco = useSafeMonaco()
    const [client, setClient] = useState<ClangdClient | null>(null)
    const [armed, setArmed] = useState(false)
    const [status, setStatus] = useState<ClangdStatus>(
        effectivelyEnabled ? IDLE_STATUS : DISABLED_STATUS,
    )

    // Ref-backed because the effect cleanup needs the client synchronously
    // — `setClient` is async, so the closed-over `client` would be stale.
    const clientRef = useRef<ClangdClient | null>(null)

    const arm = useCallback((path: string) => {
        if (!effectivelyEnabled || !isCppPath(path)) return
        setArmed(true)
        // Best-effort: ask the browser to keep the 120 MB clangd cache
        // around across quota pressure. Fire-and-forget; no UI hook.
        void requestPersistentStorage()
    }, [effectivelyEnabled])

    // Boot exactly once after arm(). `cancelled` handles teardown mid-boot
    // (e.g. StrictMode remount) so no worker leaks.
    useEffect(() => {
        if (!armed || !effectivelyEnabled) return
        let cancelled = false
        let unsubStatus: (() => void) | undefined

        // Drop cache entries from prior versions in parallel with the boot.
        void purgeOldClangdCaches()
        bootClangd(collectInitialFiles(supplementalFiles))
            .then((c) => {
                if (cancelled) {
                    c.dispose()
                    return
                }
                clientRef.current = c
                unsubStatus = c.onStatus.subscribe(setStatus)
                setClient(c)
                setStatus(c.getStatus())
            })
            .catch((err: unknown) => {
                if (cancelled) return
                const message = err instanceof Error ? err.message : String(err)
                setStatus({ state: 'error', message })
                console.warn('[clangd] failed to boot', err)
            })

        return () => {
            cancelled = true
            // Unsubscribe before dispose so the final 'disposed' status
            // doesn't setState on an unmounted tree.
            unsubStatus?.()
            clientRef.current?.dispose()
            clientRef.current = null
            setClient(null)
        }
    }, [armed, effectivelyEnabled, supplementalFiles])

    useEffect(() => {
        if (!client || !monaco) return
        const disposable: IDisposable = registerClangdProviders(monaco, client)
        return () => {
            disposable.dispose()
            clearClangdMarkers(monaco)
        }
    }, [client, monaco])

    // Workspace → clangd FS sweep for files Monaco doesn't have open
    // (headers, explorer creates/renames/deletes). Diff prev vs next so we
    // only write changed files and delete paths that disappeared — without
    // the delete, renames leave the old name shadowing include resolution.
    // 500 ms debounce collapses typing bursts.
    const syncedRef = useRef<Map<string, string>>(new Map())
    useEffect(() => {
        if (!client) return
        let timer: ReturnType<typeof setTimeout> | undefined

        const flush = () => {
            const files = collectInitialFiles(supplementalFiles)
            const prev = syncedRef.current
            const next = new Map(Object.entries(files))
            for (const stale of prev.keys()) {
                if (!next.has(stale)) client.deleteFile(stale)
            }
            const changed: Record<string, string> = {}
            for (const [path, content] of next) {
                if (prev.get(path) !== content) changed[path] = content
            }
            if (Object.keys(changed).length > 0) client.writeFiles(changed)
            syncedRef.current = next
        }

        const schedule = () => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(flush, 500)
        }
        const unsub = subscribeWorkspaceChange(schedule)
        schedule() // catch files that arrived between boot and now
        return () => {
            // Force a final flush so the last edit before unmount lands.
            if (timer) {
                clearTimeout(timer)
                flush()
            }
            unsub()
            syncedRef.current = new Map()
        }
    }, [client, supplementalFiles])

    const value = useMemo<LanguageToolingService>(
        () => ({
            providerId: CPP_LANGUAGE_TOOLING_PROVIDER_ID,
            status: effectivelyEnabled ? status : DISABLED_STATUS,
            arm,
            setting: CLANGD_SETTING,
        }),
        [status, arm, effectivelyEnabled],
    )

    useEffect(() => {
        publishService(value)
        return () => publishService(null)
    }, [publishService, value])

    return null
}

function collectInitialFiles(
    supplementalFiles?: Readonly<Record<string, string>>,
): Record<string, string> {
    const out: Record<string, string> = {}
    let files: Record<string, string>
    try {
        files = getAllFiles()
    } catch {
        // VFS hasn't initialized yet — watchdog will catch up when it does.
        files = {}
    }
    for (const [path, content] of Object.entries(files)) {
        if (isCppPath(path)) out[path] = content
    }
    // Provider-owned declarations live only in clangd's in-memory FS. They do
    // not appear in the explorer, VFS, host snapshots, or persistence.
    for (const [path, content] of Object.entries(supplementalFiles ?? {})) {
        if (isCppPath(path)) out[path] = content
    }
    return out
}

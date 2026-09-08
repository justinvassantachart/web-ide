// React glue for clangd.
//
// - Lazy boot: clangd.wasm is ~120 MB. We only download it after `arm()`
//   (called by Editor.tsx on first focus/keystroke).
// - Sibling to EngineProvider: clangd lives for the whole session, the
//   engine is per-Run. Keeping them independent makes that easy to read.

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'

import { useSafeMonaco } from '@/lib/use-monaco'
import type { IDisposable } from 'monaco-editor'
import type {
    LanguageToolingProviderComponentProps,
    LanguageToolingService,
} from '@/web-ide/contracts/language-tooling'

import { bootClangd } from './bootstrap'
import { purgeOldClangdCaches, requestPersistentStorage } from './cache'
import type { ClangdClient, ClangdStatus } from './ClangdClient'
import { COMPILE_FLAGS, isCppPath } from './config'
import { isClangdEnabled } from './preferences'
import { clearClangdMarkers, registerClangdProviders } from './providers'
import { CLANGD_SETTING, CPP_LANGUAGE_TOOLING_PROVIDER_ID } from './plugin-config'
import { attachClangdWorkspaceSync } from './workspace-sync'
import { collectClangdInitialFiles } from './initial-files'

const IDLE_STATUS: ClangdStatus = { state: 'idle' }
const DISABLED_STATUS: ClangdStatus = { state: 'disabled' }

export interface ClangdProviderConfiguration {
    readonly providerId: string
    readonly compileFlags: readonly string[]
    readonly supportFiles?: Readonly<Record<string, string>>
}

const DEFAULT_CONFIGURATION: ClangdProviderConfiguration = Object.freeze({
    providerId: CPP_LANGUAGE_TOOLING_PROVIDER_ID,
    compileFlags: COMPILE_FLAGS,
})

export function ClangdProvider({
    disabled = false,
    supplementalFiles,
    workspace,
    modelNamespace,
    publishService,
    configuration = DEFAULT_CONFIGURATION,
}: LanguageToolingProviderComponentProps & {
    configuration?: ClangdProviderConfiguration
}) {
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
        bootClangd(collectClangdInitialFiles(
            workspace?.snapshot() ?? {},
            supplementalFiles,
            configuration,
        ))
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
    }, [armed, configuration, effectivelyEnabled, supplementalFiles, workspace])

    useEffect(() => {
        if (!client || !monaco) return
        const disposable: IDisposable = registerClangdProviders(monaco, client, {
            languages: ['cpp', 'c'],
            modelNamespace,
        })
        return () => {
            disposable.dispose()
            clearClangdMarkers(monaco, modelNamespace)
        }
    }, [client, modelNamespace, monaco])

    // Workspace → clangd FS sweep for files Monaco doesn't have open
    // (headers, explorer creates/renames/deletes). Diff prev vs next so we
    // only write changed files and delete paths that disappeared — without
    // the delete, renames leave the old name shadowing include resolution.
    // 500 ms debounce collapses typing bursts.
    useEffect(() => {
        if (!client || !workspace) return
        const synchronization = attachClangdWorkspaceSync({
            workspace,
            client,
            readFiles: () => collectClangdInitialFiles(
                workspace?.snapshot() ?? {},
                supplementalFiles,
                configuration,
            ),
        })
        return () => synchronization.dispose()
    }, [client, configuration, supplementalFiles, workspace])

    const value = useMemo<LanguageToolingService>(
        () => ({
            providerId: configuration.providerId,
            status: effectivelyEnabled ? status : DISABLED_STATUS,
            arm,
            setting: CLANGD_SETTING,
        }),
        [status, arm, configuration.providerId, effectivelyEnabled],
    )

    useEffect(() => {
        publishService(value)
        return () => publishService(null)
    }, [publishService, value])

    return null
}

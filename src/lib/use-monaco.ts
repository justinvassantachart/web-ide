import { loader, type Monaco } from '@monaco-editor/react'
import { useEffect, useState } from 'react'

// Keep the CDN runtime aligned with the reviewed Monaco API/types dependency.
// The loader's older default can throw uncaught cancellation errors during
// rapid, source-driven model switches.
loader.config({
    paths: {
        vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs',
    },
})

export function isMonacoCancellation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'type' in error &&
        error.type === 'cancelation'
    )
}

/**
 * Cancellation-safe equivalent of @monaco-editor/react's useMonaco hook.
 * The upstream hook cancels its loader promise during Strict Mode teardown
 * without attaching a rejection handler, producing an unhandled rejection.
 */
export function useSafeMonaco(): Monaco | null {
    const [monaco, setMonaco] = useState<Monaco | null>(() =>
        loader.__getMonacoInstance(),
    )

    useEffect(() => {
        if (monaco) return

        const initialization = loader.init()
        initialization
            .then(setMonaco)
            .catch((error: unknown) => {
                if (!isMonacoCancellation(error)) {
                    console.error('[web-ide] Monaco initialization failed', error)
                }
            })

        return () => initialization.cancel()
    }, [monaco])

    return monaco
}

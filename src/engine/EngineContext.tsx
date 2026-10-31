import React, { useEffect, useState } from 'react';
import { EngineContext } from './engine-context';
import type { RuntimeSession } from '@/web-ide/contracts/runtime';
import type { WebIDEInstanceController } from '@/web-ide/core/instance-handle';

export function EngineProvider({
    createSession,
    runtimeController,
    children,
}: {
    createSession: () => RuntimeSession
    runtimeController?: WebIDEInstanceController
    children: React.ReactNode
}) {
    const [engine, setEngine] = useState<RuntimeSession | null>(null);

    // Create sessions in an effect so every factory result has a matching
    // cleanup. StrictMode may probe this effect twice, but the first session
    // is disposed instead of being abandoned by a discarded state initializer.
    useEffect(() => {
        const nextEngine = createSession();
        const dispose = (): Promise<void> => {
            if (nextEngine.disposeAndWait) return nextEngine.disposeAndWait().then(() => {});
            if (nextEngine.dispose) nextEngine.dispose();
            else nextEngine.stop({ reason: 'teardown' });
            return Promise.resolve();
        };
        // Register effect ownership before refs can retire this mount. The bridge
        // attaches later, and StrictMode must distinguish this session from its replacement.
        runtimeController?.beginRuntime(nextEngine, dispose);
        // Effect ownership is intentional: constructing in a render/state
        // initializer lets StrictMode discard a session without cleanup.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEngine(nextEngine);
        return () => {
            try {
                const drain = runtimeController?.retireRuntime(nextEngine, dispose) ?? dispose();
                void drain.catch((error: unknown) => console.warn('[web-ide] runtime cleanup failed', error));
            } catch (error) { console.warn('[web-ide] runtime cleanup failed', error); }
        };
    }, [createSession, runtimeController]);

    // Console access for manual debugging in dev builds only.
    useEffect(() => {
        if (import.meta.env.DEV && engine) {
            const debugWindow = window as unknown as { __webIDEEngine?: unknown };
            debugWindow.__webIDEEngine = engine;
            return () => {
                if (debugWindow.__webIDEEngine === engine) delete debugWindow.__webIDEEngine;
            };
        }
    }, [engine]);

    if (!engine) return null;

    return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

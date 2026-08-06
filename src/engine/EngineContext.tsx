import React, { useEffect, useState } from 'react';
import { EngineContext } from './engine-context';
import type { RuntimeSession } from '@/web-ide/contracts/runtime';

export function EngineProvider({
    createSession,
    children,
}: {
    createSession: () => RuntimeSession
    children: React.ReactNode
}) {
    const [engine, setEngine] = useState<RuntimeSession | null>(null);

    // Create sessions in an effect so every factory result has a matching
    // cleanup. StrictMode may probe this effect twice, but the first session
    // is disposed instead of being abandoned by a discarded state initializer.
    useEffect(() => {
        const nextEngine = createSession();
        // Effect ownership is intentional: constructing in a render/state
        // initializer lets StrictMode discard a session without cleanup.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEngine(nextEngine);
        return () => {
            if (nextEngine.dispose) nextEngine.dispose();
            else nextEngine.stop();
        };
    }, [createSession]);

    // Console access for manual debugging in dev builds only.
    useEffect(() => {
        if (import.meta.env.DEV && engine) {
            (window as unknown as { __webIDEEngine?: unknown }).__webIDEEngine = engine;
        }
    }, [engine]);

    if (!engine) return null;

    return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

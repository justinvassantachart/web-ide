// Context + hook live apart from the provider component so files exporting
// components export nothing else (react-refresh/only-export-components).
import { createContext, useContext } from 'react';
import type { RuntimeSession } from '@/web-ide/contracts/runtime';

export const EngineContext = createContext<RuntimeSession | null>(null);

export function useEngine(): RuntimeSession {
    const context = useContext(EngineContext);
    if (!context) throw new Error('useEngine must be used within EngineProvider');
    return context;
}

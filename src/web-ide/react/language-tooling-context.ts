import { createContext, useContext } from 'react'
import type { LanguageToolingService } from '../contracts/language-tooling'

const DISABLED_STATUS = Object.freeze({ state: 'disabled' } as const)

export const NO_LANGUAGE_TOOLING: LanguageToolingService = Object.freeze({
  providerId: null,
  status: DISABLED_STATUS,
  arm: () => undefined,
})

/**
 * Selected providers publish their editor-facing service here. The default is
 * deliberately safe so a runtime-only, Python, or custom host needs no tooling.
 */
export const LanguageToolingContext = createContext<LanguageToolingService>(
  NO_LANGUAGE_TOOLING,
)

export function useLanguageTooling(): LanguageToolingService {
  return useContext(LanguageToolingContext)
}

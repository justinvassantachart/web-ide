import { useThemeStore, type Theme } from '@/theme/theme-store'
import { useWebIDEConfiguration } from './configuration-context'

/** Resolve the host palette without changing another application's document. */
export function useWorkbenchTheme() {
  const configuration = useWebIDEConfiguration()
  const stored = useThemeStore((state) => state.theme)
  const setStored = useThemeStore((state) => state.setTheme)
  return {
    theme: configuration.theme ?? stored,
    setTheme(theme: Theme) {
      if (configuration.theme === undefined) setStored(theme)
      configuration.onThemeChange?.(theme)
    },
  }
}

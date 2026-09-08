import { initTheme } from '@/theme/theme-store'

/** Applies the persisted workbench theme without exposing the internal store. */
export function initWebIDETheme(): void {
  initTheme()
}

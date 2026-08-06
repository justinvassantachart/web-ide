import type { LanguageToolingSetting } from '@/web-ide/contracts/language-tooling'
import { isClangdEnabled, setClangdEnabled } from './preferences'

export const CPP_LANGUAGE_TOOLING_PROVIDER_ID = 'web-ide.language-tooling.cpp'

export const CLANGD_SETTING: LanguageToolingSetting = Object.freeze({
  section: 'Language Server',
  label: 'Enable clangd (reloads)',
  isEnabled: isClangdEnabled,
  setEnabled: setClangdEnabled,
  reloadOnChange: true,
})

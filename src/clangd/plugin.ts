import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import type { LanguageToolingProvider } from '@/web-ide/contracts/language-tooling'
import { ClangdProvider } from './ClangdContext'
import { CPP_LANGUAGE_TOOLING_PROVIDER_ID } from './plugin-config'

export const cppLanguageToolingProvider: LanguageToolingProvider = {
  id: CPP_LANGUAGE_TOOLING_PROVIDER_ID,
  label: 'C/C++ (clangd)',
  languageIds: ['c', 'cpp'],
  component: ClangdProvider,
}

export const cppLanguageToolingPlugin: IDEPlugin = {
  id: 'web-ide.language-tooling.cpp.plugin',
  contributes: { languageToolingProviders: [cppLanguageToolingProvider] },
}

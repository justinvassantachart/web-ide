import { createElement } from 'react'
import type { IDEPlugin } from '@/web-ide/contracts/plugin'
import type {
  LanguageToolingProvider,
  LanguageToolingProviderComponentProps,
} from '@/web-ide/contracts/language-tooling'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import type { CppCompileProfileV1 } from '@/web-ide/contracts/cpp'
import { cppCompileFlags, normalizeContractVfsPath, validateCppCompileProfile } from '@/web-ide/core/cpp-contracts'
import { ClangdProvider, type ClangdProviderConfiguration } from './ClangdContext'
import { CPP_LANGUAGE_TOOLING_PROVIDER_ID } from './plugin-config'

export const cppLanguageToolingProvider: LanguageToolingProvider = {
  id: CPP_LANGUAGE_TOOLING_PROVIDER_ID,
  label: 'C/C++ (clangd)',
  languageIds: ['c', 'cpp'],
  component: ClangdProvider,
}

export interface CreateCppClangdProviderOptions {
  id: string
  label: string
  profile: CppCompileProfileV1
  /** Reviewed read-only headers mounted only in clangd's private filesystem. */
  supportFiles?: Readonly<WorkspaceFiles>
}

/** Creates a course-neutral clangd provider from the same immutable build profile. */
export function createCppClangdProvider(
  options: CreateCppClangdProviderOptions,
): LanguageToolingProvider {
  if (typeof options.id !== 'string' || options.id.length === 0 || options.id.length > 128) {
    throw new TypeError('clangd provider id is invalid')
  }
  if (typeof options.label !== 'string' || options.label.length === 0 || options.label.length > 256) {
    throw new TypeError('clangd provider label is invalid')
  }
  validateCppCompileProfile(options.profile)
  const supportFiles: WorkspaceFiles = Object.create(null)
  for (const [inputPath, content] of Object.entries(options.supportFiles ?? {})) {
    const path = normalizeContractVfsPath(inputPath)
    if (path === '/workspace/.clangd' || path.endsWith('/.clangd')) {
      throw new TypeError('support files cannot replace clangd configuration')
    }
    if (typeof content !== 'string') throw new TypeError(`support file ${path} is not text`)
    supportFiles[path] = content
  }
  const configuration: ClangdProviderConfiguration = Object.freeze({
    providerId: options.id,
    compileFlags: cppCompileFlags(options.profile),
    supportFiles: Object.freeze({ ...supportFiles }),
  })
  const component = (props: LanguageToolingProviderComponentProps) =>
    createElement(ClangdProvider, { ...props, configuration })
  return Object.freeze({
    id: options.id,
    label: options.label,
    languageIds: Object.freeze(['c', 'cpp']),
    component,
  })
}

export const cppLanguageToolingPlugin: IDEPlugin = {
  id: 'web-ide.language-tooling.cpp.plugin',
  contributes: { languageToolingProviders: [cppLanguageToolingProvider] },
}

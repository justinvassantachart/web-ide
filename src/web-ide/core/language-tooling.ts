import type { LanguageToolingProvider } from '../contracts/language-tooling'
import type { RuntimeProvider } from '../contracts/runtime'

export function resolveLanguageToolingProvider(
  providers: readonly LanguageToolingProvider[],
  runtime: Pick<RuntimeProvider, 'languageIds'>,
  requestedId?: string,
): LanguageToolingProvider | undefined {
  if (!requestedId) return undefined

  const selected = providers.find(({ id }) => id === requestedId)
  if (!selected) {
    throw new Error(
      `No language tooling provider contributed with id "${requestedId}"`,
    )
  }

  const supportsRuntime = selected.languageIds.some((languageId) =>
    runtime.languageIds.includes(languageId),
  )
  if (!supportsRuntime) {
    throw new Error(
      `Language tooling provider "${requestedId}" does not support the selected runtime languages`,
    )
  }

  return selected
}

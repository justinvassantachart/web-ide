import { useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { cppLanguageToolingProvider } from '../../src/clangd/plugin'
import { CLANGD_SETTING } from '../../src/clangd/plugin-config'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import { resolveLanguageToolingProvider } from '../../src/web-ide/core/language-tooling'
import type {
  LanguageToolingProvider,
  LanguageToolingProviderComponentProps,
  LanguageToolingService,
} from '../../src/web-ide'
import { useLanguageTooling } from '../../src/web-ide'

const CUSTOM_SERVICE: LanguageToolingService = Object.freeze({
  providerId: 'host.language-tooling.custom',
  status: Object.freeze({ state: 'ready' }),
  arm: () => undefined,
})

function CustomLanguageToolingProvider({
  disabled,
  supplementalFiles,
  publishService,
}: LanguageToolingProviderComponentProps) {
  useEffect(() => {
    publishService(CUSTOM_SERVICE)
    return () => publishService(null)
  }, [publishService])

  return (
    <output
      data-disabled={String(disabled)}
      data-support-files={Object.keys(supplementalFiles ?? {}).length}
    />
  )
}

const customLanguageToolingProvider: LanguageToolingProvider = {
  id: 'host.language-tooling.custom',
  label: 'Host tooling',
  languageIds: ['custom'],
  component: CustomLanguageToolingProvider,
}

function ToolingProbe() {
  const tooling = useLanguageTooling()
  return (
    <output
      data-provider={tooling.providerId ?? 'none'}
      data-status={tooling.status.state}
      data-setting={tooling.setting?.label ?? 'none'}
    />
  )
}

describe('language tooling composition', () => {
  it('has a safe no-provider service', () => {
    const html = renderToStaticMarkup(<ToolingProbe />)

    expect(html).toContain('data-provider="none"')
    expect(html).toContain('data-status="disabled"')
    expect(html).toContain('data-setting="none"')
  })

  it('renders the official C/C++ provider without booting clangd when disabled', () => {
    const ProviderComponent = cppLanguageToolingProvider.component
    const publishService = vi.fn()
    const html = renderToStaticMarkup(
      <ProviderComponent disabled publishService={publishService} />,
    )

    expect(cppLanguageToolingProvider).toMatchObject({
      id: 'web-ide.language-tooling.cpp',
      label: 'C/C++ (clangd)',
      languageIds: ['c', 'cpp'],
    })
    expect(CLANGD_SETTING).toMatchObject({
      section: 'Language Server',
      label: 'Enable clangd (reloads)',
      reloadOnChange: true,
    })
    expect(html).toBe('')
    expect(publishService).not.toHaveBeenCalled()
  })

  it('does not require a language tooling contribution', () => {
    const manager = new IDEPluginManager([{ id: 'runtime-only-host' }])

    expect(manager.languageToolingProviders.getSnapshot()).toEqual([])
    manager.dispose()
    expect(manager.languageToolingProviders.isDisposed).toBe(true)
  })

  it('rejects tooling that does not serve the selected runtime language', () => {
    expect(
      resolveLanguageToolingProvider(
        [cppLanguageToolingProvider],
        { languageIds: ['cpp'] },
        cppLanguageToolingProvider.id,
      ),
    ).toBe(cppLanguageToolingProvider)
    expect(
      resolveLanguageToolingProvider(
        [cppLanguageToolingProvider],
        { languageIds: ['python'] },
      ),
    ).toBeUndefined()
    expect(() =>
      resolveLanguageToolingProvider(
        [cppLanguageToolingProvider],
        { languageIds: ['python'] },
        cppLanguageToolingProvider.id,
      )
    ).toThrow('does not support the selected runtime languages')
    expect(() =>
      resolveLanguageToolingProvider(
        [cppLanguageToolingProvider],
        { languageIds: ['cpp'] },
        'missing.tooling',
      )
    ).toThrow('No language tooling provider contributed')
  })

  it('lets a host-created provider publish through only the public callback', () => {
    const manager = new IDEPluginManager([
      {
        id: 'host.language-tooling.plugin',
        contributes: {
          languageToolingProviders: [customLanguageToolingProvider],
        },
      },
    ])
    const provider = manager.languageToolingProviders.get(
      customLanguageToolingProvider.id,
    )
    const publishService = vi.fn()
    const ProviderComponent = provider!.component
    const html = renderToStaticMarkup(
      <ProviderComponent
        disabled={false}
        supplementalFiles={{ '/workspace/custom.api': 'declarations' }}
        publishService={publishService}
      />,
    )

    expect(html).toContain('data-disabled="false"')
    expect(html).toContain('data-support-files="1"')
    expect(publishService).not.toHaveBeenCalled()
    manager.dispose()
  })
})

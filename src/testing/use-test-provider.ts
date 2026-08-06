import { useMemo } from 'react'
import { useEngine } from '@/engine/engine-context'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { useIDETestProviders } from '@/web-ide/react/contribution-context'
import { resolveTestProvider } from './test-execution'

export function useSelectedTestProvider() {
  const runtime = useEngine()
  const configuration = useWebIDEConfiguration()
  const providers = useIDETestProviders()

  return useMemo(
    () => resolveTestProvider(providers, runtime, configuration.testProvider),
    [configuration.testProvider, providers, runtime],
  )
}

import { createContext, useContext } from 'react'
import type { WebIDEConfiguration } from '../contracts/configuration'

export const WebIDEConfigurationContext = createContext<WebIDEConfiguration | null>(null)

export function useWebIDEConfiguration(): WebIDEConfiguration {
  const configuration = useContext(WebIDEConfigurationContext)
  if (!configuration) throw new Error('Web IDE configuration requires <WebIDE>')
  return configuration
}

import { createContext, useContext } from 'react'
import type { WebIDEHost } from '../contracts/host'

export const WebIDEHostContext = createContext<WebIDEHost | undefined>(undefined)

/** Returns the host facade for this embed, or undefined in standalone mode. */
export function useWebIDEHost(): WebIDEHost | undefined {
  return useContext(WebIDEHostContext)
}

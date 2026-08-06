import type { ReactNode } from 'react'
import type { WebIDEHost } from '../contracts/host'
import { WebIDEHostContext } from './host-context'

export function WebIDEHostProvider({
  host,
  children,
}: {
  host: WebIDEHost
  children: ReactNode
}) {
  return <WebIDEHostContext.Provider value={host}>{children}</WebIDEHostContext.Provider>
}

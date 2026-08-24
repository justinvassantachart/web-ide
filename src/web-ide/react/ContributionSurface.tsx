import type { ComponentType } from 'react'
import type {
  IDEExecutionController,
  IDEPanelServices,
} from '../contracts/contributions'
import type { RuntimeSession } from '../contracts/runtime'
import type { WorkspaceFiles } from '../contracts/host'
import { useSourcePresentationOwner } from './source-presentation-state'

/** Binds one rendered contribution to one automatically cleaned source owner. */
export function ContributionSurface({
  component: Component,
  runtime,
  execution,
  snapshot,
  revealPanel,
}: {
  component: ComponentType<IDEPanelServices>
  runtime: RuntimeSession
  execution: IDEExecutionController
  snapshot(): WorkspaceFiles
  revealPanel(id: string): void
}) {
  const source = useSourcePresentationOwner()

  return (
    <Component
      runtime={runtime}
      execution={execution}
      source={source}
      workspace={{ snapshot }}
      panels={{ reveal: revealPanel }}
    />
  )
}

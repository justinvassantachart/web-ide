import type { ComponentType } from 'react'
import type {
  IDEExecutionController,
  IDEPanelServices,
} from '../contracts/contributions'
import type { RuntimeSession } from '../contracts/runtime'
import type { IDEWorkspaceFeed } from '../contracts/workspace'
import { useSourcePresentationOwner } from './source-presentation-state'

/** Binds one rendered contribution to one automatically cleaned source owner. */
export function ContributionSurface({
  component: Component,
  runtime,
  execution,
  workspace,
  revealPanel,
}: {
  component: ComponentType<IDEPanelServices>
  runtime: RuntimeSession
  execution: IDEExecutionController
  workspace: IDEWorkspaceFeed
  revealPanel(id: string): void
}) {
  const source = useSourcePresentationOwner()

  return (
    <Component
      runtime={runtime}
      execution={execution}
      source={source}
      workspace={workspace}
      panels={{ reveal: revealPanel }}
    />
  )
}

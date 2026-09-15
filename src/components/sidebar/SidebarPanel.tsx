// The wide panel that sits next to the activity bar and shows the active
// view's content. Each view ([ExplorerView], [AssignmentView]) renders its
// own titlebar and body chrome — SidebarPanel is just the outer container
// so it stays out of the way for resizing.

import { useIDEActivities } from '@/web-ide/react/contribution-context'
import { useEngine } from '@/engine/engine-context'
import { useEffect, useMemo } from 'react'
import { useRunPipeline } from '@/components/layout/use-run-pipeline'
import { ContributionSurface } from '@/web-ide/react/ContributionSurface'
import type { IDEWorkspaceFeed } from '@/web-ide/contracts/workspace'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'
import { useSidebarLayout } from '@/web-ide/react/sidebar-layout-context'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

export function SidebarPanel() {
    const { controller: sidebarLayout, snapshot: sidebarSnapshot } = useSidebarLayout()
    const activities = useIDEActivities()
    const runtime = useEngine()
    const { execution } = useRunPipeline()
    const { controller: panelLayout } = usePanelLayout()
    const { workspace } = useWorkbenchInstance()
    const workspaceFeed = useMemo<IDEWorkspaceFeed>(() => ({
        snapshot: () => workspace.snapshot(),
        revision: () => workspace.revision,
        subscribe: (listener) => workspace.subscribe(listener),
    }), [workspace])
    const selected = activities.find(
        (activity) => activity.id === sidebarSnapshot.selectedActivityId,
    ) ?? activities[0]
    const SelectedActivity = selected?.component

    useEffect(() => {
        if (selected && selected.id !== sidebarSnapshot.selectedActivityId) {
            sidebarLayout.selectActivity(selected.id)
        }
    }, [selected, sidebarLayout, sidebarSnapshot.selectedActivityId])

    return (
        <div className="nova-sidebar">
            {SelectedActivity && selected && (
                <ContributionSurface
                    key={selected.id}
                    component={SelectedActivity}
                    runtime={runtime}
                    execution={execution}
                    workspace={workspaceFeed}
                    revealPanel={panelLayout.selectPanel}
                />
            )}
        </div>
    )
}

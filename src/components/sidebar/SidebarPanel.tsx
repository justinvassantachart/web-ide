// The wide panel that sits next to the activity bar and shows the active
// view's content. Each view ([ExplorerView], [AssignmentView]) renders its
// own titlebar and body chrome — SidebarPanel is just the outer container
// so it stays out of the way for resizing.

import { useIDEActivities } from '@/web-ide/react/contribution-context'
import { useEngine } from '@/engine/engine-context'
import { getAllFiles } from '@/vfs/volume'
import { useEffect } from 'react'
import { useRunPipeline } from '@/components/layout/use-run-pipeline'
import { ContributionSurface } from '@/web-ide/react/ContributionSurface'
import { usePanelLayout } from '@/web-ide/react/panel-layout-context'
import { useSidebarLayout } from '@/web-ide/react/sidebar-layout-context'

export function SidebarPanel() {
    const { controller: sidebarLayout, snapshot: sidebarSnapshot } = useSidebarLayout()
    const activities = useIDEActivities()
    const runtime = useEngine()
    const { execution } = useRunPipeline()
    const { controller: panelLayout } = usePanelLayout()
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
                    snapshot={getAllFiles}
                    revealPanel={panelLayout.selectPanel}
                />
            )}
        </div>
    )
}

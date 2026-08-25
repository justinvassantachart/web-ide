// VS Code-style activity bar. 48px wide, codicon buttons stacked vertically,
// active item shows a 2px left accent border. The bottom section holds the
// settings gear which opens [SettingsMenu] (theme + optional tooling toggle).

import { Codicon } from '@/components/ui/codicon'
import { useIDEActivities } from '@/web-ide/react/contribution-context'
import { SettingsMenu } from './SettingsMenu'
import { useSidebarLayout } from '@/web-ide/react/sidebar-layout-context'

export function ActivityBar() {
    const { controller, snapshot } = useSidebarLayout()
    const activities = useIDEActivities()

    return (
        <div className="nova-activitybar" role="navigation" aria-label="Activity Bar">
            <div className="nova-ab-section">
                {activities.map((activity) => {
                    const isActive = !snapshot.collapsed
                        && snapshot.selectedActivityId === activity.id
                    return (
                        <button
                            key={activity.id}
                            type="button"
                            className={`nova-ab-btn${isActive ? ' active' : ''}`}
                            onClick={() => controller.handleActivityClick(activity.id)}
                            aria-label={activity.title}
                            aria-pressed={isActive}
                        >
                            <Codicon name={activity.icon} />
                            <span className="nova-ab-tooltip" role="tooltip">
                                {activity.title}
                            </span>
                        </button>
                    )
                })}
            </div>

            <div className="nova-ab-section bottom">
                <SettingsMenu />
            </div>
        </div>
    )
}

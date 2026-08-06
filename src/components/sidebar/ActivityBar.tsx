// VS Code-style activity bar. 48px wide, codicon buttons stacked vertically,
// active item shows a 2px left accent border. The bottom section holds the
// settings gear which opens [SettingsMenu] (theme + optional tooling toggle).

import { Codicon } from '@/components/ui/codicon'
import { useIDEActivities } from '@/web-ide/react/contribution-context'
import { useSidebarStore } from './sidebar-store'
import { SettingsMenu } from './SettingsMenu'

export function ActivityBar() {
    const { activeView, collapsed, onActivityClick } = useSidebarStore()
    const activities = useIDEActivities()

    return (
        <div className="nova-activitybar" role="navigation" aria-label="Activity Bar">
            <div className="nova-ab-section">
                {activities.map((activity) => {
                    const isActive = !collapsed && activeView === activity.id
                    return (
                        <button
                            key={activity.id}
                            type="button"
                            className={`nova-ab-btn${isActive ? ' active' : ''}`}
                            onClick={() => onActivityClick(activity.id)}
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

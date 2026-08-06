// Thin wrapper so the activity-bar dispatcher in [SidebarPanel] can render
// the file explorer the same way it renders other views. The FileExplorer
// owns its own titlebar + section header.

import { FileExplorer } from '@/components/explorer/FileExplorer'

export function ExplorerView() {
    return <FileExplorer />
}

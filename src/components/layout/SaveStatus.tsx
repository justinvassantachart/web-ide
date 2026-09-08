import { useEffect, useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'
import type { WorkspacePersistenceStatus } from '@/web-ide/contracts/workspace'

// "Saved" sticks around briefly after the last write completes so the
// indicator flips visibly when work persists, instead of snapping back
// to a generic empty state in a single frame.
const SAVED_LINGER_MS = 1500

export function SaveStatus() {
    const { workspace } = useWorkbenchInstance()
    const [status, setStatus] = useState<WorkspacePersistenceStatus>(workspace.getPersistenceStatus())
    const [showSaved, setShowSaved] = useState(false)

    useEffect(() => {
        let lingerTimer: ReturnType<typeof setTimeout> | undefined
        const unsub = workspace.subscribePersistenceStatus((next) => {
            setStatus(next)
            if (next.state === 'saved') {
                setShowSaved(true)
                if (lingerTimer) clearTimeout(lingerTimer)
                lingerTimer = setTimeout(() => setShowSaved(false), SAVED_LINGER_MS)
            } else {
                if (lingerTimer) clearTimeout(lingerTimer)
                setShowSaved(false)
            }
        })
        return () => {
            if (lingerTimer) clearTimeout(lingerTimer)
            unsub()
        }
    }, [workspace])

    if (status.state === 'saving' || status.state === 'retrying') {
        return (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                <Codicon name="loading" size={12} spin />
                <span>{status.state === 'retrying' ? 'Retrying…' : 'Saving…'}</span>
            </span>
        )
    }
    if (status.state === 'error') {
        return (
            <span className="flex items-center gap-1.5 text-xs text-destructive select-none" title={typeof status.message === 'string' ? status.message : undefined}>
                <Codicon name="warning" size={12} />
                <span>Save failed</span>
            </span>
        )
    }
    if (showSaved) {
        return (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                <Codicon name="check" size={12} />
                <span>Saved</span>
            </span>
        )
    }
    return null
}

import { useEffect, useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { getSaveState, subscribeSaveState, type SaveState } from '@/vfs/volume'

// "Saved" sticks around briefly after the last write completes so the
// indicator flips visibly when work persists, instead of snapping back
// to a generic empty state in a single frame.
const SAVED_LINGER_MS = 1500

export function SaveStatus() {
    const [state, setState] = useState<SaveState>(getSaveState())
    const [showSaved, setShowSaved] = useState(false)

    useEffect(() => {
        let lingerTimer: ReturnType<typeof setTimeout> | undefined
        const unsub = subscribeSaveState((next) => {
            setState(next)
            if (next === 'saved') {
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
    }, [])

    if (state === 'saving') {
        return (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                <Codicon name="loading" size={12} spin />
                <span>Saving…</span>
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

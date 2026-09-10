import type { editor, IPosition, IDisposable } from 'monaco-editor'

export interface TextHunk {
    readonly start: number
    readonly end: number
    readonly text: string
}

// Patience anchors bound work for large documents without turning distant edits
// into a whole-buffer replacement. Ambiguous unmatched spans use one trimmed
// range; no source identity is invented inside deleted/replaced text.
export function textHunks(before: string, after: string): TextHunk[] {
    if (before === after) return []
    const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
    const a = lines(before), b = lines(after)
    const offsets = (values: string[]) => {
        const result = [0]
        for (const value of values) result.push(result[result.length - 1] + value.length)
        return result
    }
    const ao = offsets(a), bo = offsets(b), hunks: TextHunk[] = []
    const add = (as: number, ae: number, bs: number, be: number) => {
        let start = ao[as], end = ao[ae], nextStart = bo[bs], nextEnd = bo[be]
        while (start < end && nextStart < nextEnd && before[start] === after[nextStart]) { start++; nextStart++ }
        while (end > start && nextEnd > nextStart && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
        // Monaco columns are UTF-16; never split a surrogate pair or CRLF.
        const splits = (text: string, at: number) => at > 0 && at < text.length
            && ((text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff)
                || (text[at - 1] === '\r' && text[at] === '\n'))
        if (splits(before, start) || splits(after, nextStart)) { start--; nextStart-- }
        if (splits(before, end) || splits(after, nextEnd)) { end++; nextEnd++ }
        if (start !== end || nextStart !== nextEnd) hunks.push({ start, end, text: after.slice(nextStart, nextEnd) })
    }
    const visit = (as: number, ae: number, bs: number, be: number, depth: number) => {
        while (as < ae && bs < be && a[as] === b[bs]) { as++; bs++ }
        while (as < ae && bs < be && a[ae - 1] === b[be - 1]) { ae--; be-- }
        if (as === ae || bs === be || depth >= 16) { add(as, ae, bs, be); return }
        const unique = (values: string[], start: number, end: number) => {
            const map = new Map<string, number>()
            for (let i = start; i < end; i++) map.set(values[i], map.has(values[i]) ? -1 : i)
            return map
        }
        const am = unique(a, as, ae), bm = unique(b, bs, be)
        const pairs: Array<[number, number]> = []
        for (const [line, i] of am) {
            const j = bm.get(line)
            if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j])
        }
        const tails: number[] = [], previous: number[] = []
        for (let i = 0; i < pairs.length; i++) {
            let low = 0, high = tails.length
            while (low < high) {
                const middle = (low + high) >>> 1
                if (pairs[tails[middle]][1] < pairs[i][1]) low = middle + 1
                else high = middle
            }
            previous[i] = low ? tails[low - 1] : -1
            tails[low] = i
        }
        if (!tails.length) { add(as, ae, bs, be); return }
        const anchors: Array<[number, number]> = []
        for (let i = tails[tails.length - 1]; i >= 0; i = previous[i]) anchors.push(pairs[i])
        for (const [i, j] of anchors.reverse()) {
            visit(as, i, bs, j, depth + 1)
            as = i + 1; bs = j + 1
        }
        visit(as, ae, bs, be, depth + 1)
    }
    visit(0, a.length, 0, b.length, 0)
    return hunks
}

// Insertions follow their original source. An endpoint inside removed text maps
// to the closest surviving boundary (ties to the beginning of the replacement).
export function mapOffset(offset: number, hunks: readonly TextHunk[]): number {
    let delta = 0
    for (const hunk of hunks) {
        if (offset < hunk.start) break
        if (offset < hunk.end) {
            return hunk.start + delta + (offset - hunk.start > hunk.end - offset ? hunk.text.length : 0)
        }
        delta += hunk.text.length - (hunk.end - hunk.start)
    }
    return offset + delta
}

interface View {
    state: editor.ICodeEditorViewState
    top: number
    left: number
}

/** Owned by one Editor mount; never a module-global path cache. */
export class WorkspaceModelViews {
    private readonly views = new Map<string, View>()
    private editor: editor.IStandaloneCodeEditor | undefined
    private subscriptions: IDisposable[] = []

    attach(value: editor.IStandaloneCodeEditor): void {
        this.detach()
        this.editor = value
        this.subscriptions = [
            value.onWillChangeModel(() => this.capture()),
            value.onDidChangeModel(() => {
                const model = value.getModel()
                if (!model) return
                const saved = this.views.get(model.uri.path)
                if (saved) this.restore(saved, true)
            }),
        ]
    }

    detach(): void {
        for (const subscription of this.subscriptions) subscription.dispose()
        this.subscriptions = []
        this.editor = undefined
    }

    capture(): View | undefined {
        const value = this.editor, model = value?.getModel()
        const state = value?.saveViewState()
        if (!value || !model || !state || model.isDisposed()) return
        const view = { state, top: value.getScrollTop(), left: value.getScrollLeft() }
        this.views.set(model.uri.path, view)
        return view
    }

    rename(from: string, to: string): void {
        if (this.editor?.getModel()?.uri.path === from) this.capture()
        const saved = this.views.get(from)
        if (saved) this.views.set(to, saved)
        this.views.delete(from)
    }

    remove(path: string): void { this.views.delete(path) }

    update(model: editor.ITextModel, text: string): void {
        // A Monaco model uses one line ending even if the authoritative file has
        // mixed endings. Keep that model convention without changing VFS bytes.
        const normalized = text.replace(/\r\n|\r|\n/gu, model.getEOL())
        const hunks = textHunks(model.getValue(), normalized)
        if (!hunks.length) return
        const active = this.editor?.getModel() === model
        const saved = active ? this.capture() : this.views.get(model.uri.path)
        const positions = saved ? [saved.state.viewState.firstPosition,
            ...saved.state.cursorState.flatMap(cursor => [cursor.selectionStart, cursor.position])] : []
        const mapped = positions.map(position => mapOffset(model.getOffsetAt(position), hunks))
        model.applyEdits(hunks.map(hunk => {
            const start = model.getPositionAt(hunk.start), end = model.getPositionAt(hunk.end)
            return { range: { startLineNumber: start.lineNumber, startColumn: start.column,
                endLineNumber: end.lineNumber, endColumn: end.column }, text: hunk.text, forceMoveMarkers: true }
        }))
        if (model.getValue() !== normalized) {
            // The caller still holds the external-origin suppression guard.
            // Recover exact content without aborting synchronization of other
            // models or throwing out of a React passive effect.
            model.applyEdits([{ range: model.getFullModelRange(), text: normalized }])
            console.warn('Workspace model diff required authoritative recovery')
        }
        if (!saved) return
        const nextPositions = mapped.map(offset => model.getPositionAt(offset))
        const firstPosition = nextPositions[0]
        const state = { ...saved.state,
            // Opaque contribution state (folding/find/etc.) contains unmapped
            // coordinates. Active Monaco contributions keep their live state;
            // an inactive view must not replay stale ranges on another source.
            contributionsState: {},
            viewState: { ...saved.state.viewState, firstPosition },
            cursorState: saved.state.cursorState.map((cursor, i) => ({ ...cursor,
                selectionStart: nextPositions[1 + i * 2], position: nextPositions[2 + i * 2] })),
        }
        const next = { ...saved, state }
        this.views.set(model.uri.path, next)
        if (active) this.restore(next, false)
    }

    private restore(view: View, switching: boolean): void {
        const value = this.editor
        if (!value) return
        if (switching) value.restoreViewState(view.state)
        else value.setSelections(view.state.cursorState.map(cursor => ({
            selectionStartLineNumber: cursor.selectionStart.lineNumber,
            selectionStartColumn: cursor.selectionStart.column,
            positionLineNumber: cursor.position.lineNumber,
            positionColumn: cursor.position.column,
        })))
        const anchor: IPosition = view.state.viewState.firstPosition
        // Monaco's saved delta is source-top minus scrollTop, including the
        // wrapped visual line and the partial pixel remainder.
        const top = value.getTopForPosition(anchor.lineNumber, anchor.column)
            - view.state.viewState.firstPositionDeltaTop
        value.setScrollPosition({ scrollTop: top, scrollLeft: view.left }, 1)
    }
}

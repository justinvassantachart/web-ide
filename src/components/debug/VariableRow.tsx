import { Handle, Position } from '@xyflow/react'
import { Codicon } from '@/components/ui/codicon'
import type { VariableNode } from '@/web-ide/contracts/runtime'
import type { DebugValueRef } from '@/web-ide/contracts/debug-presentation'
import { useDebugPresentation, useDebugPresentationService } from '@/web-ide/react/debug-presentation-state'
import { useWorkbenchDebugStore } from '@/web-ide/react/workbench-instance-context'

export type VariableRowProps = {
    variable: VariableNode
    depth: number
    resolvePointer?: (addr: number) => VariableNode[] | undefined
    label?: string
    detail?: string
    graph?: boolean
    ancestors?: readonly DebugValueRef[]
}

/** Both views render the same logical rows and keep expansion at instance scope. */
export function VariableRow({ variable, depth, label, detail, graph = false, ancestors = [] }: VariableRowProps) {
    const service = useDebugPresentationService()
    const ref = service.getRef(variable)
    const captured = service.readValue(ref) ?? variable
    const mode = useWorkbenchDebugStore(state => state.presentationMode)
    const stateKey = `${ref}:${mode}`
    const expanded = useWorkbenchDebugStore(state => state.expandedValues[stateKey] ?? false)
    const pages = useWorkbenchDebugStore(state => state.visiblePages[stateKey] ?? 1)
    const setExpanded = useWorkbenchDebugStore(state => state.setValueExpanded)
    const summary = useDebugPresentation(ref, { start: 0, count: 0 })
    const cycle = ancestors.includes(ref)
    const expandable = !cycle && depth < 8 && (summary?.total !== undefined
        ? summary.total > 0
        : (captured.members?.length ?? 0) > 0 || captured.isStruct === true || captured.childrenInfo?.complete === false)
    const name = label ?? variable.name
    const nextAncestors = [...ancestors, ref]
    const count = summary && summary.kind !== 'raw' && summary.kind !== 'scalar' && summary.total !== undefined
        ? summary.total === 0 ? ' · empty' : ` · ${summary.total} items` : ''
    const value = (summary?.summary ?? String(variable.value)) + count
    const isStringy = variable.type.includes('string') || variable.type === 'char'
    const valueClass = variable.isPointer ? 'text-[var(--color-accent-pointer)]'
        : isStringy ? 'text-[var(--color-accent-string)]' : 'text-[var(--color-accent-number)]'

    return (
        <div role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-label={name}
            data-debug-value={ref} data-debug-kind={summary?.kind ?? 'loading'}>
            <button type="button"
                aria-label={`${expandable ? expanded ? 'Collapse' : 'Expand' : 'Inspect'} ${name}`}
                onClick={() => { if (expandable) setExpanded(stateKey, !expanded) }}
                onKeyDown={event => {
                    if (!expandable || !['ArrowRight', 'ArrowLeft'].includes(event.key)) return
                    event.preventDefault()
                    setExpanded(stateKey, event.key === 'ArrowRight')
                }}
                className="relative group flex w-full items-center gap-1.5 px-2 py-1 rounded-sm font-mono text-[11.5px] text-left hover:bg-[var(--color-row-hover)] focus-visible:outline focus-visible:outline-primary"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                title={variable.address !== undefined ? `Address 0x${variable.address.toString(16)}` : undefined}>
                <Codicon name="chevron-right" size={12} className="shrink-0 text-muted-foreground"
                    style={{ visibility: expandable ? 'visible' : 'hidden', transform: expanded ? 'rotate(90deg)' : undefined }} />
                <span className="shrink-0 max-w-[40%] text-foreground truncate" title={name}>{name}</span>
                <span className="min-w-0 max-w-[25%] flex-1 text-[10px] text-[var(--color-accent-type)] truncate opacity-80" title={variable.type}>{variable.type}</span>
                <span className={`ml-auto min-w-0 max-w-[55%] shrink-0 text-right truncate ${valueClass}`} title={value}>{value.slice(0, 512)}</span>
                {graph && variable.address !== undefined && variable.address > 0 && <Handle type="target" position={Position.Left}
                    id={`${ref}-target`} className="!w-1 !h-1 !bg-transparent !border-0 !left-0 !opacity-0" />}
                {graph && variable.isPointer && variable.pointsTo !== undefined && variable.pointsTo !== 0 && <Handle type="source"
                    position={Position.Right} id={ref} className="!w-2 !h-2 !bg-primary !border-0 !-right-1" />}
            </button>
            {detail && <div className="px-6 text-[10px] font-mono text-muted-foreground">{detail}</div>}
            {summary?.message && <div className="px-6 text-[11px] text-muted-foreground" role="status">{summary.message}</div>}
            {cycle && <div className="px-6 text-[11px] text-muted-foreground">Already shown above</div>}
            {depth >= 8 && expandable === false && (summary?.total ?? 0) > 0 && <div className="px-6 text-[11px] text-muted-foreground">Expansion depth limit reached</div>}
            {expanded && expandable && (
                <div role="group">
                    {Array.from({ length: pages }, (_, index) => <ValuePage key={index} valueRef={ref} pageIndex={index}
                        depth={depth + 1} graph={graph} ancestors={nextAncestors} stateKey={stateKey} last={index === pages - 1} />)}
                </div>
            )}
        </div>
    )
}

function ValuePage({ valueRef, pageIndex, depth, graph, ancestors, stateKey, last }: {
    valueRef: DebugValueRef; pageIndex: number; depth: number; graph: boolean
    ancestors: readonly DebugValueRef[]; stateKey: string; last: boolean
}) {
    const service = useDebugPresentationService()
    const result = useDebugPresentation(valueRef, { start: pageIndex * 100, count: 100 })
    const mode = useWorkbenchDebugStore(state => state.presentationMode)
    const showNextPage = useWorkbenchDebugStore(state => state.showNextPage)
    if (!result) return <div className="px-6 py-1 text-[11px] text-muted-foreground" role="status">Loading values…</div>
    const end = result.start + result.children.length
    let captured = 0
    for (let page = 0; page <= pageIndex; page++) {
        captured += service.getPresentation(valueRef, { start: page * 100, count: 100 }, mode)?.children.length ?? 0
    }
    const more = result.total === undefined ? result.children.length === 100 : end < result.total
    return (
        <>
            {result.children.map(child => {
                const value = service.readValue(child.value)
                const key = child.keyValue && service.readValue(child.keyValue)
                return <div key={child.key}>
                    {key && <VariableRow variable={key} label={`${child.label} key`} depth={depth} graph={graph} ancestors={ancestors} />}
                    {value ? <VariableRow variable={value} label={key ? `${child.label} value` : child.label} detail={child.detail}
                        depth={depth} graph={graph} ancestors={ancestors} />
                        : <div className="px-6 text-[11px] text-muted-foreground">{child.label}: unavailable</div>}
                </div>
            })}
            {last && <div className="px-6 py-1 text-[11px] font-mono text-muted-foreground" role="status">
                {result.total !== undefined ? `Showing ${captured} of ${result.total}` : `${captured} captured`}
                {result.message && ` — ${result.message}`}
                {result.availability === 'unavailable' && !result.message && ' — unavailable'}
                {!result.complete && !result.message && result.availability !== 'unavailable' && ' — partially captured'}
            </div>}
            {last && more && result.complete && result.children.length === 100 && result.availability !== 'unavailable' && pageIndex < 9 &&
                <button type="button" className="mx-6 my-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
                    onClick={() => showNextPage(stateKey)}>Load more values</button>}
            {last && more && pageIndex >= 9 && <div className="px-6 text-[11px] text-muted-foreground">Display limit reached</div>}
        </>
    )
}

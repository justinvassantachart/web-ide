import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ReactFlow, Background, type Node, type Edge, type NodeChange, type EdgeChange, type ReactFlowInstance, Position, Handle, Panel, useViewport, useUpdateNodeInternals, applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorkbenchDebugStore } from '@/web-ide/react/workbench-instance-context'
import type {
    MemorySnapshot,
    VariableNode as MemoryValue,
} from '@/web-ide/contracts/runtime'
import { VariableRow } from './VariableRow'
import { DebugPresentationToggle } from './DebugPresentationToggle'
import { useDebugPresentationService } from '@/web-ide/react/debug-presentation-state'
import { placeStackFrames, placeHeapNodes, rowsToHeight, type Point } from './graph-layout'

function StackFrameNode({ data }: { data: { id: string; label: string; isActive: boolean; variables: MemoryValue[] } }) {
    const updateNodeInternals = useUpdateNodeInternals()
    useLayoutEffect(() => { updateNodeInternals(data.id) }, [data, updateNodeInternals])
    return (
        <div className={`flex flex-col rounded-md border bg-card min-w-[260px] shadow-2xl overflow-visible ${data.isActive ? 'border-primary' : 'border-border'}`}>
            {data.isActive && <div className="absolute -top-[1px] -left-[1px] -right-[1px] h-[2px] bg-primary rounded-t-md" />}
            <div className="px-3 py-2 bg-[var(--color-chrome)] border-b border-border flex justify-between items-center rounded-t-md">
                <span className="text-foreground font-bold text-[11px] font-mono uppercase tracking-wider">{data.label}</span>
                {data.isActive && <span className="bg-primary text-primary-foreground text-[9px] px-1.5 rounded-sm font-bold tracking-wider">PAUSED</span>}
            </div>
            <div className="flex flex-col w-full" role="tree" aria-label={`${data.label} values`}>
                {data.variables.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground italic text-center">No variables</div>
                ) : data.variables.map((variable, index) => {
                    return <VariableRow key={variable.debugRef ?? `${data.id}.${index}`} variable={variable} depth={0} graph />
                })}
            </div>
            <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
            <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
        </div>
    )
}

function HeapNode({ data }: { data: { id: string; label: string; ptr: number; members: MemoryValue[] } }) {
    const updateNodeInternals = useUpdateNodeInternals()
    useLayoutEffect(() => { updateNodeInternals(data.id) }, [data, updateNodeInternals])
    return (
        <div className="flex flex-col rounded-md border border-primary/40 bg-card min-w-[220px] shadow-2xl overflow-visible relative">
            <div className="px-3 py-2 bg-[var(--color-chrome)] border-b border-primary/30 flex justify-between items-center rounded-t-md">
                <span className="text-primary font-mono text-[10px] uppercase tracking-wider truncate mr-2" title={data.label}>{data.label}</span>
                <span className="text-muted-foreground font-mono text-[10px]">0x{data.ptr.toString(16).padStart(6, '0')}</span>
            </div>
            <div className="flex flex-col w-full" role="tree" aria-label={`${data.label} values`}>
                {data.members.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground italic text-center">Raw Data</div>
                ) : data.members.map((member, index) => {
                    return <VariableRow key={member.debugRef ?? `${data.id}.${index}`} variable={member} depth={0} graph />
                })}
            </div>
            <Handle type="target" position={Position.Left} id="target" className="!w-2 !h-2 !bg-primary !border-0 !-left-1 opacity-80" />
        </div>
    )
}

const nodeTypes = { stackFrame: StackFrameNode, heapNode: HeapNode }

// --- Graph Layout ---
// Geometry lives in graph-layout.ts (pure + unit-tested). The component's
// job is only to translate snapshots into node/edge specs and feed the
// persistent position map through the incremental placer.
/** Find the x-coordinate boundary between the fixed stack column and the start of the heap nodes */
function findSeparatorX(nodes: Node[]): number | null {
    const hasStack = nodes.some(n => n.type === 'stackFrame')
    const hasHeap = nodes.some(n => n.type === 'heapNode')
    if (hasStack && hasHeap) return 300
    return null
}

/** Viewport-aware separator that stays aligned with the ReactFlow coordinate system */
function SeparatorOverlay({ separatorX }: { separatorX: number }) {
    const { x, zoom } = useViewport()
    const screenX = separatorX * zoom + x

    return (
        <svg
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 5,
            }}
        >
            <line
                x1={screenX}
                y1={0}
                x2={screenX}
                y2="100%"
                stroke="oklch(0.3 0 0)"
                strokeWidth={1}
                strokeDasharray="6 4"
            />
            <text
                x={screenX + 16}
                y={20}
                fill="oklch(0.6 0 0)"
                fontSize={10}
                fontFamily="monospace"
                textAnchor="start"
            >
                REPORTED MEMORY OBJECTS
            </text>
        </svg>
    )
}

export function MemoryVisualizer() {
    const { debugMode, memorySnapshot, presentationMode, expandedValues, visiblePages } = useWorkbenchDebugStore()
    const service = useDebugPresentationService()
    const presentationRevision = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const [separatorX, setSeparatorX] = useState<number | null>(null)
    const flowRef = useRef<ReactFlowInstance | null>(null)

    // Positions persist across snapshots for the whole debug session — this
    // is what makes stepping incremental: a node that was on screen at the
    // last pause stays exactly where it was (including where the user
    // dragged it), and entries survive nodes that temporarily leave the
    // snapshot so debugger history navigation restores the same picture.
    // Cleared when the session ends (snapshot becomes null). Held in state
    // (not a ref) because it's read during render by rebuildGraph.
    const [positions, setPositions] = useState<ReadonlyMap<string, Point>>(new Map())

    // Rebuild the graph when a new snapshot arrives, using the
    // adjust-state-during-render pattern (guarded by a previous-value
    // comparison) instead of an effect — avoids the extra stale-frame
    // render an effect-based sync would paint first. Node state stays
    // local because users can drag heap nodes between snapshots.
    // rebuildGraph is idempotent (same snapshot + same position map →
    // same placement), so StrictMode's double render is safe.
    const [syncedView, setSyncedView] = useState<{
        snapshot: MemorySnapshot | null; mode: string; expanded: object; pages: object; revision: number
    } | null>(null)
    if (memorySnapshot !== syncedView?.snapshot || presentationMode !== syncedView?.mode
        || expandedValues !== syncedView?.expanded || visiblePages !== syncedView?.pages
        || presentationRevision !== syncedView?.revision) {
        setSyncedView({ snapshot: memorySnapshot, mode: presentationMode, expanded: expandedValues, pages: visiblePages, revision: presentationRevision })
        if (!memorySnapshot) {
            setPositions(new Map())
            setNodes([])
            setEdges([])
            setSeparatorX(null)
        } else {
            rebuildGraph(memorySnapshot)
        }
    }

    function rebuildGraph(snapshot: MemorySnapshot) {
        const rawNodes: Node[] = []
        const rawEdges: Edge[] = []
        const reversedFrames = [...snapshot.frames].reverse()

        // Only visible, captured addresses participate in physical pointer edges.
        // Logical container membership is rendered as indented rows in each card.
        const addressMap = new Map<number, { nodeId: string; handleId: string }>()
        const visible = new Map<string, MemoryValue[]>()
        const collect = (values: MemoryValue[], id: string, depth = 0, seen = new Set<string>()) => {
            const rows = visible.get(id) ?? []
            visible.set(id, rows)
            for (const value of values) {
                const ref = service.getRef(value)
                if (seen.has(ref) || rows.length >= 1000) continue
                seen.add(ref)
                rows.push(value)
                if (value.address !== undefined && value.address > 0 && !addressMap.has(value.address)) {
                    addressMap.set(value.address, { nodeId: id, handleId: `${ref}-target` })
                }
                const stateKey = `${ref}:${presentationMode}`
                if (!expandedValues[stateKey] || depth >= 8) continue
                const pages = visiblePages[stateKey] ?? 1
                for (let page = 0; page < pages; page++) {
                    const result = service.getPresentation(ref, { start: page * 100, count: 100 }, presentationMode)
                    for (const child of result?.children ?? []) {
                        for (const childRef of [child.keyValue, child.value]) {
                            const childValue = childRef && service.readValue(childRef)
                            if (childValue) collect([childValue], id, depth + 1, seen)
                        }
                    }
                }
            }
        }
        for (const frame of snapshot.frames) collect(frame.variables, frame.id)
        for (const alloc of snapshot.heapAllocations) {
            addressMap.set(alloc.ptr, { nodeId: `heap-${alloc.ptr}`, handleId: 'target' })
            collect(alloc.members, `heap-${alloc.ptr}`)
        }
        const extractEdges = (id: string, active: boolean) => {
            for (const value of visible.get(id) ?? []) {
                if (!value.isPointer || !value.pointsTo) continue
                const target = addressMap.get(value.pointsTo)
                if (!target) continue
                const sourceHandle = service.getRef(value)
                rawEdges.push({
                    id: `${id}/${sourceHandle}->${target.nodeId}/${target.handleId}`,
                    source: id, sourceHandle, target: target.nodeId, targetHandle: target.handleId,
                    type: 'bezier', animated: active,
                    style: { stroke: active ? 'oklch(0.75 0.12 230)' : 'oklch(0.6 0 0)', strokeWidth: 2 },
                })
            }
        }

        reversedFrames.forEach((frameData) => {
            rawNodes.push({
                id: frameData.id, type: 'stackFrame', position: { x: 0, y: 0 },
                draggable: false,
                data: { id: frameData.id, label: `${frameData.funcName}()`, isActive: frameData.isActive, variables: frameData.variables },
            })
            extractEdges(frameData.id, frameData.isActive)
        })

        snapshot.heapAllocations.forEach((alloc) => {
            const nodeId = `heap-${alloc.ptr}`
            rawNodes.push({
                id: nodeId, type: 'heapNode', position: { x: 0, y: 0 },
                draggable: true,
                data: { id: nodeId, label: alloc.typeName, ptr: alloc.ptr, members: alloc.members },
            })
            extractEdges(nodeId, false)
        })

        // Incremental placement: stack frames re-stack deterministically in
        // their fixed column (their DAP ids change every pause anyway); heap
        // nodes flow through the persistent position map so existing ones
        // never move and new ones are placed collision-free around them.
        const stackSpecs = rawNodes
            .filter(n => n.type === 'stackFrame')
            .map(n => ({ id: n.id, height: rowsToHeight(visible.get(n.id)?.length ?? 0) }))
        const stackPositions = placeStackFrames(stackSpecs)

        const heapSpecs = rawNodes
            .filter(n => n.type === 'heapNode')
            .map(n => ({ id: n.id, height: rowsToHeight(visible.get(n.id)?.length ?? 0) }))
        const heapIds = new Set(heapSpecs.map(s => s.id))
        const heapEdges = rawEdges
            .filter(e => heapIds.has(e.source) && heapIds.has(e.target))
            .map(e => ({ source: e.source, target: e.target }))
        // Rank-0 roots: heap nodes pointed to straight from stack variables.
        const roots = rawEdges
            .filter(e => !heapIds.has(e.source) && heapIds.has(e.target))
            .map(e => e.target)
        const heapPositions = placeHeapNodes({
            nodes: heapSpecs,
            edges: heapEdges,
            roots,
            previous: positions,
        })

        // Merge (not replace): absent nodes keep their remembered spot so
        // moving forward through history puts them back where they were.
        const merged = new Map(positions)
        for (const [id, pos] of heapPositions) merged.set(id, pos)
        setPositions(merged)

        setNodes(rawNodes.map(n => ({
            ...n,
            position: (n.type === 'stackFrame' ? stackPositions.get(n.id) : heapPositions.get(n.id))
                ?? { x: 0, y: 0 },
        })))
        setEdges(rawEdges)
        setSeparatorX(findSeparatorX(rawNodes))
    }

    // Only allow position changes for heap nodes - block stack node drags.
    // Dragged positions also go into the persistent map so the node stays
    // where the user put it on every subsequent snapshot.
    const onNodesChange = useCallback((changes: NodeChange[]) => {
        setNodes(nds => {
            const dragged = new Map<string, Point>()
            const filtered = changes.filter(change => {
                if (change.type === 'position') {
                    const node = nds.find(n => n.id === change.id)
                    if (node?.type === 'stackFrame') return false
                    if (change.position) dragged.set(change.id, change.position)
                }
                return true
            })
            if (dragged.size > 0) {
                setPositions(prev => {
                    const next = new Map(prev)
                    for (const [id, pos] of dragged) next.set(id, pos)
                    return next
                })
            }
            return applyNodeChanges(filtered, nds)
        })
    }, [])

    const onEdgesChange = useCallback((changes: EdgeChange[]) => {
        setEdges(eds => applyEdgeChanges(changes, eds))
    }, [])

    // The graph stays MOUNTED while the program runs between pauses
    // (step-over emits resumed→running→paused). Unmounting ReactFlow there
    // would throw away the viewport — every step would reset the user's
    // zoom/pan and re-fit the whole picture. Placeholders only show when
    // there is genuinely nothing to look at.
    if (debugMode === 'idle')
        return <div className="flex h-full items-center justify-center text-muted-foreground font-mono text-xs bg-background">Click <span className="text-primary mx-1">Debug</span> to inspect memory</div>
    if (debugMode === 'compiling' || (debugMode === 'running' && nodes.length === 0))
        return <div className="flex h-full items-center justify-center text-muted-foreground font-mono text-xs bg-background">{debugMode === 'compiling' ? 'Compiling…' : 'Running…'}</div>

    return (
        <div className="w-full h-full bg-background">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                onInit={(instance) => { flowRef.current = instance }}
                fitView
                minZoom={0.2}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
            >
                <Background gap={16} size={0.5} color="oklch(0.25 0 0)" />
                <Panel position="top-left" className="!m-0 !p-0">
                    <div className="flex gap-6 px-4 py-2">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                            Frames · indented rows are logical members · arrows show addresses
                        </span>
                    </div>
                </Panel>
                <Panel position="top-right" className="!m-1 flex items-center gap-2">
                    <DebugPresentationToggle />
                    {debugMode === 'running' && (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
                            Running…
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => flowRef.current?.fitView({ padding: 0.2, duration: 200 })}
                        title="Fit graph to view"
                        className="px-2 py-1 rounded border border-border bg-card text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-primary transition-colors"
                    >
                        Fit
                    </button>
                </Panel>
                {separatorX !== null && <SeparatorOverlay separatorX={separatorX} />}
            </ReactFlow>
        </div>
    )
}

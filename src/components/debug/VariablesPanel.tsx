import { useMemo, useState } from 'react'
import { useDebugStore } from '@/store/debug-store'
import type {
    HeapAllocation,
    StackFrame,
    VariableNode,
} from '@/web-ide/contracts/runtime'
import { VariableRow } from './VariableRow'

export function VariablesPanel() {
    const { callStack, debugMode, memorySnapshot } = useDebugStore()
    const frames: StackFrame[] = useMemo(
        () => callStack,
        [callStack],
    )
    const heap = useMemo(
        () => memorySnapshot?.heapAllocations ?? [],
        [memorySnapshot],
    )

    const heapByAddr = useMemo(() => {
        const m = new Map<number, VariableNode[]>()
        for (const alloc of heap) m.set(alloc.ptr, alloc.members)
        return m
    }, [heap])

    const resolvePointer = (addr: number) => heapByAddr.get(addr)

    // The selection only records explicit clicks; the rendered frame is
    // derived so a new snapshot keeps a still-valid selection and otherwise
    // falls back to the active frame — no state syncing in effects needed.
    const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null)

    if (debugMode === 'idle')
        return (
            <EmptyState>
                Click <span className="text-primary px-1">Debug</span> to inspect variables
            </EmptyState>
        )
    if (debugMode === 'compiling') return <EmptyState>Compiling…</EmptyState>
    if (debugMode === 'running') return <EmptyState>Running…</EmptyState>

    const selectedFrame =
        frames.find((f) => f.id === selectedFrameId) ??
        frames.find((f) => f.isActive) ??
        frames[0] ??
        null

    return (
        <aside className="flex flex-col h-full min-h-0 bg-background text-foreground">
            {frames.length > 0 && (
                <>
                    <div className="nova-panel-header">
                        <span className="nova-panel-label">Call Stack</span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                            {frames.length}
                        </span>
                    </div>
                    <div className="overflow-y-auto shrink-0" style={{ maxHeight: '38%' }}>
                        <CallStack
                            frames={frames}
                            selectedFrameId={selectedFrame?.id ?? null}
                            onSelectFrame={setSelectedFrameId}
                        />
                    </div>
                </>
            )}

            {selectedFrame && (
                <div className="nova-panel-header">
                    <span className="nova-panel-label">Variables</span>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto py-1">
                <Scope title="Locals" empty="No variables in scope">
                    {selectedFrame?.variables.map((v, index) => (
                        <VariableRow
                            key={`${v.name}-${index}`}
                            variable={v}
                            depth={0}
                            resolvePointer={resolvePointer}
                        />
                    ))}
                </Scope>
                {heap.length > 0 && <HeapScope heap={heap} resolvePointer={resolvePointer} />}
            </div>
        </aside>
    )
}

function EmptyState({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center text-muted-foreground font-mono text-xs bg-background">
            {children}
        </div>
    )
}

function CallStack({
    frames,
    selectedFrameId,
    onSelectFrame,
}: {
    frames: StackFrame[]
    selectedFrameId: string | null
    onSelectFrame: (id: string) => void
}) {
    return (
        <>
            {frames.map((f) => {
                const selected = selectedFrameId === f.id
                return (
                    <button
                        key={f.id}
                        type="button"
                        onClick={() => onSelectFrame(f.id)}
                        className={`block w-full text-left px-3 py-1 text-xs font-mono transition-colors border-l-2 ${
                            selected
                                ? 'border-primary bg-[var(--color-row-active)] text-foreground'
                                : 'border-transparent text-muted-foreground hover:bg-[var(--color-row-hover)] hover:text-foreground'
                        }`}
                    >
                        <span className="flex min-w-0 items-center">
                            <span className={selected ? 'font-semibold text-foreground' : ''}>
                                {f.funcName}
                            </span>
                            {f.isActive && (
                                <span className="ml-2 text-[9px] uppercase tracking-wider text-primary/90">
                                    paused
                                </span>
                            )}
                        </span>
                        <span
                            className="block truncate text-[10px] text-muted-foreground/70"
                            title={f.file}
                        >
                            {formatFrameSource(f)}
                        </span>
                    </button>
                )
            })}
        </>
    )
}

function formatFrameSource(frame: StackFrame) {
    const fileName = frame.file?.split('/').pop()
    if (fileName) return `${fileName}:${frame.line}`
    return `line ${frame.line}`
}

function Scope({
    title,
    empty,
    children,
}: {
    title: string
    empty: string
    children: React.ReactNode
}) {
    const arr = Array.isArray(children) ? children : [children]
    const hasContent = arr.some((c) => c != null && c !== false)
    return (
        <div className="mb-2">
            <div className="nova-section-label">{title}</div>
            {hasContent ? (
                <div className="pl-1">{children}</div>
            ) : (
                <div className="px-3 py-1 text-[11px] text-muted-foreground italic font-mono">
                    {empty}
                </div>
            )}
        </div>
    )
}

function HeapScope({
    heap,
    resolvePointer,
}: {
    heap: HeapAllocation[]
    resolvePointer: (addr: number) => VariableNode[] | undefined
}) {
    return (
        <div className="mb-2">
            <div className="nova-section-label">Heap</div>
            <div className="pl-1">
                {heap.map((alloc) => {
                    const synthetic: VariableNode = {
                        name: alloc.label,
                        type: alloc.typeName,
                        value: `0x${alloc.ptr.toString(16)}`,
                        rawValue: alloc.ptr,
                        address: alloc.ptr,
                        size: 4,
                        isPointer: false,
                        isStruct: true,
                        members: alloc.members,
                    }
                    return (
                        <VariableRow
                            key={alloc.ptr}
                            variable={synthetic}
                            depth={0}
                            resolvePointer={resolvePointer}
                        />
                    )
                })}
            </div>
        </div>
    )
}

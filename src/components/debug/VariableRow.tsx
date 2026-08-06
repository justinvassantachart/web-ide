import { useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import type { VariableNode } from '@/web-ide/contracts/runtime'

export type VariableRowProps = {
    variable: VariableNode
    depth: number
    /** Resolve children for pointers (heap lookup) — return undefined if nothing to show. */
    resolvePointer?: (addr: number) => VariableNode[] | undefined
}

export function VariableRow({ variable, depth, resolvePointer }: VariableRowProps) {
    const [expanded, setExpanded] = useState(false)

    const structChildren = variable.isStruct && variable.members ? variable.members : null
    const pointerChildren =
        variable.isPointer && variable.pointsTo !== undefined && resolvePointer
            ? resolvePointer(variable.pointsTo) ?? null
            : null
    const children = structChildren ?? pointerChildren
    const expandable = !!children && children.length > 0

    const toggle = () => expandable && setExpanded((e) => !e)

    const displayValue =
        variable.isStruct && variable.value === '{...}' ? '' : String(variable.value)

    const isStringy = variable.type.includes('string') || variable.type.includes('char')
    const valueClass = variable.isPointer
        ? 'text-[var(--color-accent-pointer)]'
        : isStringy
        ? 'text-[var(--color-accent-string)]'
        : 'text-[var(--color-accent-number)]'

    return (
        <div>
            <div
                onClick={toggle}
                className="group flex items-center gap-1.5 px-2 py-[3px] rounded-sm font-mono text-[11.5px] hover:bg-[var(--color-row-hover)] transition-colors"
                style={{
                    paddingLeft: `${depth * 12 + 8}px`,
                    cursor: expandable ? 'pointer' : 'default',
                }}
                title={
                    variable.address !== undefined && variable.address > 0
                        ? `0x${variable.address.toString(16).padStart(8, '0')}`
                        : undefined
                }
            >
                <Codicon
                    name="chevron-right"
                    size={12}
                    className="shrink-0 text-muted-foreground transition-transform"
                    style={{
                        visibility: expandable ? 'visible' : 'hidden',
                        transform: expanded ? 'rotate(90deg)' : undefined,
                    }}
                />
                <span className="text-foreground truncate">{variable.name}</span>
                {variable.type && (
                    <span className="text-[10px] text-[var(--color-accent-type)] truncate opacity-80">
                        {variable.type}
                    </span>
                )}
                <span className={`ml-auto text-right truncate ${valueClass}`}>{displayValue}</span>
            </div>
            {expanded && children && (
                <>
                    {children.map((child, index) => (
                        <VariableRow
                            key={`${child.name}-${index}`}
                            variable={child}
                            depth={depth + 1}
                            resolvePointer={resolvePointer}
                        />
                    ))}
                </>
            )}
        </div>
    )
}

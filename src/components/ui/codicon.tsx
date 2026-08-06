// Thin wrapper around the @vscode/codicons font.
// The CSS is imported once globally in main.tsx; this component just emits
// the right class name. The font sets size via font-size, so callers control
// the rendered icon size with the `size` prop (defaults to 16, VS Code's standard).

import type { CSSProperties } from 'react'

export function Codicon({
    name, size, className = '', style, spin = false,
}: {
    name: string
    size?: number
    className?: string
    style?: CSSProperties
    spin?: boolean
}) {
    const mergedStyle: CSSProperties = size ? { fontSize: size, ...style } : style ?? {}
    const cls = `codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''} ${className}`
    return <span className={cls} aria-hidden="true" style={mergedStyle} />
}

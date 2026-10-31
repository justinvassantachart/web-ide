import {
  Group, Panel, Separator,
  type GroupProps, type PanelProps, type SeparatorProps,
} from "react-resizable-panels"

import { cn } from "@/lib/utils"

// VS Code's sash is 4px wide (`--vscode-sash-size`, sash.css). The library's
// default fine-pointer hit target is 10px, which reaches 5px into the editor
// and steals the first columns of the breakpoint glyph margin.
const VSCODE_SASH_HIT_TARGET = { coarse: 20, fine: 4 }

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      resizeTargetMinimumSize={VSCODE_SASH_HIT_TARGET}
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  )
}

// VS Code parts never scroll as a whole; each view owns its own scrolling.
// The library wraps panel content in a div that defaults to `overflow: auto`,
// which let a few pixels of xterm's off-screen live region scroll the entire
// terminal. Callers can still opt back in through `style`.
function ResizablePanel({ style, ...props }: PanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      style={{ overflow: "hidden", ...style }}
      {...props}
    />
  )
}

// The sash: a 1px border line with a 4px hit area centered on it. Geometry
// and the `sash.hoverBorder` highlight live in index.css and key off the
// `aria-orientation` and `data-separator` state the library sets, so both
// orientations share one rule set and the highlight tracks the real drag.
function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn("web-ide-sash", className)}
      {...props}
    />
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }

import { useCallback, useState } from 'react'
import { Dialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
export interface ExecutedSource { path: string; line: number; text: string }
/** A separate read-only source surface; never replace or decorate edited workspace text. */
export function ExecutedSourceDialog({ source, close }: { source?: ExecutedSource; close(): void }) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const anchor = useCallback((node: HTMLSpanElement | null) => setContainer(node?.closest<HTMLElement>('.web-ide-root') ?? null), [])
  const lines = source?.text.split('\n') ?? []
  const start = Math.max(0, (source?.line ?? 1) - 12), end = Math.min(lines.length, (source?.line ?? 1) + 12)
  return <Dialog.Root open={!!source} onOpenChange={open => { if (!open) close() }}>
    <span ref={anchor} hidden aria-hidden="true" />
    <Dialog.Portal container={container}>
      <Dialog.Overlay className="fixed inset-0 bg-black/50 z-[100]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-[min(90vw,900px)] max-h-[85vh] overflow-auto rounded border border-border bg-background p-5 text-foreground shadow-xl">
        <Dialog.Title className="font-semibold">Executed source snapshot</Dialog.Title>
        <Dialog.Description className="text-sm text-muted-foreground my-2">Read only · {source?.path}:{source?.line}. These are the bytes used by this test run. Your current source remains unchanged.</Dialog.Description>
        <pre tabIndex={0} aria-label="Executed source" className="overflow-auto my-3 text-xs font-mono p-3 bg-muted rounded">{lines.slice(start, end).map((line, offset) => <div key={start + offset} className={start + offset + 1 === source?.line ? 'bg-amber-500/20' : undefined}>{String(start + offset + 1).padStart(4)} {line || ' '}</div>)}</pre>
        <div className="text-xs text-muted-foreground mb-3">Lines {start + 1}–{end} of {lines.length}</div>
        <Dialog.Close asChild><Button variant="outline" size="sm">Close source snapshot</Button></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

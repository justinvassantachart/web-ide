import { useWorkbenchDebugStore } from '@/web-ide/react/workbench-instance-context'

export function DebugPresentationToggle() {
  const mode = useWorkbenchDebugStore(state => state.presentationMode)
  const setMode = useWorkbenchDebugStore(state => state.setPresentationMode)
  return (
    <div role="group" aria-label="Debugger display" className="inline-flex rounded border border-border bg-background p-0.5 text-[11px] font-mono">
      {(['pretty', 'raw'] as const).map(value => (
        <button key={value} type="button" aria-pressed={mode === value}
          onClick={() => setMode(value)}
          className={`rounded px-2 py-1 ${mode === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
          {value === 'pretty' ? 'Pretty' : 'Raw'}
        </button>
      ))}
    </div>
  )
}

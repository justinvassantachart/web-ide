import { Fragment, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useWorkbenchExecutionStore, useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'
import type { TestReportEventPayloadV2 } from '@/web-ide/contracts/testing'
import type { IDEPanelServices } from '@/web-ide/contracts/contributions'
import { useSelectedTestProvider } from './use-test-provider'
import { useTestingSnapshot } from './use-testing-snapshot'
import { ExecutedSourceDialog, type ExecutedSource } from './ExecutedSourceDialog'

const terminalTypes = new Set(['test_passed', 'test_failed', 'test_errored', 'test_skipped'])

export function TestsPanel({ source }: Pick<IDEPanelServices, 'source'>) {
  const instance = useWorkbenchInstance()
  const provider = useSelectedTestProvider()
  const { controller, snapshot } = useTestingSnapshot()
  const [executedSource, setExecutedSource] = useState<ExecutedSource>()
  const isCompiling = useWorkbenchExecutionStore(state => state.isCompiling)
  const isRunning = useWorkbenchExecutionStore(state => state.isRunning)
  const [selection, setSelection] = useState<readonly string[]>()
  useEffect(() => { if (controller?.snapshot().state === 'idle') void controller.discover() }, [controller])
  const fileGroup = (test: typeof snapshot.tests[number]) => test.location?.path ?? test.group ?? 'Runtime discovered'
  const displayedTests = [...snapshot.tests, ...(snapshot.liveTests ?? []).filter(test => !snapshot.tests.some(existing => existing.id === test.id))].sort((a, b) => fileGroup(a).localeCompare(fileGroup(b)))
  const ids = (snapshot.stale && snapshot.liveTests ? snapshot.liveTests : displayedTests).map(test => test.id)
  const selected = selection ? selection.filter(id => ids.includes(id)) : ids
  const active = snapshot.state === 'running'
  const busy = active || snapshot.state === 'discovering' || isCompiling || isRunning
  const results = new Map<string, TestReportEventPayloadV2>()
  let terminated: Extract<TestReportEventPayloadV2, { type: 'run_terminated' }> | undefined
  let finished: Extract<TestReportEventPayloadV2, { type: 'run_finished' }> | undefined
  for (const { event } of snapshot.events) {
    if ('testId' in event && event.testId && (event.type === 'test_started' || terminalTypes.has(event.type))) results.set(event.testId, event)
    if (event.type === 'run_terminated') terminated = event
    if (event.type === 'run_finished') finished = event
  }
  const count = (type: string) => [...results.values()].filter(event => event.type === type).length
  const passed = count('test_passed'), failed = count('test_failed'), errored = count('test_errored'), skipped = count('test_skipped')
  const completed = passed + failed + errored + skipped
  const run = (mode: 'run' | 'debug', all = false) => void controller?.run({ mode, selection: all ? { kind: 'all' } : { kind: 'tests', testIds: selected } }).catch(() => undefined)
  const reveal = (path?: string, line?: number, column?: number, error = false) => {
    if (!path || !line) return
    const original = snapshot.sourceFiles?.[path]
    if (original !== undefined && original !== instance.workspace.snapshot()[path]) {
      source.replaceDecorations([])
      setExecutedSource({ path, line, text: original })
      return
    }
    try { if (error) source.replaceDecorations([{ path, line, ...(column ? { column } : {}), kind: 'error' }]); source.reveal({ path, line, ...(column ? { column } : {}) }) } catch { /* Invalid/stale locations are inert. */ }
  }
  return <aside aria-label="Tests" className="flex flex-col h-full min-h-0 bg-background text-foreground">
    <div className="nova-panel-header flex-wrap gap-1">
      <span className="nova-panel-label mr-auto">Tests</span>
      <Button size="sm" variant="ghost" disabled={!controller || busy} onClick={() => void controller?.discover()}>Refresh</Button>
      <Button size="sm" variant="ghost" disabled={!controller || busy} onClick={() => run('run', true)}>Run All</Button>
      <Button size="sm" variant="ghost" disabled={!controller || busy || !selected.length} onClick={() => run('run')}>Run Selected</Button>
      <Button size="sm" variant="ghost" disabled={!controller || busy || !selected.length} onClick={() => run('debug')}>Debug Selected</Button>
      <Button size="sm" variant="ghost" disabled={!active} onClick={() => void controller?.stop()}>Stop</Button>
    </div>
    <div role="status" className="px-3 py-2 text-xs font-mono space-y-1">
      {snapshot.stale && <div className="text-amber-500">Stale results — source changed after this run started. Locations refer to the executed source.</div>}
      {active && <div><Codicon name="loading" size={12} spin /> {isCompiling ? 'Preparing tests…' : 'Running tests…'}</div>}
      {snapshot.state === 'discovering' && <div>Discovering tests…</div>}
      {snapshot.events.length > 0 && <div>{passed} passed · {failed} failed · {errored} errored · {skipped} skipped · {completed} completed{finished?.durationMs !== undefined ? ` · ${Math.round(finished.durationMs)}ms` : ''}</div>}
      {finished && !completed && <div>No tests ran.</div>}
      {terminated && <div className="text-red-400">Run {terminated.reason.replaceAll('_', ' ')}{terminated.message ? `: ${terminated.message}` : ''}</div>}
      {snapshot.error && <div role="alert" className="text-red-400">{snapshot.error}</div>}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto py-1">
      {!snapshot.tests.length && !busy && <div className="px-3 py-3 text-xs text-muted-foreground">{controller ? 'No tests discovered.' : 'Loading test support…'} {provider?.help?.message}{provider?.help?.examples?.map((example, index) => <pre key={index} className="mt-2 whitespace-pre-wrap">{example.code}</pre>)}</div>}
      {displayedTests.map((test, index) => {
        const event = results.get(test.id)
        const terminal = event && terminalTypes.has(event.type) ? event as Extract<TestReportEventPayloadV2, { type: 'test_passed' | 'test_failed' | 'test_skipped' | 'test_errored' }> : undefined
        const failedRow = event?.type === 'test_failed' || event?.type === 'test_errored'
        const interrupted = event?.type === 'test_started' && !!terminated
        const location = terminal?.path ? { path: terminal.path, line: terminal.line, column: terminal.column } : test.location
        const checked = selected.includes(test.id)
        return <Fragment key={test.id}>
          {(index === 0 || fileGroup(displayedTests[index - 1]) !== fileGroup(test)) && <h3 className="px-3 py-2 text-xs font-semibold break-all bg-muted/40">{fileGroup(test)}</h3>}
          <div className={`border-l-2 ${failedRow || interrupted ? 'border-red-500' : event?.type === 'test_passed' ? 'border-emerald-500' : 'border-transparent'}`}>
          <div className="flex items-start gap-2 px-3 py-2 text-xs font-mono">
            <input aria-label={`Select ${test.name}`} type="checkbox" checked={checked} disabled={busy || !ids.includes(test.id)} onChange={() => setSelection(checked ? selected.filter(id => id !== test.id) : [...selected, test.id])} />
            <Codicon name={failedRow || interrupted ? 'error' : event?.type === 'test_passed' ? 'check' : event?.type === 'test_skipped' ? 'circle-slash' : event?.type === 'test_started' ? 'loading' : 'circle-large-outline'} size={12} spin={event?.type === 'test_started' && !terminated} />
            <div className="min-w-0 flex-1">
              <button type="button" className="text-left break-words hover:underline" onClick={() => reveal(test.location?.path, test.location?.line, test.location?.column)}>{test.name}</button>
              <div className="text-[10px] text-muted-foreground break-all"><span className="inline-block rounded border border-border px-1 capitalize">{test.origin}</span>{!ids.includes(test.id) && <span className="ml-1 text-amber-500">Previous run</span>} · {test.group ?? test.location?.path ?? 'runtime discovered'}{terminal?.durationMs !== undefined ? ` · ${Math.round(terminal.durationMs)}ms` : ''}{interrupted ? ' · interrupted' : !event && snapshot.events.length ? ' · not run' : ''}</div>
            </div>
          </div>
          {(failedRow || event?.type === 'test_skipped') && terminal && <div className="pl-9 pr-3 pb-3 space-y-1 text-xs font-mono">
            <div className="whitespace-pre-wrap text-red-400">{terminal.message}</div>
            {terminal.actual && <div className="whitespace-pre-wrap break-words">actual {terminal.actual.expression} = {terminal.actual.value}</div>}
            {terminal.expected && <div className="whitespace-pre-wrap break-words">expected {terminal.expected.expression} = {terminal.expected.value}</div>}
            {terminal.details && <pre className="whitespace-pre-wrap break-words text-muted-foreground">{terminal.details}</pre>}
            {location?.line && <button type="button" className="hover:underline text-muted-foreground" onClick={() => reveal(location.path, location.line, location.column, failedRow)}>{location.path.split('/').pop()}:{location.line}</button>}
          </div>}
        </div></Fragment>
      })}
    </div>
    <ExecutedSourceDialog source={executedSource} close={() => setExecutedSource(undefined)} />
  </aside>
}

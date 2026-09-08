import { useEffect, useState, useSyncExternalStore } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { Button } from '@/components/ui/button'
import {
    useWorkbenchExecutionStore,
    useWorkbenchTestStore,
} from '@/web-ide/react/workbench-instance-context'
import type {
    TestAssertion,
    TestDiagnostic,
    TestLocation,
    TestReportEventV2,
} from '@/web-ide/contracts/testing'
import type { IDEPanelServices } from '@/web-ide/contracts/contributions'
import type { TestCase } from './test-store'
import { useSelectedTestProvider } from './use-test-provider'
import { isTestProviderV2 } from './test-execution'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'

export function TestsPanel({ source }: Pick<IDEPanelServices, 'source'>) {
    const tests = useWorkbenchTestStore((s) => s.tests)
    const isTesting = useWorkbenchTestStore((s) => s.isTesting)
    const totalCount = useWorkbenchTestStore((s) => s.totalCount)
    const completedCount = useWorkbenchTestStore((s) => s.completedCount)
    const isCompiling = useWorkbenchExecutionStore((s) => s.isCompiling)
    const provider = useSelectedTestProvider()

    if (provider && isTestProviderV2(provider)) {
        return <TestsPanelV2 source={source} />
    }
    const help = provider && !isTestProviderV2(provider) ? provider.help : undefined

    if (tests.length === 0 && !isTesting && !isCompiling) {
        return (
            <aside className="flex flex-col items-center justify-center h-full min-h-0 bg-background text-muted-foreground text-xs font-mono gap-3 p-6 text-center">
                <Codicon name="beaker" size={28} className="opacity-60" />
                <div>
                    Click <span className="text-primary">Tests</span> in the toolbar to run your tests
                </div>
                <div className="opacity-80 leading-relaxed">
                    {help ? (
                        <>
                            {help.message}{' '}
                            {help.examples?.map((example, index) => (
                                <span key={`${example.code}:${index}`}>
                                    {example.prefix && <>{example.prefix}{' '}</>}
                                    <code className="text-foreground/80">{example.code}</code>{' '}
                                </span>
                            ))}
                        </>
                    ) : 'Add tests supported by the selected language provider.'}
                </div>
            </aside>
        )
    }

    const passed = tests.filter((t) => t.status === 'pass').length
    const failed = tests.filter((t) => t.status === 'fail' || t.status === 'error').length
    const skipped = tests.filter((t) => t.status === 'skip').length
    const running = tests.filter((t) => t.status === 'running').length

    return (
        <aside className="flex flex-col h-full min-h-0 bg-background text-foreground">
            <div className="nova-panel-header">
                <span className="nova-panel-label">Tests</span>
                <div className="flex items-center gap-3 text-[10px] font-mono">
                    {isCompiling ? (
                        <span className="text-primary flex items-center gap-1">
                            <Codicon name="loading" size={10} spin /> compiling
                        </span>
                    ) : (
                        <>
                            <span className="text-muted-foreground">
                                {completedCount}/{totalCount || tests.length}
                            </span>
                            {passed > 0 && <span className="text-emerald-500">{passed} passed</span>}
                            {failed > 0 && <span className="text-red-500">{failed} failed</span>}
                            {skipped > 0 && <span className="text-amber-500">{skipped} skipped</span>}
                            {running > 0 && (
                                <span className="text-primary flex items-center gap-1">
                                    <Codicon name="loading" size={10} spin /> {running}
                                </span>
                            )}
                        </>
                    )}
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-1">
                {tests.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] font-mono text-muted-foreground italic">
                        {isCompiling ? 'Compiling tests…' : 'Waiting for results…'}
                    </div>
                ) : (
                    tests.map((t, i) => <TestRow key={i} test={t} source={source} />)
                )}
            </div>
        </aside>
    )
}

function TestsPanelV2({ source }: Pick<IDEPanelServices, 'source'>) {
    const instance = useWorkbenchInstance()
    const controller = useSyncExternalStore(
        instance.testingV2.subscribe,
        instance.testingV2.snapshot,
        instance.testingV2.snapshot,
    )
    const snapshot = useSyncExternalStore(
        controller?.subscribe ?? noSubscribe,
        controller?.snapshot ?? emptyTestingV2Snapshot,
        controller?.snapshot ?? emptyTestingV2Snapshot,
    )
    const [selectionState, setSelectionState] = useState<{
        catalogDigest: string | undefined
        testIds: readonly string[]
    }>({ catalogDigest: undefined, testIds: [] })

    useEffect(() => {
        if (controller?.snapshot().state === 'idle') {
            void controller.discover().catch(() => undefined)
        }
    }, [controller, snapshot.state])

    const available = new Set(snapshot.tests.map(({ id }) => id))
    const selected = selectionState.catalogDigest === snapshot.catalogDigest
        ? selectionState.testIds.filter((id) => available.has(id))
        : snapshot.tests.map(({ id }) => id)

    const run = (mode: 'run' | 'debug', all = false) => {
        if (!controller) return
        const selection = all
            ? { kind: 'all' as const }
            : { kind: 'tests' as const, testIds: selected }
        void controller.run({ mode, selection }).catch(() => undefined)
    }
    const terminalByTest = testingV2TerminalStates(snapshot.events)
    const busy = snapshot.state === 'discovering' || snapshot.state === 'running'

    return (
        <aside className="flex flex-col h-full min-h-0 bg-background text-foreground">
            <div className="nova-panel-header gap-2">
                <span className="nova-panel-label mr-auto">Tests</span>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!controller || busy}
                    onClick={() => void controller?.discover().catch(() => undefined)}
                >
                    Refresh
                </Button>
                <Button size="sm" variant="ghost" disabled={!controller || busy} onClick={() => run('run', true)}>
                    Run All
                </Button>
                <Button size="sm" variant="ghost" disabled={!controller || busy || selected.length === 0} onClick={() => run('run')}>
                    Run Selected
                </Button>
                <Button size="sm" variant="ghost" disabled={!controller || busy || selected.length === 0} onClick={() => run('debug')}>
                    Debug Selected
                </Button>
                <Button size="sm" variant="ghost" disabled={!controller || snapshot.state !== 'running'} onClick={() => void controller?.stop()}>
                    Stop
                </Button>
            </div>
            {busy && (
                <div className="px-3 py-2 text-[11px] font-mono text-primary flex items-center gap-1">
                    <Codicon name="loading" size={10} spin /> {snapshot.state}
                </div>
            )}
            {snapshot.error && (
                <div role="alert" className="px-3 py-2 text-[11px] font-mono text-red-400">
                    {snapshot.error}
                </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
                {snapshot.tests.length === 0 && !busy ? (
                    <div className="px-3 py-3 text-[11px] font-mono text-muted-foreground italic">
                        {controller ? 'No tests discovered.' : 'Loading test support…'}
                    </div>
                ) : snapshot.tests.map((test) => {
                    const checked = selected.includes(test.id)
                    const state = terminalByTest.get(test.id)
                    return (
                        <div key={test.id} className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono">
                            <input
                                aria-label={`Select ${test.name}`}
                                type="checkbox"
                                checked={checked}
                                disabled={busy}
                                onChange={() => setSelectionState({
                                    catalogDigest: snapshot.catalogDigest,
                                    testIds: checked
                                        ? selected.filter((id) => id !== test.id)
                                        : [...selected, test.id],
                                })}
                            />
                            <TestingV2StatusIcon state={state} />
                            <button
                                type="button"
                                className="truncate text-left hover:underline"
                                onClick={() => test.location && openLocation({
                                    file: test.location.path,
                                    line: test.location.line,
                                    column: test.location.column,
                                }, source)}
                            >
                                {test.name}
                            </button>
                        </div>
                    )
                })}
            </div>
        </aside>
    )
}

const EMPTY_TESTING_V2_SNAPSHOT = Object.freeze({
    state: 'idle' as const,
    tests: Object.freeze([]),
    events: Object.freeze([]),
})
const noSubscribe = () => () => undefined
const emptyTestingV2Snapshot = () => EMPTY_TESTING_V2_SNAPSHOT

function testingV2TerminalStates(events: readonly TestReportEventV2[]) {
    const states = new Map<string, TestReportEventV2['event']['type']>()
    for (const { event } of events) {
        if ('testId' in event && event.testId) states.set(event.testId, event.type)
    }
    return states
}

function TestingV2StatusIcon({ state }: { state: TestReportEventV2['event']['type'] | undefined }) {
    if (state === 'test_passed') return <Codicon name="check" size={12} className="text-emerald-500" />
    if (state === 'test_failed' || state === 'test_errored') return <Codicon name="error" size={12} className="text-red-500" />
    if (state === 'test_skipped') return <Codicon name="circle-slash" size={12} className="text-amber-500" />
    if (state === 'test_started') return <Codicon name="loading" size={12} spin className="text-primary" />
    return <Codicon name="circle-large-outline" size={12} className="text-muted-foreground" />
}

function TestRow({
    test,
    source,
}: {
    test: TestCase
    source: IDEPanelServices['source']
}) {
    const failedAsserts = test.assertions.filter((assertion) => assertion.status === 'fail')
    const showDetails = (test.status === 'fail' || test.status === 'error')
        && (failedAsserts.length > 0 || test.diagnostics.length > 0)

    const borderColor =
        test.status === 'pass' ? 'border-emerald-500/60'
        : test.status === 'fail' || test.status === 'error' ? 'border-red-500/70'
        : test.status === 'skip' ? 'border-amber-500/60'
        : 'border-primary/50'

    return (
        <div className={`border-l-2 ${borderColor}`}>
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono">
                <StatusIcon status={test.status} />
                <span className="truncate">{test.name}</span>
                {test.durationMs !== undefined && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                        {Math.round(test.durationMs)}ms
                    </span>
                )}
            </div>

            {showDetails && (
                <div className="pl-7 pr-3 pb-2 space-y-2">
                    {failedAsserts.map((a, i) => (
                        <AssertRow key={i} assert={a} source={source} />
                    ))}
                    {test.diagnostics.map((diagnostic, i) => (
                        <DiagnosticRow key={i} diagnostic={diagnostic} source={source} />
                    ))}
                </div>
            )}
        </div>
    )
}

function StatusIcon({ status }: { status: TestCase['status'] }) {
    if (status === 'pass') {
        return <Codicon name="check" size={12} className="text-emerald-500 shrink-0" />
    }
    if (status === 'fail') {
        return <Codicon name="error" size={12} className="text-red-500 shrink-0" />
    }
    if (status === 'error') {
        return <Codicon name="warning" size={12} className="text-red-500 shrink-0" />
    }
    if (status === 'skip') {
        return <Codicon name="circle-slash" size={12} className="text-amber-500 shrink-0" />
    }
    return <Codicon name="loading" size={12} spin className="text-primary shrink-0" />
}

function openLocation(
    location: TestLocation | undefined,
    source: IDEPanelServices['source'],
) {
    const line = location?.line
    if (!location || line === undefined) return
    try {
        // __FILE__ from the compiler omits the /workspace/ prefix since
        // compile() strips it before mounting. Build the candidate inside the
        // rejection boundary because test protocol strings are untrusted.
        const candidate = location.file.startsWith('/workspace/')
            ? location.file
            : `/workspace/${location.file.replace(/^\/+/, '')}`
        source.replaceDecorations([{
            path: candidate,
            line,
            ...(location.column === undefined ? {} : { column: location.column }),
            kind: 'error',
        }])
        source.reveal({
            path: candidate,
            line,
            ...(location.column === undefined ? {} : { column: location.column }),
        })
    } catch {
        // Invalid paths/positions remain visible in the diagnostic text but
        // never escape the source boundary or trigger a filesystem lookup.
    }
}

function LocationButton({
    location,
    source,
}: {
    location: TestLocation | undefined
    source: IDEPanelServices['source']
}) {
    if (!location?.line) return null
    return (
        <button
            type="button"
            onClick={() => openLocation(location, source)}
            className="mt-1 text-[10px] text-muted-foreground/70 hover:text-foreground hover:underline"
        >
            {location.file.split('/').pop()}:{location.line}
        </button>
    )
}

function AssertRow({
    assert: assertion,
    source,
}: {
    assert: TestAssertion
    source: IDEPanelServices['source']
}) {
    const actual = assertion.actual
    const expected = assertion.expected

    return (
        <div className="text-[11px] font-mono border-l-2 border-red-500/30 pl-2">
            <div className="text-red-400">
                {assertion.message ?? 'Assertion failed'}
            </div>
            {actual && (
                <div className="mt-1 flex gap-1">
                    <span className="text-muted-foreground/70 shrink-0">actual</span>
                    <span className="text-foreground/60 truncate">{actual.expression}</span>
                    <span className="text-muted-foreground/70">=</span>
                    <span className="text-red-400 truncate">{actual.value}</span>
                </div>
            )}
            {expected && (
                <div className="flex gap-1">
                    <span className="text-muted-foreground/70 shrink-0">expected</span>
                    <span className="text-foreground/60 truncate">{expected.expression}</span>
                    <span className="text-muted-foreground/70">=</span>
                    <span className="text-emerald-400 truncate">{expected.value}</span>
                </div>
            )}
            <LocationButton location={assertion.location} source={source} />
        </div>
    )
}

function DiagnosticRow({
    diagnostic,
    source,
}: {
    diagnostic: TestDiagnostic
    source: IDEPanelServices['source']
}) {
    return (
        <div className="text-[11px] font-mono border-l-2 border-red-500/30 pl-2">
            <div className="text-red-400 whitespace-pre-wrap">{diagnostic.message}</div>
            {diagnostic.details && (
                <pre className="mt-1 whitespace-pre-wrap text-muted-foreground/80">
                    {diagnostic.details}
                </pre>
            )}
            <LocationButton location={diagnostic.location} source={source} />
        </div>
    )
}

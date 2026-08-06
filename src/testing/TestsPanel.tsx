import { Codicon } from '@/components/ui/codicon'
import { useEditorStore } from '@/store/editor-store'
import { useExecutionStore } from '@/store/execution-store'
import { fileExists, readFile } from '@/vfs/volume'
import type {
    TestAssertion,
    TestDiagnostic,
    TestLocation,
} from '@/web-ide/contracts/testing'
import type { TestCase } from './test-store'
import { useTestStore } from './test-store'
import { useSelectedTestProvider } from './use-test-provider'

export function TestsPanel() {
    const tests = useTestStore((s) => s.tests)
    const isTesting = useTestStore((s) => s.isTesting)
    const totalCount = useTestStore((s) => s.totalCount)
    const completedCount = useTestStore((s) => s.completedCount)
    const isCompiling = useExecutionStore((s) => s.isCompiling)
    const provider = useSelectedTestProvider()

    if (tests.length === 0 && !isTesting && !isCompiling) {
        return (
            <aside className="flex flex-col items-center justify-center h-full min-h-0 bg-background text-muted-foreground text-xs font-mono gap-3 p-6 text-center">
                <Codicon name="beaker" size={28} className="opacity-60" />
                <div>
                    Click <span className="text-primary">Tests</span> in the toolbar to run your tests
                </div>
                <div className="opacity-80 leading-relaxed">
                    {provider?.help ? (
                        <>
                            {provider.help.message}{' '}
                            {provider.help.examples?.map((example, index) => (
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
                    tests.map((t, i) => <TestRow key={i} test={t} />)
                )}
            </div>
        </aside>
    )
}

function TestRow({ test }: { test: TestCase }) {
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
                        <AssertRow key={i} assert={a} />
                    ))}
                    {test.diagnostics.map((diagnostic, i) => (
                        <DiagnosticRow key={i} diagnostic={diagnostic} />
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

function openLocation(location: TestLocation | undefined) {
    if (!location) return
    // __FILE__ from the compiler omits the /workspace/ prefix since compile()
    // strips it before mounting. Map back so the editor can resolve the file.
    const candidate = location.file.startsWith('/workspace/')
        ? location.file
        : `/workspace/${location.file.replace(/^\/+/, '')}`
    if (fileExists(candidate)) {
        useEditorStore.getState().setActiveFile(candidate, readFile(candidate))
    }
}

function LocationButton({ location }: { location: TestLocation | undefined }) {
    if (!location?.line) return null
    return (
        <button
            type="button"
            onClick={() => openLocation(location)}
            className="mt-1 text-[10px] text-muted-foreground/70 hover:text-foreground hover:underline"
        >
            {location.file.split('/').pop()}:{location.line}
        </button>
    )
}

function AssertRow({ assert: assertion }: { assert: TestAssertion }) {
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
            <LocationButton location={assertion.location} />
        </div>
    )
}

function DiagnosticRow({ diagnostic }: { diagnostic: TestDiagnostic }) {
    return (
        <div className="text-[11px] font-mono border-l-2 border-red-500/30 pl-2">
            <div className="text-red-400 whitespace-pre-wrap">{diagnostic.message}</div>
            {diagnostic.details && (
                <pre className="mt-1 whitespace-pre-wrap text-muted-foreground/80">
                    {diagnostic.details}
                </pre>
            )}
            <LocationButton location={diagnostic.location} />
        </div>
    )
}

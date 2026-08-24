import { EventEmitter } from '@/lib/event-emitter';
// debugger-sh is imported lazily inside ensureEngine(). Importing it at
// module load fires off ~80 MB of cross-origin prefetches for llvm.core.wasm
// and llvm-resources.tar.gz from fabioibanez.github.io, inlines an
// 8.6 MB wasm asset, and materialises the worker blob URL — all before
// the user has even pressed Run. Deferring keeps page-open cost flat.
import type { DirNode, Engine as EngineType, Lang } from 'debugger-sh';
import {
    assertNoFlattenedRuntimePathCollisions,
    runtimeRelativeFilePath,
} from '@/web-ide/core/workspace-path';
import type {
    DebugPauseState,
    DrawCommand,
    VariableNode,
    StackFrame,
    HeapAllocation,
    RuntimeExecutionPlan,
    RuntimePreparationResult,
    RuntimeOutcome,
    RuntimeSession,
    RuntimeStartRequest,
} from '@/web-ide/contracts/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type EngineRunResult = Awaited<ReturnType<EngineType['run']>>;
type RuntimeErrorOutcome = Extract<RuntimeOutcome, { type: 'error' }>;

interface DapResponse {
    type?: string;
    success?: boolean;
    body?: Any;
}

interface DapEvent {
    type?: string;
    event?: string;
    body?: Any;
}

type ScheduledTask = ReturnType<typeof setTimeout>;

interface DebugConfigurationState {
    session: number;
    completed: boolean;
    retryTimer?: ScheduledTask;
    timeoutTimer?: ScheduledTask;
}

interface RuntimeSettlementState {
    readonly session: number;
    readonly promise: Promise<RuntimeOutcome>;
    resolve(outcome: RuntimeOutcome): void;
    requestedOutcome?: RuntimeOutcome;
    stopRequested: boolean;
    settled: boolean;
    exitPublished: boolean;
}

interface BrowserRuntimeSessionProfile {
    readonly id: string;
    readonly languageIds: readonly string[];
    readonly engineLanguage: 'c' | 'python';
    readonly capabilities: RuntimeSession['capabilities'];
    readonly filterInternals?: boolean;
    readonly defaultEntrypoint?: string;
    /** Builds the engine's fixed entrypoint without rewriting the selected source. */
    readonly createEntrypointLauncher?: (runtimePath: string) => string;
    readonly preparationErrorPattern?: RegExp;
    readonly debugFallbackPath?: string;
    /** Keep only frames backed by files in the prepared host workspace. */
    readonly workspaceOnlyStackFrames?: boolean;
    /** Some adapters acknowledge resume commands without emitting `continued`. */
    readonly emitResumeOnCommand?: boolean;
    /** Queue breakpoint changes until the adapter next reaches a paused state. */
    readonly deferBreakpointUpdatesWhileRunning?: boolean;
    /** Whether breakpoint responses identify authoritative bound source lines. */
    readonly trustBreakpointValidation?: boolean;
    /** Reject breakpoint edits until the current debug run has stopped. */
    readonly breakpointChangesRequireRestart?: boolean;
    /** Recreate the adapter after a clear so its private source map cannot grow forever. */
    readonly resetAdapterAfterBreakpointClear?: boolean;
    /** Guard adapters whose resume transport has a bounded breakpoint payload. */
    readonly maxBreakpointConfigurationBytes?: number;
}

function emptyDirectory(): DirNode {
    return Object.create(null) as DirNode;
}

function canonicalWorkspacePath(path: string): string {
    if (path.startsWith('/workspace/') || path.startsWith('/sysroot/')) return path;
    return `/workspace/${runtimeRelativeFilePath(path)}`;
}

function runtimeSourceKey(path: unknown): string | null {
    if (typeof path !== 'string' || path.length === 0) return null;
    let relative = path;
    if (relative.startsWith('file://')) relative = relative.slice('file://'.length);
    if (relative.startsWith('/workspace/')) relative = relative.slice('/workspace/'.length);
    else if (relative.startsWith('/sysroot/')) relative = relative.slice('/sysroot/'.length);
    else if (relative.startsWith('/')) relative = relative.slice(1);

    const segments = relative.split('/');
    if (
        relative.length === 0
        || relative.includes('\0')
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) return null;
    return segments.join('/');
}

function buildRuntimeFileTree(files: Readonly<Record<string, string>>): DirNode {
    const root = emptyDirectory();

    for (const [path, content] of Object.entries(files)) {
        const segments = path.split('/');
        let directory = root;

        for (const segment of segments.slice(0, -1)) {
            const existing = directory[segment];
            if (typeof existing === 'string') {
                throw new TypeError(`Runtime path is both a file and directory: ${JSON.stringify(path)}`);
            }
            if (existing === undefined) {
                const child = emptyDirectory();
                directory[segment] = child;
                directory = child;
            } else {
                directory = existing;
            }
        }

        const name = segments.at(-1)!;
        const existing = directory[name];
        if (existing !== undefined && typeof existing !== 'string') {
            throw new TypeError(`Runtime path is both a directory and file: ${JSON.stringify(path)}`);
        }
        directory[name] = content;
    }

    return root;
}

function createRuntimeSettlement(session: number): RuntimeSettlementState {
    let settlePromise!: (outcome: RuntimeOutcome) => void;
    const state: RuntimeSettlementState = {
        session,
        promise: new Promise<RuntimeOutcome>((resolve) => {
            settlePromise = resolve;
        }),
        resolve(outcome) {
            if (state.settled) return;
            state.settled = true;
            settlePromise(outcome);
        },
        stopRequested: false,
        settled: false,
        exitPublished: false,
    };
    return state;
}

function runtimeErrorOutcome(
    error: unknown,
    fallbackType = 'RuntimeError',
): RuntimeErrorOutcome {
    if (error instanceof Error) {
        return {
            type: 'error',
            error: {
                type: error.name || fallbackType,
                message: error.message,
            },
        };
    }
    return {
        type: 'error',
        error: {
            type: fallbackType,
            message: String(error),
        },
    };
}

export class BrowserRuntimeSession implements RuntimeSession {
    public readonly id: string;
    public readonly languageIds: readonly string[];
    public readonly capabilities: RuntimeSession['capabilities'];
    public readonly onStdout = new EventEmitter<string>();
    public readonly onStderr = new EventEmitter<string>();
    public readonly onClearTerminal = new EventEmitter<void>();
    public readonly onCanvasDraw = new EventEmitter<DrawCommand[]>();
    public readonly onDebugPaused = new EventEmitter<DebugPauseState>();
    public readonly onDebugResumed = new EventEmitter<void>();
    public readonly onExit = new EventEmitter<number>();
    public readonly onDiagnostic = new EventEmitter<{
        message: string;
        severity: 'error' | 'warning';
        phase: 'preparation' | 'execution';
        mode: 'run' | 'debug';
    }>();
    public readonly onBreakpointsValidated = new EventEmitter<{ file: string; lines: number[] }>();
    public readonly events = {
        stdout: this.onStdout,
        stderr: this.onStderr,
        terminalClear: this.onClearTerminal,
        graphicsDraw: this.onCanvasDraw,
        debugPaused: this.onDebugPaused,
        debugResumed: this.onDebugResumed,
        exit: this.onExit,
        diagnostic: this.onDiagnostic,
        breakpointsValidated: this.onBreakpointsValidated,
    };

    // One Engine for the lifetime of this browser runtime session. Engine.create
    // allocates a Rust DapAdapter on the main thread's WASM heap, which
    // holds a fresh DebugInfo (DWARF tree, function layouts, locations)
    // per debug session — easily 50-100 MB. wasm-bindgen only reclaims
    // that Rust state via FinalizationRegistry, and on Safari that fires
    // unreliably, so creating a new Engine per run() accumulated tens of
    // dropped-but-unfreed DapAdapters and pushed the tab to multiple GB.
    // Reusing the Engine reuses the DapAdapter; each new debug session
    // replaces the prior DebugInfo via Rust's Drop, capping main-thread
    // WASM heap at one session's footprint.
    private engine: EngineType | null = null;
    private engineInit: Promise<EngineType> | null = null;
    private engineInitToken: object | null = null;
    // Tracks the in-flight `engine.run()` promise. Since we reuse one Engine
    // across runs, a fresh run() must wait for any prior run's promise to
    // settle — Engine.run() short-circuits to the stale promise if its
    // internal `this.promise` field is still set.
    private currentRun: Promise<EngineRunResult> | null = null;
    private currentRunSettlement: RuntimeSettlementState | null = null;
    private activeSettlement: RuntimeSettlementState | null = null;
    private readonly idleSettlement = Promise.resolve<RuntimeOutcome>({ type: 'stopped' });
    private disposalPromise: Promise<RuntimeOutcome> | null = null;
    private dapSeq = 1;
    private activeBreakpoints: Record<string, number[]> = {};
    private running = false;
    private debugPaused = false;
    private breakpointsDirty = false;
    private breakpointAdapterResetPending = false;
    private fileMap = Object.create(null) as Record<string, string>;
    private readonly runtimePathByWorkspacePath = new Map<string, string>();
    private readonly workspacePathByRuntimePath = new Map<string, string>();
    private readonly userRuntimePaths = new Set<string>();
    private runtimeFileTree: DirNode = emptyDirectory();
    private inputBuf = '';
    private currentIsDebug = false;
    private activeThreadId = 1;
    private streamInterceptor: RuntimeExecutionPlan['streamInterceptor'];
    private readonly stdoutDecoder = new TextDecoder();
    private readonly stderrDecoder = new TextDecoder();
    // Tracks the window between engine.run() being invoked and the first signal
    // that user code is executing (DAP `initialized` event, first stdout chunk,
    // or run resolution). Anything written to engine.stderr in this window is
    // compiler/linker output, so we scan it for clang/wasm-ld diagnostics.
    private inCompilePhase = false;
    private diagnosticEmitted = false;
    private stderrLineBuf = '';
    // Every start/stop advances the session. Deferred DAP work captures the
    // generation that scheduled it so an old worker event can never mutate a
    // replacement run that happens to be using the same long-lived Engine.
    private sessionGeneration = 0;
    private readonly scheduledTasks = new Set<ScheduledTask>();
    private debugConfiguration: DebugConfigurationState | null = null;
    private disposed = false;
    private readonly profile: BrowserRuntimeSessionProfile;

    constructor(profile: BrowserRuntimeSessionProfile) {
        this.profile = profile;
        this.id = profile.id;
        this.languageIds = profile.languageIds;
        this.capabilities = profile.capabilities;
    }

    private static readonly DEBUG_CONFIGURATION_RETRY_MS = 50;
    private static readonly DEBUG_CONFIGURATION_TIMEOUT_MS = 120_000;
    private static readonly STACK_TRACE_RETRY_MS = 50;
    private static readonly STACK_TRACE_MAX_ATTEMPTS = 2;

    async prepare({
        files,
        mode,
        entrypoint,
        streamInterceptor,
    }: RuntimeExecutionPlan): Promise<RuntimePreparationResult> {
        if (this.disposed) {
            throw new Error('Cannot prepare a disposed runtime session');
        }
        if (mode === 'debug' && !this.capabilities.debug) {
            return {
                success: false,
                errors: [`Runtime provider "${this.id}" does not support debugging`],
            };
        }
        this.flushStreamInterceptor();
        this.streamInterceptor = streamInterceptor;
        this.onClearTerminal.emit();
        this.emitStream(
            'stdout',
            '\x1b[1;34mInitializing execution environment...\x1b[0m\r\n',
        );

        try {
            assertNoFlattenedRuntimePathCollisions(files);
            this.fileMap = Object.create(null) as Record<string, string>;
            this.runtimePathByWorkspacePath.clear();
            this.workspacePathByRuntimePath.clear();
            this.userRuntimePaths.clear();
            for (const [path, content] of Object.entries(files)) {
                if (typeof content !== 'string') {
                    throw new TypeError(`Runtime file content must be a string: ${JSON.stringify(path)}`);
                }
                const relativePath = runtimeRelativeFilePath(path);
                const workspacePath = canonicalWorkspacePath(path);
                this.fileMap[relativePath] = content;
                this.runtimePathByWorkspacePath.set(workspacePath, `/${relativePath}`);
                this.workspacePathByRuntimePath.set(relativePath, workspacePath);
                if (workspacePath.startsWith('/workspace/')) {
                    this.userRuntimePaths.add(relativePath);
                }
            }

            if (entrypoint && this.profile.defaultEntrypoint) {
                const sourcePath = runtimeRelativeFilePath(entrypoint);
                const source = this.fileMap[sourcePath];
                if (source === undefined) {
                    throw new TypeError(`Runtime entrypoint "${entrypoint}" was not found in the workspace`);
                }
                if (sourcePath !== this.profile.defaultEntrypoint) {
                    if (Object.hasOwn(this.fileMap, this.profile.defaultEntrypoint)) {
                        throw new TypeError(
                            `Runtime entrypoint "${entrypoint}" cannot be selected while the workspace also contains "${this.profile.defaultEntrypoint}"; stage the original file under an ephemeral path before selecting an alternate entrypoint`,
                        );
                    }
                    this.fileMap[this.profile.defaultEntrypoint] =
                        this.profile.createEntrypointLauncher?.(`/${sourcePath}`) ?? source;
                }
            }

            this.runtimeFileTree = buildRuntimeFileTree(this.fileMap);
        } catch (error) {
            this.fileMap = Object.create(null) as Record<string, string>;
            this.runtimePathByWorkspacePath.clear();
            this.workspacePathByRuntimePath.clear();
            this.userRuntimePaths.clear();
            this.runtimeFileTree = emptyDirectory();
            this.flushStreamInterceptor();
            return {
                success: false,
                errors: [error instanceof Error ? error.message : String(error)],
            };
        }

        return { success: true, errors: [] };
    }

    private scanForCompileError(text: string) {
        const pattern = this.profile.preparationErrorPattern;
        if (!pattern || !this.inCompilePhase || this.diagnosticEmitted) return;
        this.stderrLineBuf += text;
        const lines = this.stderrLineBuf.split('\n');
        this.stderrLineBuf = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (pattern.test(line)) {
                this.diagnosticEmitted = true;
                this.onDiagnostic.emit({
                    message: line,
                    severity: 'error',
                    phase: 'preparation',
                    mode: this.currentIsDebug ? 'debug' : 'run',
                });
                return;
            }
        }
    }

    private emitStream(stream: 'stdout' | 'stderr', text: string): void {
        let output = text;
        if (this.streamInterceptor) {
            try {
                output = this.streamInterceptor.push(stream, text);
            } catch (error) {
                this.streamInterceptor = undefined;
                const message = error instanceof Error ? error.message : String(error);
                this.onDiagnostic.emit({
                    message: `Runtime stream interceptor failed: ${message}`,
                    severity: 'warning',
                    phase: 'execution',
                    mode: this.currentIsDebug ? 'debug' : 'run',
                });
            }
        }
        if (output.length === 0) return;
        if (stream === 'stderr') this.onStderr.emit(output);
        else this.onStdout.emit(output);
    }

    private flushStreamInterceptor(): void {
        const interceptor = this.streamInterceptor;
        this.streamInterceptor = undefined;
        if (!interceptor) return;

        try {
            const output = interceptor.finish();
            if (output.length > 0) this.onStdout.emit(output);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.onDiagnostic.emit({
                message: `Runtime stream interceptor failed while flushing: ${message}`,
                severity: 'warning',
                phase: 'execution',
                mode: this.currentIsDebug ? 'debug' : 'run',
            });
        }
    }

    private emitExit(exitCode: number): void {
        this.flushStreamDecoders();
        this.flushStreamInterceptor();
        this.onExit.emit(exitCode);
    }

    private publishExit(settlement: RuntimeSettlementState, exitCode: number): void {
        if (settlement.exitPublished) return;
        settlement.exitPublished = true;
        this.emitExit(exitCode);
    }

    private requestOutcome(
        settlement: RuntimeSettlementState | null,
        outcome: RuntimeOutcome,
    ): void {
        if (!settlement || settlement.settled || settlement.requestedOutcome) return;
        settlement.requestedOutcome = outcome;
    }

    private settleRuntime(
        settlement: RuntimeSettlementState,
        outcome: RuntimeOutcome,
    ): void {
        settlement.resolve(settlement.requestedOutcome ?? outcome);
    }

    private flushStreamDecoders(): void {
        const stdout = this.stdoutDecoder.decode();
        const stderr = this.stderrDecoder.decode();
        if (stdout.length > 0) this.emitStream('stdout', stdout.replace(/\r?\n/g, '\r\n'));
        if (stderr.length > 0) this.emitStream('stderr', stderr.replace(/\r?\n/g, '\r\n'));
    }

    private beginSession(): number {
        this.sessionGeneration += 1;
        this.cancelScheduledTasks();
        this.debugConfiguration = null;
        this.debugPaused = false;
        return this.sessionGeneration;
    }

    private invalidateSession(): void {
        this.sessionGeneration += 1;
        this.cancelScheduledTasks();
        this.debugConfiguration = null;
        this.debugPaused = false;
    }

    private isSessionCurrent(session: number): boolean {
        return !this.disposed && this.sessionGeneration === session;
    }

    private isSessionActive(session: number): boolean {
        return this.isSessionCurrent(session) && this.running;
    }

    private scheduleForSession(
        session: number,
        callback: () => void,
        delay: number,
    ): ScheduledTask {
        const task = setTimeout(() => {
            this.scheduledTasks.delete(task);
            if (this.isSessionActive(session)) callback();
        }, delay);
        this.scheduledTasks.add(task);
        return task;
    }

    private cancelScheduledTask(task: ScheduledTask | undefined): void {
        if (task === undefined) return;
        clearTimeout(task);
        this.scheduledTasks.delete(task);
    }

    private cancelScheduledTasks(): void {
        for (const task of this.scheduledTasks) clearTimeout(task);
        this.scheduledTasks.clear();
    }

    private finishSession(
        session: number,
        settlement: RuntimeSettlementState,
        exitCode: number,
    ): void {
        if (!this.isSessionActive(session)) return;
        this.running = false;
        this.debugPaused = false;
        this.cancelScheduledTasks();
        this.debugConfiguration = null;
        this.resetBreakpointAdapterIfIdle();
        this.publishExit(settlement, exitCode);
    }

    private failSession(session: number, message: string): void {
        if (!this.isSessionActive(session)) return;
        const engine = this.engine;
        const settlement = this.activeSettlement;
        this.requestOutcome(settlement, {
            type: 'error',
            error: { type: 'DebuggerConfigurationError', message },
        });
        if (settlement) settlement.stopRequested = true;
        this.emitStream('stderr', `${message}\r\n`);
        this.running = false;
        this.debugPaused = false;
        this.invalidateSession();
        try { engine?.stop(); } catch { /* ignore */ }
        if (settlement) this.publishExit(settlement, 1);
        else this.emitExit(1);
    }

    private dapSend(command: string, args: Record<string, unknown> = {}): DapResponse | null {
        if (!this.engine) return null;
        try {
            const res = this.engine.debugger.send({
                type: 'request',
                seq: this.dapSeq++,
                command,
                arguments: args,
            });
            return res as DapResponse;
        } catch (e) {
            console.error(`[BrowserRuntimeSession] DAP send failed (${command}):`, e);
            // A throw out of the synchronous Rust adapter means its WASM
            // state trapped (panic = abort): every subsequent call would
            // also throw, and a pending resume command will never reach
            // the worker — which then blocks on Atomics.wait forever and
            // the session freezes. Tear the session down instead.
            this.abortDeadSession();
            return null;
        }
    }

    // Recovery path for a crashed DAP adapter. Settles the in-flight run
    // (stop() rejects the worker promise, which terminates the worker) and
    // discards the Engine so the next run builds a fresh adapter. Leaking
    // one engine here is acceptable — the alternative is a debug session
    // that hangs until the page is reloaded.
    private abortDeadSession() {
        if (!this.engine) return;
        const engine = this.engine;
        const wasRunning = this.running;
        const settlement = this.activeSettlement;
        const message = 'Debugger crashed — session aborted. Press Debug to start over.';
        this.requestOutcome(settlement, {
            type: 'error',
            error: { type: 'DebuggerError', message },
        });
        if (settlement) settlement.stopRequested = true;
        this.engine = null;
        this.engineInit = null;
        this.engineInitToken = null;
        this.emitStream('stderr', `${message}\r\n`);
        this.running = false;
        this.debugPaused = false;
        this.invalidateSession();
        try { engine.stop(); } catch { /* ignore */ }
        if (wasRunning) {
            if (settlement) this.publishExit(settlement, 1);
            else this.emitExit(1);
        }
    }

    private async ensureEngine(): Promise<EngineType> {
        if (this.disposed) {
            throw new Error('Cannot initialize a disposed runtime session');
        }
        if (this.engine) return this.engine;
        if (!this.engineInit) {
            const token = {};
            this.engineInitToken = token;
            const initialization = import('debugger-sh').then(({ Engine }) =>
                Engine.create(this.profile.engineLanguage as Lang),
            );
            const adoption = initialization.then((engine) => {
                // dispose() cannot cancel Engine.create(), so reject its
                // eventual value explicitly instead of resurrecting an
                // session after its provider has unmounted.
                if (this.disposed || this.engineInitToken !== token) {
                    try { engine.stop(); } catch { /* ignore */ }
                    throw new Error('Runtime session was disposed during initialization');
                }
                this.attachListeners(engine);
                if (this.profile.filterInternals) {
                    engine.debugger.filterInternals = true;
                }
                this.engine = engine;
                return engine;
            });
            this.engineInit = adoption.catch((error: unknown) => {
                if (this.engineInitToken === token) {
                    this.engineInit = null;
                    this.engineInitToken = null;
                }
                throw error;
            });
        }
        return this.engineInit;
    }

    // Bound once when the Engine is first created, then driven by
    // `currentIsDebug` so subsequent runs don't need to re-subscribe
    // (which would duplicate listeners on the shared EventEmitter).
    private attachListeners(engine: EngineType) {
        engine.stdout.on('data', (chunk: Uint8Array) => {
            if (this.disposed || this.engine !== engine) return;
            // First user-program stdout byte means compile already succeeded.
            this.inCompilePhase = false;
            const text = this.stdoutDecoder.decode(chunk, { stream: true });
            this.emitStream('stdout', text.replace(/\r?\n/g, '\r\n'));
        });
        engine.stderr.on('data', (chunk: Uint8Array) => {
            if (this.disposed || this.engine !== engine) return;
            const text = this.stderrDecoder.decode(chunk, { stream: true });
            this.scanForCompileError(text);
            this.emitStream('stderr', text.replace(/\r?\n/g, '\r\n'));
        });
        const dbg = engine.debugger as unknown as {
            on(event: 'event', listener: (msg: unknown) => void): void;
        };
        dbg.on('event', (msg: unknown) => {
            if (this.disposed || this.engine !== engine) return;
            const m = msg as DapEvent | null;
            if (m?.type !== 'event') return;
            const session = this.sessionGeneration;
            if (!this.isSessionActive(session)) return;

            switch (m.event) {
                case 'initialized':
                    // The debugger only reaches 'initialized' after a successful
                    // compile; any subsequent stderr is runtime output. Defer
                    // the handshake one task: debugger-sh emits this event from
                    // inside its Rust DAP session, and a synchronous nested
                    // debugger.send() re-enters the borrowed WASM session and
                    // traps before setBreakpoints can return.
                    this.inCompilePhase = false;
                    this.requestDebuggerConfiguration(session);
                    break;
                case 'stopped':
                    // Like `initialized`, debugger-sh emits `stopped` while
                    // its Rust DAP session is still borrowed. Reading the
                    // stack synchronously from this callback re-enters that
                    // borrow and traps the adapter. Let the event dispatch
                    // unwind before issuing stackTrace/scopes/variables.
                    this.scheduleStackTrace(session, m.body, 1, 0);
                    break;
                case 'continued':
                    // Built-ins synthesize this after a successful command
                    // because the current adapters do not emit `continued`.
                    // Keep the event fallback for third-party profiles.
                    this.debugPaused = false;
                    if (!this.profile.emitResumeOnCommand) this.onDebugResumed.emit();
                    break;
                case 'output':
                    if (m.body?.output) {
                        const out = String(m.body.output).replace(/\r?\n/g, '\r\n');
                        if (m.body.category === 'stderr') this.emitStream('stderr', out);
                        else this.emitStream('stdout', out);
                    }
                    break;
            }
        });
    }

    async start({ mode }: RuntimeStartRequest): Promise<void> {
        if (this.disposed) {
            throw new Error('Cannot start a disposed runtime session');
        }
        if (mode === 'debug' && !this.capabilities.debug) {
            throw new Error(`Runtime provider "${this.id}" does not support debugging`);
        }
        const isDebug = mode === 'debug';
        const previousRun = this.currentRun;
        const previousEngine = this.engine;
        const previousSettlement = this.activeSettlement;
        const previousRunSettlement = this.currentRunSettlement;
        const session = this.beginSession();
        const settlement = createRuntimeSettlement(session);
        this.activeSettlement = settlement;
        this.requestOutcome(previousSettlement, { type: 'stopped' });
        if (
            previousSettlement
            && !previousSettlement.settled
            && previousSettlement !== previousRunSettlement
        ) {
            previousSettlement.stopRequested = true;
        }

        let runPromise: Promise<EngineRunResult> | null = null;
        let outcome: RuntimeOutcome = { type: 'stopped' };
        try {
            // Cancel any in-flight run on the shared engine, then await its
            // settlement so Engine.run() doesn't short-circuit to the stale
            // promise on its next call.
            if (previousRun) {
                const shouldStopEngine = !previousRunSettlement?.stopRequested;
                const wasRunning = this.running;
                this.requestOutcome(previousRunSettlement, { type: 'stopped' });
                if (previousRunSettlement) previousRunSettlement.stopRequested = true;
                this.running = false;
                this.debugPaused = false;
                if (shouldStopEngine) {
                    try { previousEngine?.stop(); } catch { /* ignore */ }
                }
                if (wasRunning) {
                    if (previousRunSettlement) this.publishExit(previousRunSettlement, 0);
                    else this.emitExit(0);
                }
                try { await previousRun; } catch { /* ignore */ }
                if (!this.isSessionCurrent(session)) return;
                this.resetBreakpointAdapterIfIdle();
            }

            let engine: EngineType;
            try {
                engine = await this.ensureEngine();
            } catch (error) {
                if (!this.isSessionCurrent(session)) return;
                const failure = runtimeErrorOutcome(error, 'EngineInitializationError');
                outcome = failure;
                this.emitStream(
                    'stderr',
                    `Failed to create engine: ${failure.error.message}\r\n`,
                );
                this.publishExit(settlement, 1);
                return;
            }
            if (!this.isSessionCurrent(session)) return;

            try {
                engine.fs = this.runtimeFileTree;
                engine.debugger.enabled = isDebug;
                this.currentIsDebug = isDebug;
                this.running = true;
                this.debugPaused = false;
                this.dapSeq = 1;
                this.activeThreadId = 1;
                this.inputBuf = '';
                this.inCompilePhase = true;
                this.diagnosticEmitted = false;
                this.stderrLineBuf = '';
                if (isDebug) this.beginDebuggerConfiguration(session);

                // debugger-sh attaches its DAP transport while run() starts.
                // Start the worker before initialize so its transport and
                // source map are ready for the first breakpoint request.
                runPromise = engine.run();
                this.currentRun = runPromise;
                this.currentRunSettlement = settlement;
                if (isDebug) this.dapSend('initialize', {});

                const result = await runPromise;
                if (!this.isSessionCurrent(session)) return;
                if (result.type === 'completed') {
                    outcome = { type: 'completed', exitCode: result.exitCode };
                } else if (result.type === 'error') {
                    outcome = {
                        type: 'error',
                        error: {
                            type: result.error.type,
                            message: result.error.message,
                        },
                    };
                    this.emitStream(
                        'stderr',
                        `Runtime error: ${result.error.type}: ${result.error.message}\r\n`,
                    );
                } else {
                    outcome = { type: 'stopped' };
                }
            } catch (error) {
                if (!this.isSessionCurrent(session)) return;
                const failure = runtimeErrorOutcome(error);
                outcome = failure;
                this.emitStream('stderr', `Runtime error: ${failure.error.message}\r\n`);
            }
        } finally {
            if (runPromise && this.currentRun === runPromise) {
                this.currentRun = null;
                this.currentRunSettlement = null;
            }
            if (this.isSessionActive(session)) {
                // Drain any pending stderr line and close the compile-phase window.
                if (this.inCompilePhase && this.stderrLineBuf.length > 0) {
                    this.scanForCompileError('\n');
                }
                this.inCompilePhase = false;
                const exitCode = outcome.type === 'completed'
                    ? outcome.exitCode
                    : outcome.type === 'error' ? 1 : 0;
                this.finishSession(session, settlement, exitCode);
            } else if (this.isSessionCurrent(session) && outcome.type === 'error') {
                this.publishExit(settlement, 1);
            }
            this.settleRuntime(settlement, outcome);
            this.resetBreakpointAdapterIfIdle();
        }
    }

    private beginDebuggerConfiguration(session: number): void {
        const state: DebugConfigurationState = {
            session,
            completed: false,
        };
        this.debugConfiguration = state;
        state.timeoutTimer = this.scheduleForSession(
            session,
            () => this.failSession(
                session,
                'Debugger configuration timed out before the runtime became ready.',
            ),
            BrowserRuntimeSession.DEBUG_CONFIGURATION_TIMEOUT_MS,
        );
    }

    private requestDebuggerConfiguration(
        session: number,
        delay = 0,
    ): void {
        const state = this.debugConfiguration;
        if (
            !this.isSessionActive(session) ||
            !state ||
            state.session !== session ||
            state.completed ||
            state.retryTimer !== undefined
        ) return;

        state.retryTimer = this.scheduleForSession(session, () => {
            if (this.debugConfiguration !== state) return;
            state.retryTimer = undefined;

            if (this.configureDebugger()) {
                state.completed = true;
                this.cancelScheduledTask(state.timeoutTimer);
                state.timeoutTimer = undefined;
                return;
            }

            this.requestDebuggerConfiguration(
                session,
                BrowserRuntimeSession.DEBUG_CONFIGURATION_RETRY_MS,
            );
        }, delay);
    }

    private configureDebugger(): boolean {
        const configuredFiles = Object.keys(this.activeBreakpoints);
        if (configuredFiles.length > 0) {
            // Empty sets matter: they remove breakpoints previously installed
            // for that source in a reused adapter.
            for (const file of configuredFiles) {
                this.sendBreakpoints(file, this.activeBreakpoints[file]);
            }
        } else {
            this.dapSend('setBreakpoints', {
                source: { path: this.profile.debugFallbackPath ?? '/main.cpp' },
                breakpoints: [],
            });
        }
        this.dapSend('setExceptionBreakpoints', { filters: [] });
        const configured = this.dapSend('configurationDone', {})?.success === true;
        if (configured) this.breakpointsDirty = false;
        return configured;
    }

    // Sends one file's breakpoints and reports back where the engine
    // actually bound them. The debugger snaps a request on a blank or
    // comment line to the next executable line — mirroring VS Code, the
    // UI dot should move there too, so students see the true stop site.
    // Unverified requests keep their original line (the dot stays put,
    // like VS Code's pending breakpoints) rather than vanishing.
    private sendBreakpoints(file: string, lines: number[]) {
        const res = this.dapSend('setBreakpoints', {
            source: { path: this.toRuntimePath(file) },
            breakpoints: lines.map((l) => ({ line: l })),
        });
        if (this.profile.trustBreakpointValidation === false) return;
        const results: Any[] = res?.body?.breakpoints ?? [];
        if (results.length !== lines.length) return;
        const bound = lines.map((requested, i) => {
            const r = results[i];
            return r?.verified && typeof r.line === 'number' ? (r.line as number) : requested;
        });
        const validated = [...new Set(bound)].sort((a, b) => a - b);
        this.activeBreakpoints[file] = validated;
        this.onBreakpointsValidated.emit({ file, lines: validated });
    }

    private flushPendingBreakpoints(): void {
        if (!this.breakpointsDirty || !this.engine || !this.running) return;
        for (const [file, lines] of Object.entries(this.activeBreakpoints)) {
            this.sendBreakpoints(file, lines);
        }
        if (this.running) this.breakpointsDirty = false;
    }

    private resetBreakpointAdapterIfIdle(): void {
        if (
            !this.breakpointAdapterResetPending
            || this.running
            || this.currentRun
        ) return;
        this.breakpointAdapterResetPending = false;
        this.activeBreakpoints = Object.fromEntries(
            Object.entries(this.activeBreakpoints).filter(([, lines]) => lines.length > 0),
        );
        const engine = this.engine;
        if (!engine) return;
        this.engine = null;
        this.engineInit = null;
        this.engineInitToken = null;
        try { engine.stop(); } catch { /* ignore */ }
    }

    private toRuntimePath(file: string): string {
        const canonicalPath = canonicalWorkspacePath(file);
        const mappedPath = this.runtimePathByWorkspacePath.get(canonicalPath);
        if (mappedPath) return mappedPath;

        let path = file;
        if (path.startsWith('/workspace/')) path = '/' + path.substring('/workspace/'.length);
        else if (!path.startsWith('/')) path = '/' + path;
        return path;
    }

    private toWorkspacePath(path: unknown): string | null {
        const key = runtimeSourceKey(path);
        if (!key) return null;
        return this.workspacePathByRuntimePath.get(key) ?? null;
    }

    // Ceiling on children fetched per variables request. Values like vector
    // sizes and pointer targets are read from raw debuggee memory and can be
    // garbage (uninitialized/destroyed locals), so an unbounded request can
    // ask the synchronous Rust adapter for millions of children and stall
    // the main thread. 100 is plenty for the variables panel.
    private static readonly MAX_CHILDREN = 100;
    // Struct-member recursion guard for the same reason: garbage memory can
    // produce arbitrarily deep member chains.
    private static readonly MAX_DEPTH = 8;
    // A Python pause can expose thousands of eagerly snapshotted container
    // nodes. Bound total synchronous DAP work across every frame and scope so
    // one pause cannot monopolize the browser's main thread.
    private static readonly MAX_VARIABLE_NODES_PER_PAUSE = 1_000;
    private static readonly MAX_VARIABLE_REQUESTS_PER_PAUSE = 250;
    private static readonly MAX_STACK_FRAMES_PER_PAUSE = 100;

    private dapVariables(
        variablesReference: number,
        budget: { nodes: number; requests: number },
    ): Any[] {
        const remaining = BrowserRuntimeSession.MAX_VARIABLE_NODES_PER_PAUSE - budget.nodes;
        if (
            remaining <= 0
            || budget.requests >= BrowserRuntimeSession.MAX_VARIABLE_REQUESTS_PER_PAUSE
        ) return [];
        budget.requests += 1;
        const res = this.dapSend('variables', {
            variablesReference,
            start: 0,
            count: Math.min(BrowserRuntimeSession.MAX_CHILDREN, remaining),
        });
        const variables: Any[] = res?.body?.variables ?? [];
        const accepted = variables.slice(0, remaining);
        budget.nodes += accepted.length;
        return accepted;
    }

    // True when a stack-frame source path is one of the files the user can
    // see in the editor. Everything else (libc++ headers, the test runner)
    // is library code students shouldn't be stepping through.
    private isUserSource(path: unknown): boolean {
        const key = runtimeSourceKey(path);
        return key !== null && this.userRuntimePaths.has(key);
    }

    private scheduleStackTrace(
        session: number,
        body: Any,
        attempt: number,
        delay: number,
    ): void {
        this.scheduleForSession(session, () => {
            if (this.handleStopped(session, body)) return;
            if (
                this.isSessionActive(session) &&
                attempt < BrowserRuntimeSession.STACK_TRACE_MAX_ATTEMPTS
            ) {
                this.scheduleStackTrace(
                    session,
                    body,
                    attempt + 1,
                    BrowserRuntimeSession.STACK_TRACE_RETRY_MS,
                );
            }
        }, delay);
    }

    /** Returns false only when stackTrace can be retried for this session. */
    private handleStopped(session: number, body: Any): boolean {
        if (!this.isSessionActive(session)) return true;
        const threadId = body?.threadId ?? 1;
        this.activeThreadId = threadId;
        const stackRes = this.dapSend('stackTrace', { threadId });
        // The backend can emit stopped just before stack inspection is ready.
        // Never publish an empty synthetic pause from a failed response; the
        // caller gets one bounded retry while this exact session is active.
        if (stackRes?.success !== true) return false;
        this.debugPaused = true;
        this.flushPendingBreakpoints();
        if (!this.isSessionActive(session)) return true;
        const rawFrames: Any[] = stackRes?.body?.stackFrames ?? [];

        // "Just my code" stepping. C++ continues past linked library code to
        // avoid unsafe DWARF `next` operations. Python steps out of a non-host
        // frame because continuing could skip the caller's next source line.
        if (rawFrames.length > 0 && !this.isUserSource(rawFrames[0]?.source?.path)) {
            if (this.profile.workspaceOnlyStackFrames) {
                this.sendResumeCommand('stepOut');
            } else {
                // C++ `next` performs per-line DWARF lookups that can panic on
                // wasm-ld's overlapping COMDAT ranges. `continue` avoids that.
                this.sendResumeCommand('continue');
            }
            return true;
        }

        const frames = (this.profile.workspaceOnlyStackFrames
            ? rawFrames.filter((frame) => this.isUserSource(frame?.source?.path))
            : rawFrames).slice(0, BrowserRuntimeSession.MAX_STACK_FRAMES_PER_PAUSE);

        const callStack: StackFrame[] = [];
        const heapAllocations = new Map<number, HeapAllocation>();

        const stackAddrs = new Set<number>();
        const heapQueue: { ptr: number; typeStr: string; variablesReference: number; valueStr?: string }[] = [];
        const visitedRefs = new Set<number>();
        const variableBudget = { nodes: 0, requests: 0 };

        const supportsMemoryVisualization =
            this.capabilities.memoryVisualization === true;
        const parseAddr = (v: Any) => supportsMemoryVisualization
            ? this.parseHexAddress(v.memoryReference)
            : 0;

        const processVariable = (v: Any, isHeap: boolean, depth = 0): VariableNode => {
            const addr = parseAddr(v);
            const typeStr: string = v.type ?? '';
            // Match pointer logic including references
            const isPointer = supportsMemoryVisualization
                && (typeStr.includes('*') || typeStr.includes('&'));
            const variablesReference = v.variablesReference ?? 0;
            const hasChildren = variablesReference > 0;

            if (!isHeap && addr > 0) {
                stackAddrs.add(addr);
            }

            let members: VariableNode[] | undefined;
            let pointsTo: number | undefined;

            if (isPointer) {
                if (hasChildren) {
                    // The engine returns the pointer's own storage address in `value`,
                    // not the target. Dereference through children to get the actual target.
                    const dapVars = this.dapVariables(variablesReference, variableBudget);
                    if (dapVars.length > 0) {
                        pointsTo = parseAddr(dapVars[0]);
                    }

                    if (pointsTo && pointsTo > 0 && !visitedRefs.has(variablesReference)) {
                        visitedRefs.add(variablesReference);
                        heapQueue.push({
                            ptr: pointsTo,
                            typeStr: typeStr.replace(/[*&]\s*$/, '').trim() || 'unknown',
                            variablesReference,
                            valueStr: v.value ?? ''
                        });
                    }
                }
            } else if (hasChildren && depth < BrowserRuntimeSession.MAX_DEPTH && !visitedRefs.has(variablesReference)) {
                visitedRefs.add(variablesReference);
                const dapVars = this.dapVariables(variablesReference, variableBudget);
                members = dapVars.map((child) => processVariable(child, isHeap, depth + 1));
            }

            // For pointers `v.value` is the variable's own storage address (debugger-sh
            // deviation from DAP), so never display it — fall back to 0x0 when we can't
            // dereference through children (NULL or undereferenceable).
            let displayValue = String(v.value ?? '');
            if (isPointer) {
                displayValue = pointsTo && pointsTo > 0 ? `0x${pointsTo.toString(16)}` : '0x0';
            }

            const variable: VariableNode = {
                name: v.name ?? '',
                type: typeStr,
                value: displayValue,
                isStruct: !isPointer && hasChildren,
                members,
            };
            if (supportsMemoryVisualization) {
                variable.rawValue = pointsTo ?? addr;
                variable.address = addr;
                variable.size = 4;
                variable.isPointer = isPointer;
                variable.pointsTo = pointsTo;
                variable.pointeeType = isPointer
                    ? typeStr.replace(/[*&]\s*$/, '').trim()
                    : typeStr;
            }
            return variable;
        };

        // Phase 1: Walk stack synchronously and gather actual memory footprints
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            const scopesRes = this.dapSend('scopes', { frameId: f.id });
            const variables: VariableNode[] = [];

            for (const scope of scopesRes?.body?.scopes ?? []) {
                for (const v of this.dapVariables(scope.variablesReference, variableBudget)) {
                    variables.push(processVariable(v, false));
                }
            }

            const frame: StackFrame = {
                id: String(f.id),
                funcName: f.name ?? 'unknown',
                file: this.toWorkspacePath(f.source?.path) ?? undefined,
                line: f.line ?? 0,
                variables,
                isActive: i === 0,
            };
            if (supportsMemoryVisualization) frame.sp = 0;
            callStack.push(frame);
        }

        // Phase 2: Walk the dynamic pointer relationships to generate objects!

        // debugger-sh's wasm runtime lays memory out as: null page / data (low)
        // → stack → heap (high). Anything at or below the highest stack-resident
        // variable cannot be a heap allocation — it's a wild/uninit pointer that
        // the DAP engine cheerfully dereferenced. Without a malloc tracker this
        // is the cleanest signal we have for separating real allocations from
        // garbage (e.g. uninit `Node*` reading bytes that decode as 0xfffc8).
        const stackCeiling = Math.max(...stackAddrs);
        const isAboveStack = (addr: number) => addr > stackCeiling;

        let heapNodeCount = 0;
        const MAX_HEAP_NODES = 200;

        while (heapQueue.length > 0 && heapNodeCount < MAX_HEAP_NODES) {
            const item = heapQueue.shift()!;

            if (!isAboveStack(item.ptr)) continue;
            if (heapAllocations.has(item.ptr)) continue;

            heapNodeCount++;

            let dapVars: Any[] = this.dapVariables(item.variablesReference, variableBudget);

            // Some DAP implementations return a single element named "*varname" when requesting variables of a pointer.
            // In this case we unwrap it so the properties are top-level on the heap node.
            if (dapVars.length === 1 && (dapVars[0].name?.startsWith('*') || (item.valueStr && item.valueStr.includes(dapVars[0].value)))) {
                const derefVar = dapVars[0];
                if (derefVar.variablesReference > 0) {
                    const inner = this.dapVariables(derefVar.variablesReference, variableBudget);
                    if (inner.length > 0) {
                        dapVars = inner;
                    }
                }
            }

            const members = dapVars.map((child: Any) => processVariable(child, true));

            heapAllocations.set(item.ptr, {
                ptr: item.ptr,
                size: 4,
                typeName: item.typeStr,
                label: `0x${item.ptr.toString(16).padStart(6, '0')}`,
                members,
            });
        }

        const topFrame = callStack[0];
        const file = this.toWorkspacePath(frames[0]?.source?.path);

        if (!this.isSessionActive(session)) return true;
        this.onDebugPaused.emit({
            line: topFrame?.line ?? null,
            func: topFrame?.funcName ?? null,
            file,
            callStack,
            memorySnapshot: supportsMemoryVisualization
                ? {
                    frames: callStack,
                    heapAllocations: Array.from(heapAllocations.values()),
                }
                : null,
            nextKnownTypes: {},
        });
        return true;
    }

    private parseHexAddress(ref: unknown): number {
        if (typeof ref !== 'string' || ref.length === 0) return 0;
        // Allows graceful extraction of pointers embedded in DAP display texts
        const match = ref.match(/0x[0-9a-fA-F]+/);
        if (match) {
            const n = Number(match[0]);
            return Number.isFinite(n) ? n : 0;
        }
        const n = Number(ref);
        return Number.isFinite(n) ? n : 0;
    }

    async setBreakpoints(file: string, lines: number[]): Promise<void> {
        if (!this.capabilities.breakpoints) {
            throw new Error(`Runtime provider "${this.id}" does not support breakpoints`);
        }
        const normalizedLines = [...new Set(lines)].sort((a, b) => a - b);
        const currentLines = this.activeBreakpoints[file] ?? [];
        if (
            currentLines.length === normalizedLines.length
            && currentLines.every((line, index) => line === normalizedLines[index])
        ) return;
        if (
            this.engine
            && this.running
            && this.currentIsDebug
            && this.profile.breakpointChangesRequireRestart
        ) {
            const message =
                'Stop the current debug session before changing breakpoints; this runtime cannot replace them while execution is active.';
            // The editor optimistically toggles first. Re-publish the accepted
            // set so both the gutter and host event/replay streams compensate
            // for the rejected toggle.
            this.onBreakpointsValidated.emit({ file, lines: [...currentLines] });
            this.onDiagnostic.emit({
                message,
                severity: 'warning',
                phase: 'execution',
                mode: 'debug',
            });
            this.emitStream('stderr', `${message}\r\n`);
            throw new Error(message);
        }
        const nextBreakpoints = { ...this.activeBreakpoints };
        if (normalizedLines.length === 0 && !this.engine) delete nextBreakpoints[file];
        else nextBreakpoints[file] = normalizedLines;
        const maxBytes = this.profile.maxBreakpointConfigurationBytes;
        if (maxBytes !== undefined) {
            const runtimeBreakpoints = Object.fromEntries(
                Object.entries(nextBreakpoints)
                    .map(([configuredFile, configuredLines]) => [
                        this.toRuntimePath(configuredFile),
                        configuredLines,
                    ]),
            );
            const size = new TextEncoder().encode(JSON.stringify(runtimeBreakpoints)).byteLength;
            if (size > maxBytes) {
                const message =
                    `Breakpoint configuration is ${size} bytes; this runtime accepts at most ${maxBytes}.`;
                this.onBreakpointsValidated.emit({ file, lines: [...currentLines] });
                this.onDiagnostic.emit({
                    message,
                    severity: 'error',
                    phase: 'preparation',
                    mode: 'debug',
                });
                this.emitStream('stderr', `${message}\r\n`);
                throw new Error(message);
            }
        }
        this.activeBreakpoints = nextBreakpoints;
        if (
            normalizedLines.length === 0
            && currentLines.length > 0
            && this.engine
            && this.profile.resetAdapterAfterBreakpointClear
        ) {
            this.breakpointAdapterResetPending = true;
        }
        if (this.engine && this.running && this.currentIsDebug) {
            if (this.profile.deferBreakpointUpdatesWhileRunning) {
                this.breakpointsDirty = true;
                if (this.debugPaused) this.flushPendingBreakpoints();
            } else {
                this.sendBreakpoints(file, normalizedLines);
            }
        }
        this.resetBreakpointAdapterIfIdle();
    }

    async stepInto(): Promise<void> {
        this.assertDebuggingSupported();
        if (this.running && !this.disposed) {
            this.sendResumeCommand('stepIn');
        }
    }

    async stepOver(): Promise<void> {
        this.assertDebuggingSupported();
        if (this.running && !this.disposed) {
            this.sendResumeCommand('next');
        }
    }

    async stepOut(): Promise<void> {
        this.assertDebuggingSupported();
        if (this.running && !this.disposed) {
            this.sendResumeCommand('stepOut');
        }
    }

    async continueExecution(): Promise<void> {
        this.assertDebuggingSupported();
        if (this.running && !this.disposed) {
            this.sendResumeCommand('continue');
        }
    }

    private sendResumeCommand(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): void {
        if (!this.running || !this.debugPaused || this.disposed) return;
        const response = this.dapSend(command, { threadId: this.activeThreadId });
        if (response?.success === true) {
            this.debugPaused = false;
            if (this.profile.emitResumeOnCommand) this.onDebugResumed.emit();
        }
    }

    private requestStop(): Promise<RuntimeOutcome> {
        const settlement = this.activeSettlement;
        if (!settlement) return this.idleSettlement;
        if (settlement.settled || settlement.stopRequested) return settlement.promise;

        settlement.stopRequested = true;
        this.requestOutcome(settlement, { type: 'stopped' });
        const ownsCurrentRun = this.currentRunSettlement === settlement;
        const wasRunning = ownsCurrentRun && this.running;
        this.running = false;
        this.debugPaused = false;
        this.invalidateSession();
        if (ownsCurrentRun) {
            try { this.engine?.stop(); } catch { /* ignore */ }
        }
        if (wasRunning) this.publishExit(settlement, 0);
        return settlement.promise;
    }

    waitForSettlement(): Promise<RuntimeOutcome> {
        return this.activeSettlement?.promise ?? this.idleSettlement;
    }

    stop(): void {
        // Preserve the 0.1 void API while new consumers can await the exact
        // same per-start settlement through stopAndWait().
        void this.requestStop();
    }

    stopAndWait(): Promise<RuntimeOutcome> {
        return this.requestStop();
    }

    private assertDebuggingSupported(): void {
        if (!this.capabilities.debug) {
            throw new Error(`Runtime provider "${this.id}" does not support debugging`);
        }
    }

    dispose(): void {
        void this.disposeAndWait();
    }

    disposeAndWait(): Promise<RuntimeOutcome> {
        if (this.disposalPromise) return this.disposalPromise;

        const hadUnsettledStart = Boolean(
            this.activeSettlement && !this.activeSettlement.settled,
        );
        const initialization = this.engineInit;
        this.disposed = true;
        const settlement = this.requestStop();
        if (!hadUnsettledStart) {
            try { this.engine?.stop(); } catch { /* ignore */ }
        }

        this.disposalPromise = (async () => {
            const outcome = await settlement;
            if (initialization) {
                try { await initialization; } catch { /* disposal rejects adoption */ }
            }
            this.cancelScheduledTasks();
            this.debugConfiguration = null;
            this.engine = null;
            this.engineInit = null;
            this.engineInitToken = null;
            return outcome;
        })();
        return this.disposalPromise;
    }

    // Line-buffered stdin. Mirrors debugger.sh upstream behavior so programs that
    // use `cin >> x` / `scanf` / read-until-EOF loops behave the same as in the
    // reference IDE. Special key conventions:
    //   ^C  → terminate the running program
    //   ^D  → flush EOF marker (so `while (cin >> x)` exits)
    //   ^L  → clear the visible terminal (buffer preserved-cleared)
    //   ⏎   → flush buffered line + '\n' to the program's stdin
    //   ⌫   → erase last char in buffer + visible echo
    //   esc → swallow CSI sequences (arrow keys etc.) so they don't enter the buffer
    writeStdin(data: string): void {
        // Engine is now long-lived, so gate on `running` to reject stdin between runs.
        if (!this.engine || !this.running) return;
        if (data === '\x03') {
            this.emitStream('stdout', '^C\r\n');
            this.stop();
            return;
        }
        if (data === '\x04') {
            this.emitStream('stdout', '^D\r\n');
            this.engine.stdin.write('\x04');
            this.inputBuf = '';
            return;
        }
        if (data === '\x0c') {
            this.onClearTerminal.emit();
            this.inputBuf = '';
            return;
        }
        if (data === '\r') {
            this.emitStream('stdout', '\r\n');
            this.engine.stdin.write(this.inputBuf + '\n');
            this.inputBuf = '';
            return;
        }
        if (data === '\x7f') {
            if (this.inputBuf.length > 0) {
                this.inputBuf = this.inputBuf.slice(0, -1);
                this.emitStream('stdout', '\b \b');
            }
            return;
        }
        if (data.startsWith('\x1b')) return; // arrow keys, function keys, etc.
        if (data >= ' ') {
            this.inputBuf += data;
            this.emitStream('stdout', data);
        }
    }
}

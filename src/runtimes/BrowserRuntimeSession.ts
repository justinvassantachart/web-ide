import { EventEmitter } from '@/lib/event-emitter';
// debugger-sh is imported lazily inside ensureEngine(). Importing it at
// module load fires off ~80 MB of cross-origin prefetches for llvm.core.wasm
// and llvm-resources.tar.gz from fabioibanez.github.io, inlines an
// 8.6 MB wasm asset, and materialises the worker blob URL — all before
// the user has even pressed Run. Deferring keeps page-open cost flat.
import type { DirNode, Engine as EngineType, EngineOptions, Lang } from 'debugger-sh';
import { buildRuntimeExecutionPlan, runtimeExecutionPlansEqual } from './execution-plan';
import {
    canonicalRuntimeFilePath,
    normalizeRuntimeFiles,
    runtimeRelativeFilePath,
} from '@/web-ide/core/workspace-path';
import type {
    DebugPauseState,
    DrawCommand,
    VariableNode,
    StackFrame,
    RuntimeExecutionPlan,
    RuntimeBreakpointMap,
    RuntimePreparationResult,
    RuntimeOutcome,
    RuntimeHostDeviceOpener,
    RuntimeHostServiceV1,
    RuntimeSession,
    RuntimeStartRequest,
    RuntimeWarmupResult,
} from '@/web-ide/contracts/runtime';
import type { Disposable } from '@/web-ide/core/disposable';
import { validateRuntimeHostServiceV1 } from './host-service';
import { DebugValueCapture } from './debug-values';
import type { DebugChildPage, DebugPageRequest, DebugValueRef } from '../web-ide/contracts/debug-presentation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type EngineRunResult = Awaited<ReturnType<EngineType['run']>>;
type RuntimeErrorOutcome = Extract<RuntimeOutcome, { type: 'error' }>;
const pchRejectionPattern = /(?:fatal )?error:[^\r\n]*(?:precompiled header|PCH file|AST file)/i;
let nextDebugInstance = 0;

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

interface HostServiceRegistration {
    readonly service: RuntimeHostServiceV1;
    engine?: EngineType;
    engineRegistration?: Disposable;
}

type HostServiceCapableEngine = EngineType & {
    registerHostService?: (service: RuntimeHostServiceV1) => Disposable;
};

interface HostDeviceRegistration {
    readonly opener: RuntimeHostDeviceOpener;
    engine?: EngineType;
}

type HostDeviceCapableEngine = EngineType & { hostDevice?: RuntimeHostDeviceOpener };
type ArtifactEngine = EngineType & {
    binaryFiles: Record<string, Uint8Array>;
    cppArtifacts?: { sources?: string[]; archives?: string[]; precompiledHeader?: string };
};

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

interface BreakpointConfigurationChange {
    readonly file: string;
    readonly previousLines: number[];
    readonly nextLines: number[];
}

interface BrowserExecutionPlan {
    plan: RuntimeExecutionPlan;
    fileTree: DirNode;
    binaryFiles: Record<string, Uint8Array>;
    cppArtifacts?: ArtifactEngine['cppArtifacts'];
    runtimePathByWorkspacePath: Map<string, string>;
    workspacePathByRuntimePath: Map<string, string>;
    userRuntimePaths: Set<string>;
}

interface WarmupState {
    plan: RuntimeExecutionPlan;
    promise: Promise<RuntimeWarmupResult>;
    engine?: EngineType;
    cancelled: boolean;
    output: string;
    truncated: boolean;
    stdout: TextDecoder;
    stderr: TextDecoder;
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
    readonly engineOptions?: EngineOptions;
}

function emptyDirectory(): DirNode {
    return Object.create(null) as DirNode;
}

function runtimeSourceKey(path: unknown): string | null {
    if (typeof path !== 'string' || path.length === 0) return null;
    const candidate = path.startsWith('file://') ? path.slice('file://'.length) : path;
    try {
        return runtimeRelativeFilePath(candidate);
    } catch {
        return null;
    }
}

function canonicalBreakpointPath(path: string): string {
    const canonical = canonicalRuntimeFilePath(path);
    if (!canonical.startsWith('/workspace/')) {
        throw new TypeError(
            `Breakpoint path must resolve below /workspace: ${JSON.stringify(path)}`,
        );
    }
    return canonical;
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
    public readonly onDebugSnapshotUpdated = new EventEmitter<DebugPauseState>();
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
        debugSnapshotUpdated: this.onDebugSnapshotUpdated,
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
    // Editor breakpoints stay separate from transient workflow overlays so
    // adapter validation can never leak an overlay into the visible gutter.
    private activeBreakpoints: Record<string, number[]> = {};
    private readonly breakpointOverlays = new Map<object, Record<string, number[]>>();
    // A reused adapter must receive an explicit empty set for an overlay-only
    // source after its owner clears. Profiles that reset their adapter discard
    // these tombstones as soon as the reset completes.
    private readonly breakpointClearTombstones = new Set<string>();
    private running = false;
    private debugPaused = false;
    private pauseGeneration = 0;
    private readonly debugInstance = ++nextDebugInstance;
    private debugCapture?: DebugValueCapture;
    private debugSnapshot?: DebugPauseState;
    private breakpointsDirty = false;
    private breakpointAdapterResetPending = false;
    private readonly runtimePathByWorkspacePath = new Map<string, string>();
    private readonly workspacePathByRuntimePath = new Map<string, string>();
    private readonly userRuntimePaths = new Set<string>();
    private runtimeFileTree: DirNode = emptyDirectory();
    private runtimeBinaryFiles: Record<string, Uint8Array> = {};
    private runtimeCppArtifacts?: ArtifactEngine['cppArtifacts'];
    private pchFallbackAllowed = false;
    private pchCompilerOutput = '';
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
    private preparationGeneration = 0;
    private warmupState?: WarmupState;
    private readonly profile: BrowserRuntimeSessionProfile;
    private readonly hostServices = new Map<string, HostServiceRegistration>();
    private hostDeviceRegistration?: HostDeviceRegistration;

    constructor(profile: BrowserRuntimeSessionProfile) {
        this.profile = profile;
        this.id = profile.id;
        this.languageIds = profile.languageIds;
        this.capabilities = profile.capabilities;
    }

    registerHostDevice(opener: RuntimeHostDeviceOpener): Disposable {
        if (this.disposed) throw new Error('Cannot register a host device on a disposed runtime session');
        if (this.profile.engineLanguage !== 'c' && this.profile.engineLanguage !== 'python') {
            throw new Error(`Runtime provider "${this.id}" does not support host devices`);
        }
        if (typeof opener !== 'function') throw new TypeError('Host device opener must be a function');
        if (this.hostDeviceRegistration) throw new Error('A host device is already registered');
        if (this.activeSettlement && !this.activeSettlement.settled) {
            throw new Error('Host devices cannot change during a pending or active run');
        }
        // Capture this registration's callback, not the mutable registration slot.
        const record: HostDeviceRegistration = { opener: (device) => opener(device) };
        this.hostDeviceRegistration = record;
        try {
            if (this.engine) this.attachHostDevice(this.engine);
        } catch (error) {
            this.hostDeviceRegistration = undefined;
            throw error;
        }
        return {
            dispose: () => {
                if (this.hostDeviceRegistration !== record) return;
                this.hostDeviceRegistration = undefined;
                if (record.engine) this.releaseEngineHostDevice(record.engine, record);
            },
        };
    }

    private attachHostDevice(engine: EngineType): void {
        const record = this.hostDeviceRegistration;
        if (!record) return;
        const capable = engine as HostDeviceCapableEngine;
        if (!('hostDevice' in capable)) {
            throw new Error('The loaded runtime engine does not support configured host devices');
        }
        if (capable.hostDevice !== undefined && capable.hostDevice !== record.opener) {
            throw new Error('The loaded runtime engine already has a host device');
        }
        capable.hostDevice = record.opener;
        record.engine = engine;
    }

    private releaseEngineHostDevice(
        engine: EngineType,
        record = this.hostDeviceRegistration,
    ): void {
        if (record?.engine !== engine) return;
        const capable = engine as HostDeviceCapableEngine;
        // Engine.run() already captured its opener. The engine owns that run's
        // signal and cleanup; clearing this slot only affects subsequent runs.
        if (capable.hostDevice === record.opener) capable.hostDevice = undefined;
        record.engine = undefined;
    }

    registerHostService(service: RuntimeHostServiceV1): Disposable {
        if (this.disposed) throw new Error('Cannot register a host service on a disposed runtime session');
        if (this.capabilities.hostChannels !== true) {
            throw new Error(`Runtime provider "${this.id}" does not support host services`);
        }
        validateRuntimeHostServiceV1(service);
        if (this.hostServices.has(service.capability)) {
            throw new TypeError(`host service capability is already registered: ${service.capability}`);
        }
        if (this.engine && (this.running || this.currentRun)) {
            throw new Error('host services cannot change during a run');
        }
        const registered: RuntimeHostServiceV1 = Object.freeze({
            capability: service.capability,
            version: service.version,
            ...(service.limits === undefined ? {} : { limits: Object.freeze({ ...service.limits }) }),
            open: service.open.bind(service),
        });
        const record: HostServiceRegistration = { service: registered };
        this.hostServices.set(registered.capability, record);
        try {
            if (this.engine) this.attachHostService(this.engine, record);
        } catch (error) {
            this.hostServices.delete(registered.capability);
            throw error;
        }
        let active = true;
        return {
            dispose: () => {
                if (!active) return;
                active = false;
                if (this.hostServices.get(registered.capability) === record) {
                    this.hostServices.delete(registered.capability);
                }
                this.releaseHostServiceRegistration(record);
            },
        };
    }

    private attachHostService(engine: EngineType, record: HostServiceRegistration): void {
        if (record.engineRegistration) return;
        const register = (engine as HostServiceCapableEngine).registerHostService;
        if (typeof register !== 'function') {
            throw new Error('The loaded runtime engine does not support configured host services');
        }
        const registration = register.call(engine, record.service);
        if (!registration || typeof registration.dispose !== 'function') {
            throw new TypeError('Runtime engine host-service registration must return a Disposable');
        }
        record.engine = engine;
        record.engineRegistration = registration;
    }

    private attachHostServices(engine: EngineType): void {
        const attached: HostServiceRegistration[] = [];
        try {
            for (const record of this.hostServices.values()) {
                this.attachHostService(engine, record);
                attached.push(record);
            }
        } catch (error) {
            for (const record of attached) this.releaseHostServiceRegistration(record, false);
            throw error;
        }
    }

    private releaseHostServiceRegistration(
        record: HostServiceRegistration,
        deferDuringRun = true,
    ): void {
        const registration = record.engineRegistration;
        const engine = record.engine;
        if (!registration) return;
        record.engineRegistration = undefined;
        record.engine = undefined;
        const release = () => {
            try {
                registration.dispose();
            } catch (error) {
                console.error('[BrowserRuntimeSession] host-service cleanup failed', error);
            }
        };
        if (deferDuringRun && engine === this.engine && this.currentRun) {
            // Use both settlement branches directly. `finally(release)` would
            // create a second rejected promise when engine.run() rejects,
            // surfacing an unhandled rejection even though start() owns and
            // translates the original failure.
            void this.currentRun.then(release, release);
        } else {
            release();
        }
    }

    private releaseEngineHostServices(engine: EngineType, deferDuringRun = true): void {
        for (const record of this.hostServices.values()) {
            if (record.engine === engine) this.releaseHostServiceRegistration(record, deferDuringRun);
        }
    }

    private static readonly DEBUG_CONFIGURATION_RETRY_MS = 50;
    private static readonly DEBUG_CONFIGURATION_TIMEOUT_MS = 120_000;
    private static readonly STACK_TRACE_RETRY_MS = 50;
    private static readonly STACK_TRACE_MAX_ATTEMPTS = 2;

    private buildPlan(input: RuntimeExecutionPlan): BrowserExecutionPlan {
        const plan = buildRuntimeExecutionPlan(input);
        const { files, mode, entrypoint, sourceAliases = {}, binaryFiles = {}, cppArtifacts } = plan;
        if (mode === 'debug' && !this.capabilities.debug) {
            throw new Error(`Runtime provider "${this.id}" does not support debugging`);
        }
        const nextBinaryFiles: Record<string, Uint8Array> = Object.create(null);
        let nextCppArtifacts: ArtifactEngine['cppArtifacts'];
        const nextRuntimePathByWorkspacePath = new Map<string, string>();
        const nextWorkspacePathByRuntimePath = new Map<string, string>();
        const nextUserRuntimePaths = new Set<string>();
        const normalizedFiles = normalizeRuntimeFiles(files);
        const nextFileMap = Object.create(null) as Record<string, string>;
        for (const [canonicalPath, content] of Object.entries(normalizedFiles)) {
            const relativePath = runtimeRelativeFilePath(canonicalPath);
            nextFileMap[relativePath] = content;
            nextRuntimePathByWorkspacePath.set(canonicalPath, `/${relativePath}`);
            nextWorkspacePathByRuntimePath.set(relativePath, canonicalPath);
            if (canonicalPath.startsWith('/workspace/')) {
                nextUserRuntimePaths.add(relativePath);
            }
        }

        const aliasedTargets = new Set<string>();
        for (const [staged, original] of Object.entries(sourceAliases)) {
            const stagedPath = canonicalBreakpointPath(staged);
            const originalPath = canonicalBreakpointPath(original);
            if (stagedPath !== staged || originalPath !== original || stagedPath === originalPath
                || !Object.hasOwn(normalizedFiles, stagedPath) || aliasedTargets.has(originalPath)) {
                throw new TypeError('Invalid or ambiguous runtime source alias');
            }
            aliasedTargets.add(originalPath);
            const relative = runtimeRelativeFilePath(stagedPath);
            nextRuntimePathByWorkspacePath.set(originalPath, `/${relative}`);
            nextWorkspacePathByRuntimePath.set(relative, originalPath);
            nextUserRuntimePaths.add(relative);
        }

        const canonicalEntrypoint = entrypoint === undefined
            ? undefined
            : canonicalRuntimeFilePath(entrypoint);
        if (canonicalEntrypoint && this.profile.defaultEntrypoint) {
            const sourcePath = runtimeRelativeFilePath(canonicalEntrypoint);
            const source = nextFileMap[sourcePath];
            if (source === undefined) {
                throw new TypeError(`Runtime entrypoint "${entrypoint}" was not found in the workspace`);
            }
            if (sourcePath !== this.profile.defaultEntrypoint) {
                if (Object.hasOwn(nextFileMap, this.profile.defaultEntrypoint)) {
                    throw new TypeError(
                        `Runtime entrypoint "${entrypoint}" cannot be selected while the workspace also contains "${this.profile.defaultEntrypoint}"; stage the original file under an ephemeral path before selecting an alternate entrypoint`,
                    );
                }
                nextFileMap[this.profile.defaultEntrypoint] =
                    this.profile.createEntrypointLauncher?.(`/${sourcePath}`) ?? source;
            }
        }

        const nextRuntimeFileTree = buildRuntimeFileTree(nextFileMap);
        if ((cppArtifacts || Object.keys(binaryFiles).length) && this.profile.engineLanguage !== 'c') {
            throw new TypeError('Binary build inputs require C/C++');
        }
        const artifactPath = (path: string) => `/${runtimeRelativeFilePath(path)}`;
        for (const [path, bytes] of Object.entries(binaryFiles)) {
            const relative = runtimeRelativeFilePath(path);
            if (!(bytes instanceof Uint8Array)) throw new TypeError(`Binary input must be bytes: ${path}`);
            if (Object.hasOwn(nextFileMap, relative) || Object.hasOwn(nextBinaryFiles, `/${relative}`)) {
                throw new TypeError(`Binary input collides with an execution file: ${path}`);
            }
            nextBinaryFiles[`/${relative}`] = bytes.slice();
        }
        buildRuntimeFileTree({ ...nextFileMap, ...Object.fromEntries(
            Object.keys(nextBinaryFiles).map(path => [path.slice(1), '']),
        ) });
        if (cppArtifacts) {
            nextCppArtifacts = {
                sources: cppArtifacts.sources?.map(artifactPath),
                archives: cppArtifacts.archives?.map(artifactPath),
                precompiledHeader: cppArtifacts.precompiledHeader === undefined
                    ? undefined : artifactPath(cppArtifacts.precompiledHeader),
            };
        }
        return {
            plan,
            fileTree: nextRuntimeFileTree,
            binaryFiles: nextBinaryFiles,
            cppArtifacts: nextCppArtifacts,
            runtimePathByWorkspacePath: nextRuntimePathByWorkspacePath,
            workspacePathByRuntimePath: nextWorkspacePathByRuntimePath,
            userRuntimePaths: nextUserRuntimePaths,
        };
    }

    async prepare(input: RuntimeExecutionPlan): Promise<RuntimePreparationResult> {
        if (this.disposed) throw new Error('Cannot prepare a disposed runtime session');
        const generation = ++this.preparationGeneration;
        let next: BrowserExecutionPlan;
        try { next = this.buildPlan(input); }
        catch (error) { return { success: false, errors: [error instanceof Error ? error.message : String(error)] }; }
        const background = this.warmupState;
        if (background) {
            if (next.plan.mode === 'run' && !next.plan.streamInterceptor && runtimeExecutionPlansEqual(next.plan, background.plan)) {
                await background.promise;
            } else await this.cancelWarmupAndWait();
        }
        const current = () => !this.disposed && generation === this.preparationGeneration;
        if (!current()) return { success: false, errors: ['Execution preparation was cancelled'] };
        this.flushStreamInterceptor();
        if (!current()) return { success: false, errors: ['Execution preparation was cancelled'] };
        this.streamInterceptor = next.plan.streamInterceptor;
        this.onClearTerminal.emit();
        if (!current()) return { success: false, errors: ['Execution preparation was cancelled'] };
        this.emitStream('stdout', '\x1b[1;34mInitializing execution environment...\x1b[0m\r\n');
        if (!current()) return { success: false, errors: ['Execution preparation was cancelled'] };
        this.runtimePathByWorkspacePath.clear();
        for (const [path, runtimePath] of next.runtimePathByWorkspacePath) this.runtimePathByWorkspacePath.set(path, runtimePath);
        this.workspacePathByRuntimePath.clear();
        for (const [runtimePath, path] of next.workspacePathByRuntimePath) this.workspacePathByRuntimePath.set(runtimePath, path);
        this.userRuntimePaths.clear();
        for (const runtimePath of next.userRuntimePaths) this.userRuntimePaths.add(runtimePath);
        this.runtimeFileTree = next.fileTree;
        this.runtimeBinaryFiles = next.binaryFiles;
        this.runtimeCppArtifacts = next.cppArtifacts;
        this.pchFallbackAllowed = next.plan.cppArtifacts?.fallbackToSource === true;
        return { success: true, errors: [] };
    }

    warmup(input: RuntimeExecutionPlan): Promise<RuntimeWarmupResult> {
        const skipped = (reason: string): Promise<RuntimeWarmupResult> => Promise.resolve({ status: 'skipped', diagnostics: [], reason });
        if (this.disposed) return skipped('disposed');
        if (this.profile.engineLanguage !== 'c' || !this.profile.engineOptions?.cpp?.objectCache) return skipped('disabled');
        if (input.mode !== 'run' || input.streamInterceptor) return skipped('unsupported-workflow');
        if (this.running || this.currentRun || (this.activeSettlement && !this.activeSettlement.settled)) return skipped('foreground-active');
        let built: BrowserExecutionPlan;
        try { built = this.buildPlan(input); }
        catch (error) {
            const result: RuntimeWarmupResult = { status: 'failed', diagnostics: [error instanceof Error ? error.message : String(error)] };
            this.reportWarmupFailure(result);
            return Promise.resolve(result);
        }
        if (this.warmupState) {
            return runtimeExecutionPlansEqual(built.plan, this.warmupState.plan) ? this.warmupState.promise : skipped('warmup-active');
        }
        let resolve!: (result: RuntimeWarmupResult) => void;
        const state: WarmupState = {
            plan: built.plan,
            promise: new Promise<RuntimeWarmupResult>(done => { resolve = done; }),
            cancelled: false,
            output: '',
            truncated: false,
            stdout: new TextDecoder(),
            stderr: new TextDecoder(),
        };
        this.warmupState = state;
        void this.compileWarmup(state, built).then(resolve, error => resolve({
            status: state.cancelled || this.disposed ? 'cancelled' : 'failed',
            diagnostics: [],
            reason: error instanceof Error ? error.message : String(error),
        }));
        return state.promise;
    }

    cancelWarmupAndWait(): Promise<void> {
        const state = this.warmupState;
        if (!state) return Promise.resolve();
        state.cancelled = true;
        try { state.engine?.stop(); } catch { /* the compile result still drains */ }
        return state.promise.then(() => {});
    }

    compilationStatistics(): unknown {
        if (this.disposed || this.profile.engineLanguage !== 'c' || !this.profile.engineOptions?.cpp || !this.engine) return undefined;
        return structuredClone(this.engine.cacheStats);
    }

    private captureWarmup(stream: 'stdout' | 'stderr', bytes: Uint8Array): boolean {
        const state = this.warmupState;
        if (!state || state.engine !== this.engine) return false;
        const text = state[stream].decode(bytes, { stream: true });
        const available = 65_536 - state.output.length;
        state.output += text.slice(0, available);
        if (text.length > available) state.truncated = true;
        return true;
    }

    private async compileWarmup(state: WarmupState, built: BrowserExecutionPlan): Promise<RuntimeWarmupResult> {
        let result: RuntimeWarmupResult;
        try {
            const engine = await this.ensureEngine();
            if (state.cancelled || this.disposed || this.warmupState !== state) return { status: 'cancelled', diagnostics: [] };
            state.engine = engine;
            engine.fs = built.fileTree;
            engine.binaryFiles = built.binaryFiles;
            engine.cppArtifacts = built.cppArtifacts;
            engine.debugger.enabled = false;
            const outcome = await engine.compile();
            const tail = state.stdout.decode() + state.stderr.decode();
            state.output += tail.slice(0, 65_536 - state.output.length);
            const diagnostics = state.output ? [state.output + (state.truncated ? '\n[Warmup diagnostics truncated]' : '')] : [];
            if (state.cancelled || this.disposed) {
                result = { status: 'cancelled', diagnostics: [] };
            } else if (outcome.type === 'completed' && outcome.exitCode === 0) {
                result = { status: 'completed', diagnostics, statistics: engine.cacheStats };
            } else {
                const reason = outcome.type === 'error' ? outcome.error.message
                    : outcome.type === 'completed' ? `Compiler exited ${outcome.exitCode}` : 'Compiler stopped';
                result = { status: 'failed', diagnostics, reason, statistics: engine.cacheStats };
            }
        } catch (error) {
            result = state.cancelled || this.disposed ? { status: 'cancelled', diagnostics: [] }
                : { status: 'failed', diagnostics: state.output ? [state.output] : [], reason: error instanceof Error ? error.message : String(error) };
        } finally {
            if (this.warmupState === state) this.warmupState = undefined;
        }
        if (result.status === 'failed') this.reportWarmupFailure(result);
        return result;
    }

    private reportWarmupFailure(result: RuntimeWarmupResult): void {
        if (this.disposed) return;
        try {
            this.onDiagnostic.emit({ message: `Initial compilation warmup failed: ${result.reason ?? result.diagnostics.join('\n')}`, severity: 'warning', phase: 'preparation', mode: 'run' });
        } catch { /* A background diagnostic callback cannot block foreground execution. */ }
    }

    private scanForCompileError(text: string) {
        const pattern = this.profile.preparationErrorPattern;
        if (!pattern || !this.inCompilePhase || this.diagnosticEmitted) return;
        this.stderrLineBuf += text;
        const lines = this.stderrLineBuf.split('\n');
        this.stderrLineBuf = lines.pop() ?? '';
        for (const raw of lines) {
            // Clang colors both locations and severity labels. Normalize only
            // the completed diagnostic line, so split escape sequences work
            // and the terminal keeps the original colored stream.
            // eslint-disable-next-line no-control-regex
            const line = raw.replace(/\x1b\[[\d;:]*m/g, '').replace(/\r$/, '');
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
        this.releaseEngineHostServices(engine);
        this.releaseEngineHostDevice(engine);
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
                this.profile.engineOptions
                    ? Engine.create(this.profile.engineLanguage as Lang, this.profile.engineOptions)
                    : Engine.create(this.profile.engineLanguage as Lang),
            );
            const adoption = initialization.then((engine) => {
                // dispose() cannot cancel Engine.create(), so reject its
                // eventual value explicitly instead of resurrecting an
                // session after its provider has unmounted.
                if (this.disposed || this.engineInitToken !== token) {
                    try { engine.stop(); } catch { /* ignore */ }
                    throw new Error('Runtime session was disposed during initialization');
                }
                try {
                    this.attachListeners(engine);
                    if (this.profile.filterInternals) {
                        engine.debugger.filterInternals = true;
                    }
                    this.attachHostServices(engine);
                    this.attachHostDevice(engine);
                    this.engine = engine;
                    return engine;
                } catch (error) {
                    this.releaseEngineHostServices(engine, false);
                    this.releaseEngineHostDevice(engine);
                    try { engine.stop(); } catch { /* ignore */ }
                    throw error;
                }
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
            if (this.captureWarmup('stdout', chunk)) return;
            if (!this.running) return;
            // First user-program stdout byte means compile already succeeded.
            this.inCompilePhase = false;
            const text = this.stdoutDecoder.decode(chunk, { stream: true });
            this.emitStream('stdout', text.replace(/\r?\n/g, '\r\n'));
        });
        engine.stderr.on('data', (chunk: Uint8Array) => {
            if (this.disposed || this.engine !== engine) return;
            if (this.captureWarmup('stderr', chunk)) return;
            if (!this.running) return;
            const text = this.stderrDecoder.decode(chunk, { stream: true });
            if (this.inCompilePhase && this.pchFallbackAllowed) {
                this.pchCompilerOutput = (this.pchCompilerOutput + text).slice(-16_384);
            }
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
                    this.pauseGeneration += 1;
                    this.debugCapture = undefined;
                    this.debugSnapshot = undefined;
                    this.scheduleStackTrace(session, m.body, 1, 0, this.pauseGeneration);
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
            await this.cancelWarmupAndWait();
            if (!this.isSessionCurrent(session)) return;
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
                if ('binaryFiles' in engine) {
                    const artifacts = engine as ArtifactEngine;
                    artifacts.binaryFiles = this.runtimeBinaryFiles;
                    artifacts.cppArtifacts = this.runtimeCppArtifacts;
                } else if (this.runtimeCppArtifacts || Object.keys(this.runtimeBinaryFiles).length) {
                    throw new Error('This debugger-sh build does not support precompiled C++ inputs');
                }
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
                this.pchCompilerOutput = '';
                if (isDebug) this.beginDebuggerConfiguration(session);

                // debugger-sh attaches its DAP transport while run() starts.
                // Start the worker before initialize so its transport and
                // source map are ready for the first breakpoint request.
                runPromise = engine.run();
                this.currentRun = runPromise;
                this.currentRunSettlement = settlement;
                if (isDebug) this.dapSend('initialize', {});

                let result = await runPromise;
                if (!this.isSessionCurrent(session)) return;
                // In Debug, DAP initialized is an authoritative compile-success
                // boundary. Ordinary Run has no such event: timing values can
                // round to zero, so never replay a possibly executed program.
                if (
                    isDebug && this.pchFallbackAllowed && (engine as ArtifactEngine).cppArtifacts?.precompiledHeader
                    && this.inCompilePhase && result.type === 'completed'
                    && result.exitCode !== 0
                    && pchRejectionPattern.test(this.pchCompilerOutput)
                ) {
                    (engine as ArtifactEngine).cppArtifacts = { ...(engine as ArtifactEngine).cppArtifacts, precompiledHeader: undefined };
                    this.runtimeCppArtifacts = (engine as ArtifactEngine).cppArtifacts;
                    this.pchFallbackAllowed = false;
                    this.pchCompilerOutput = '';
                    this.diagnosticEmitted = false;
                    this.stderrLineBuf = '';
                    this.emitStream('stderr', 'Cached headers were rejected; recompiling from source.\r\n');
                    if (!this.isSessionActive(session)) return;
                    if (isDebug) this.beginDebuggerConfiguration(session);
                    runPromise = engine.run();
                    this.currentRun = runPromise;
                    if (isDebug) this.dapSend('initialize', {});
                    result = await runPromise;
                    if (!this.isSessionCurrent(session)) return;
                }
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
        this.cancelScheduledTask(this.debugConfiguration?.retryTimer);
        this.cancelScheduledTask(this.debugConfiguration?.timeoutTimer);
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

    private mergedBreakpointConfiguration(
        editorBreakpoints: Readonly<Record<string, readonly number[]>> = this.activeBreakpoints,
        overlays: ReadonlyMap<object, Readonly<Record<string, readonly number[]>>> =
            this.breakpointOverlays,
        tombstones: ReadonlySet<string> = this.breakpointClearTombstones,
    ): Record<string, number[]> {
        const byRuntimePath = new Map<string, { file: string; lines: Set<number> }>();
        const add = (file: string, lines: readonly number[]): void => {
            const runtimePath = this.toRuntimePath(file);
            let entry = byRuntimePath.get(runtimePath);
            if (!entry) {
                entry = { file, lines: new Set<number>() };
                byRuntimePath.set(runtimePath, entry);
            }
            for (const line of lines) entry.lines.add(line);
        };

        // Add editor-owned entries first so their stable workspace spelling is
        // retained for any breakpoint-validation event sent back to the UI.
        for (const [file, lines] of Object.entries(editorBreakpoints)) add(file, lines);
        for (const overlay of overlays.values()) {
            for (const [file, lines] of Object.entries(overlay)) add(file, lines);
        }
        for (const file of tombstones) add(file, []);

        return Object.fromEntries(
            [...byRuntimePath.values()].map(({ file, lines }) => [
                file,
                [...lines].sort((a, b) => a - b),
            ]),
        );
    }

    private configureDebugger(): boolean {
        const breakpoints = this.mergedBreakpointConfiguration();
        const configuredFiles = Object.keys(breakpoints);
        if (configuredFiles.length > 0) {
            // Empty sets matter: they remove breakpoints previously installed
            // for that source in a reused adapter.
            for (const file of configuredFiles) {
                this.sendBreakpoints(file, breakpoints[file]);
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
        const runtimePath = this.toRuntimePath(file);

        // Validate only editor-owned requests. Overlay lines are intentionally
        // invisible to the gutter and host breakpoint event stream.
        for (const [editorFile, editorLines] of Object.entries(this.activeBreakpoints)) {
            if (editorLines.length === 0 || this.toRuntimePath(editorFile) !== runtimePath) continue;
            const bound = editorLines.map((requested) => {
                const index = lines.indexOf(requested);
                if (index < 0) return requested;
                const result = results[index];
                return result?.verified && typeof result.line === 'number'
                    ? (result.line as number)
                    : requested;
            });
            const validated = [...new Set(bound)].sort((a, b) => a - b);
            this.activeBreakpoints[editorFile] = validated;
            this.onBreakpointsValidated.emit({ file: editorFile, lines: validated });
        }
    }

    private flushPendingBreakpoints(): void {
        if (!this.breakpointsDirty || !this.engine || !this.running) return;
        for (const [file, lines] of Object.entries(this.mergedBreakpointConfiguration())) {
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
        this.breakpointClearTombstones.clear();
        const engine = this.engine;
        if (!engine) return;
        this.releaseEngineHostServices(engine, false);
        this.releaseEngineHostDevice(engine);
        this.engine = null;
        this.engineInit = null;
        this.engineInitToken = null;
        try { engine.stop(); } catch { /* ignore */ }
    }

    private toRuntimePath(file: string): string {
        const canonicalPath = canonicalBreakpointPath(file);
        const mappedPath = this.runtimePathByWorkspacePath.get(canonicalPath);
        if (mappedPath) return mappedPath;

        return `/${runtimeRelativeFilePath(canonicalPath)}`;
    }

    private toWorkspacePath(path: unknown): string | null {
        const key = runtimeSourceKey(path);
        if (!key) return null;
        return this.workspacePathByRuntimePath.get(key) ?? null;
    }

    private static readonly MAX_STACK_FRAMES_PER_PAUSE = 100;

    readDebugValue(value: DebugValueRef): Readonly<VariableNode> | undefined {
        return this.debugCapture?.read(value);
    }

    readDebugChildren(value: DebugValueRef, page: DebugPageRequest): Promise<DebugChildPage> {
        return this.debugCapture?.readChildren(value, page) ?? Promise.resolve({
            children: [], start: page.start, complete: false,
            availability: 'unavailable', message: 'This stop is no longer active.',
        });
    }

    private publishDebugRevision(capture: DebugValueCapture): void {
        if (this.debugCapture !== capture || !this.debugSnapshot || !this.debugPaused) return;
        const callStack = this.debugSnapshot.callStack.map((frame) => ({
            ...frame,
            variables: frame.variables.map((value) => capture.read(value.debugRef!) ?? value),
        }));
        this.debugSnapshot = {
            ...this.debugSnapshot,
            debugSnapshot: { id: capture.id, revision: capture.revision },
            callStack,
            memorySnapshot: this.debugSnapshot.memorySnapshot
                ? { frames: callStack, heapAllocations: [] }
                : null,
        };
        this.onDebugSnapshotUpdated.emit(this.debugSnapshot);
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
        pause: number,
    ): void {
        this.scheduleForSession(session, () => {
            if (pause !== this.pauseGeneration) return;
            if (this.handleStopped(session, body, pause)) return;
            if (
                this.isSessionActive(session) &&
                attempt < BrowserRuntimeSession.STACK_TRACE_MAX_ATTEMPTS
            ) {
                this.scheduleStackTrace(
                    session,
                    body,
                    attempt + 1,
                    BrowserRuntimeSession.STACK_TRACE_RETRY_MS,
                    pause,
                );
            }
        }, delay);
    }

    /** Returns false only when stackTrace can be retried for this session. */
    private handleStopped(session: number, body: Any, pause: number): boolean {
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

        const supportsMemoryVisualization = this.capabilities.memoryVisualization === true;
        const capture = new DebugValueCapture(
            `${this.id}:${this.debugInstance}:${session}:${pause}`,
            supportsMemoryVisualization,
            () => this.isSessionActive(session) && this.debugPaused && this.pauseGeneration === pause,
            (variablesReference, page) => this.dapSend('variables', { variablesReference, ...page }),
            () => this.publishDebugRevision(capture),
        );
        this.debugCapture = capture;
        const callStack: StackFrame[] = [];
        for (const [index, frame] of frames.entries()) {
            if (!this.isSessionActive(session) || !this.debugPaused || pause !== this.pauseGeneration) return true;
            const scopes = this.dapSend('scopes', { frameId: frame.id });
            const variables: VariableNode[] = [];
            const messages = new Set<string>();
            if (scopes?.success !== true) messages.add('Variables unavailable at this stop.');
            for (const scope of scopes?.body?.scopes ?? []) {
                variables.push(...capture.captureScope(scope.variablesReference, false));
                if (capture.lastScopeMessage) messages.add(capture.lastScopeMessage);
            }
            callStack.push({
                id: String(frame.id), funcName: frame.name ?? 'unknown',
                file: this.toWorkspacePath(frame.source?.path) ?? undefined,
                line: frame.line ?? 0, variables, variablesMessage: [...messages].join(' ') || undefined,
                isActive: index === 0,
            });
        }
        capture.expandValues(callStack.flatMap(frame => frame.variables));
        for (const frame of callStack) {
            frame.variables = frame.variables.map(value => capture.read(value.debugRef!) ?? value);
        }
        if (!this.isSessionActive(session) || !this.debugPaused || pause !== this.pauseGeneration) return true;
        this.debugSnapshot = {
            debugSnapshot: { id: capture.id, revision: capture.revision },
            line: callStack[0]?.line ?? null,
            func: callStack[0]?.funcName ?? null,
            file: this.toWorkspacePath(frames[0]?.source?.path),
            callStack,
            // DAP provides object addresses, not allocation ownership or sizes.
            memorySnapshot: supportsMemoryVisualization ? { frames: callStack, heapAllocations: [] } : null,
            nextKnownTypes: {},
        };
        this.onDebugPaused.emit(this.debugSnapshot);
        return true;
    }

    private normalizeBreakpointOverlay(
        breakpoints: RuntimeBreakpointMap,
    ): Record<string, number[]> {
        if (typeof breakpoints !== 'object' || breakpoints === null || Array.isArray(breakpoints)) {
            throw new TypeError('Breakpoint overlay must be a source-path map');
        }
        const normalized = Object.create(null) as Record<string, number[]>;
        for (const [file, lines] of Object.entries(breakpoints)) {
            const canonicalFile = canonicalBreakpointPath(file);
            if (canonicalFile !== file) {
                throw new TypeError(
                    `Breakpoint overlay path must be canonical under /workspace: ${JSON.stringify(file)}`,
                );
            }
            if (!Array.isArray(lines)) {
                throw new TypeError(`Breakpoint overlay lines must be an array: ${JSON.stringify(file)}`);
            }
            if (lines.some((line) => !Number.isSafeInteger(line) || line < 1)) {
                throw new TypeError(
                    `Breakpoint overlay lines must be positive safe integers: ${JSON.stringify(file)}`,
                );
            }
            const normalizedLines = [...new Set(lines)].sort((a, b) => a - b);
            if (normalizedLines.length === 0) continue;
            normalized[canonicalFile] = [
                ...new Set([...(normalized[canonicalFile] ?? []), ...normalizedLines]),
            ].sort((a, b) => a - b);
        }
        return normalized;
    }

    private breakpointMapsEqual(
        left: Readonly<Record<string, readonly number[]>> | undefined,
        right: Readonly<Record<string, readonly number[]>> | undefined,
    ): boolean {
        const leftEntries = Object.entries(left ?? {});
        const rightEntries = Object.entries(right ?? {});
        if (leftEntries.length !== rightEntries.length) return false;
        return leftEntries.every(([file, lines]) => {
            const rightLines = right?.[file];
            return rightLines !== undefined
                && lines.length === rightLines.length
                && lines.every((line, index) => line === rightLines[index]);
        });
    }

    private breakpointConfigurationChanges(
        previous: Readonly<Record<string, readonly number[]>>,
        next: Readonly<Record<string, readonly number[]>>,
    ): BreakpointConfigurationChange[] {
        const index = (configuration: Readonly<Record<string, readonly number[]>>) => {
            const byRuntimePath = new Map<string, { file: string; lines: number[] }>();
            for (const [file, lines] of Object.entries(configuration)) {
                byRuntimePath.set(this.toRuntimePath(file), { file, lines: [...lines] });
            }
            return byRuntimePath;
        };
        const previousByPath = index(previous);
        const nextByPath = index(next);
        const runtimePaths = new Set([...previousByPath.keys(), ...nextByPath.keys()]);
        const changes: BreakpointConfigurationChange[] = [];
        for (const runtimePath of runtimePaths) {
            const before = previousByPath.get(runtimePath);
            const after = nextByPath.get(runtimePath);
            const previousLines = before?.lines ?? [];
            const nextLines = after?.lines ?? [];
            if (
                previousLines.length === nextLines.length
                && previousLines.every((line, index) => line === nextLines[index])
            ) continue;
            changes.push({
                file: after?.file ?? before!.file,
                previousLines,
                nextLines,
            });
        }
        return changes;
    }

    private assertBreakpointConfigurationWithinLimit(
        breakpoints: Readonly<Record<string, readonly number[]>>,
        rejectedEditorChange?: { file: string; lines: number[] },
    ): void {
        const maxBytes = this.profile.maxBreakpointConfigurationBytes;
        if (maxBytes === undefined) return;
        const runtimeBreakpoints = Object.fromEntries(
            Object.entries(breakpoints).map(([file, lines]) => [
                this.toRuntimePath(file),
                lines,
            ]),
        );
        const size = new TextEncoder().encode(JSON.stringify(runtimeBreakpoints)).byteLength;
        if (size <= maxBytes) return;

        const message =
            `Breakpoint configuration is ${size} bytes; this runtime accepts at most ${maxBytes}.`;
        if (rejectedEditorChange) {
            this.onBreakpointsValidated.emit({
                file: rejectedEditorChange.file,
                lines: [...rejectedEditorChange.lines],
            });
        }
        this.onDiagnostic.emit({
            message,
            severity: 'error',
            phase: 'preparation',
            mode: 'debug',
        });
        this.emitStream('stderr', `${message}\r\n`);
        throw new Error(message);
    }

    private assertBreakpointChangesAllowed(
        changes: readonly BreakpointConfigurationChange[],
        rejectedEditorChange?: { file: string; lines: number[] },
    ): void {
        if (
            changes.length === 0
            || !this.engine
            || !this.running
            || !this.currentIsDebug
            || !this.profile.breakpointChangesRequireRestart
        ) return;
        const message =
            'Stop the current debug session before changing breakpoints; this runtime cannot replace them while execution is active.';
        if (rejectedEditorChange) {
            this.onBreakpointsValidated.emit({
                file: rejectedEditorChange.file,
                lines: [...rejectedEditorChange.lines],
            });
        }
        this.onDiagnostic.emit({
            message,
            severity: 'warning',
            phase: 'execution',
            mode: 'debug',
        });
        this.emitStream('stderr', `${message}\r\n`);
        throw new Error(message);
    }

    private applyBreakpointConfigurationChanges(
        changes: readonly BreakpointConfigurationChange[],
    ): void {
        if (
            changes.some(({ previousLines, nextLines }) => (
                previousLines.length > 0 && nextLines.length === 0
            ))
            && this.engine
            && this.profile.resetAdapterAfterBreakpointClear
        ) {
            this.breakpointAdapterResetPending = true;
        }
        if (changes.length > 0 && this.engine && this.running && this.currentIsDebug) {
            if (this.profile.deferBreakpointUpdatesWhileRunning) {
                this.breakpointsDirty = true;
                if (this.debugPaused) this.flushPendingBreakpoints();
            } else {
                for (const { file, nextLines } of changes) {
                    this.sendBreakpoints(file, nextLines);
                }
            }
        }
        this.resetBreakpointAdapterIfIdle();
    }

    async setBreakpoints(file: string, lines: number[]): Promise<void> {
        if (!this.capabilities.breakpoints) {
            throw new Error(`Runtime provider "${this.id}" does not support breakpoints`);
        }
        const canonicalFile = canonicalBreakpointPath(file);
        const normalizedLines = [...new Set(lines)].sort((a, b) => a - b);
        const currentLines = this.activeBreakpoints[canonicalFile] ?? [];
        if (
            currentLines.length === normalizedLines.length
            && currentLines.every((line, index) => line === normalizedLines[index])
        ) return;
        const nextBreakpoints = { ...this.activeBreakpoints };
        if (normalizedLines.length === 0 && !this.engine) delete nextBreakpoints[canonicalFile];
        else nextBreakpoints[canonicalFile] = normalizedLines;
        const nextTombstones = new Set(this.breakpointClearTombstones);
        if (normalizedLines.length > 0) nextTombstones.delete(canonicalFile);
        const previousConfiguration = this.mergedBreakpointConfiguration();
        const nextConfiguration = this.mergedBreakpointConfiguration(
            nextBreakpoints,
            this.breakpointOverlays,
            nextTombstones,
        );
        const changes = this.breakpointConfigurationChanges(
            previousConfiguration,
            nextConfiguration,
        );
        const rejectedEditorChange = { file: canonicalFile, lines: [...currentLines] };
        this.assertBreakpointChangesAllowed(changes, rejectedEditorChange);
        this.assertBreakpointConfigurationWithinLimit(
            nextConfiguration,
            rejectedEditorChange,
        );

        this.activeBreakpoints = nextBreakpoints;
        this.breakpointClearTombstones.clear();
        for (const tombstone of nextTombstones) this.breakpointClearTombstones.add(tombstone);
        this.applyBreakpointConfigurationChanges(changes);
    }

    async replaceBreakpointOverlay(
        owner: object,
        breakpoints: RuntimeBreakpointMap,
    ): Promise<void> {
        if (this.disposed) {
            throw new Error('Cannot configure breakpoints on a disposed runtime session');
        }
        if (!this.capabilities.breakpoints) {
            throw new Error(`Runtime provider "${this.id}" does not support breakpoints`);
        }
        if (typeof owner !== 'object' || owner === null) {
            throw new TypeError('Breakpoint overlay owner must be a non-null object token');
        }
        const normalized = this.normalizeBreakpointOverlay(breakpoints);
        this.updateBreakpointOverlay(
            owner,
            Object.keys(normalized).length > 0 ? normalized : undefined,
        );
    }

    async clearBreakpointOverlay(owner: object): Promise<void> {
        if (this.disposed) {
            throw new Error('Cannot configure breakpoints on a disposed runtime session');
        }
        if (!this.capabilities.breakpoints) {
            throw new Error(`Runtime provider "${this.id}" does not support breakpoints`);
        }
        if (typeof owner !== 'object' || owner === null) {
            throw new TypeError('Breakpoint overlay owner must be a non-null object token');
        }
        this.updateBreakpointOverlay(owner, undefined);
    }

    private updateBreakpointOverlay(
        owner: object,
        nextOverlay: Record<string, number[]> | undefined,
    ): void {
        const currentOverlay = this.breakpointOverlays.get(owner);
        if (this.breakpointMapsEqual(currentOverlay, nextOverlay)) return;

        const previousConfiguration = this.mergedBreakpointConfiguration();
        const nextOverlays = new Map(this.breakpointOverlays);
        if (nextOverlay) nextOverlays.set(owner, nextOverlay);
        else nextOverlays.delete(owner);

        const nextTombstones = new Set(this.breakpointClearTombstones);
        for (const file of Object.keys(nextOverlay ?? {})) nextTombstones.delete(file);
        let nextConfiguration = this.mergedBreakpointConfiguration(
            this.activeBreakpoints,
            nextOverlays,
            nextTombstones,
        );
        if (this.engine) {
            for (const { file, previousLines, nextLines } of this.breakpointConfigurationChanges(
                previousConfiguration,
                nextConfiguration,
            )) {
                if (previousLines.length > 0 && nextLines.length === 0) {
                    nextTombstones.add(canonicalBreakpointPath(file));
                }
            }
            nextConfiguration = this.mergedBreakpointConfiguration(
                this.activeBreakpoints,
                nextOverlays,
                nextTombstones,
            );
        }
        const changes = this.breakpointConfigurationChanges(
            previousConfiguration,
            nextConfiguration,
        );
        this.assertBreakpointChangesAllowed(changes);
        this.assertBreakpointConfigurationWithinLimit(nextConfiguration);

        this.breakpointOverlays.clear();
        for (const [token, overlay] of nextOverlays) {
            this.breakpointOverlays.set(token, overlay);
        }
        this.breakpointClearTombstones.clear();
        for (const tombstone of nextTombstones) this.breakpointClearTombstones.add(tombstone);
        this.applyBreakpointConfigurationChanges(changes);
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
        void this.stopAndWait();
    }

    stopAndWait(): Promise<RuntimeOutcome> {
        this.preparationGeneration++;
        const warmup = this.warmupState;
        const draining = this.cancelWarmupAndWait();
        const unsettled = this.activeSettlement && !this.activeSettlement.settled;
        const settlement = this.requestStop();
        if (!unsettled && !warmup && this.profile.engineOptions?.cpp) {
            try { this.engine?.stop(); } catch { /* ignore */ }
        }
        return warmup ? draining.then(() => settlement) : settlement;
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
        const hadWarmup = Boolean(this.warmupState);
        this.disposed = true;
        this.breakpointOverlays.clear();
        this.breakpointClearTombstones.clear();
        const warmup = this.cancelWarmupAndWait();
        this.preparationGeneration++;
        const settlement = this.requestStop();
        if (!hadUnsettledStart && !hadWarmup) {
            try { this.engine?.stop(); } catch { /* ignore */ }
        }

        this.disposalPromise = (async () => {
            const outcome = await settlement;
            await warmup;
            if (initialization) {
                try { await initialization; } catch { /* disposal rejects adoption */ }
            }
            this.cancelScheduledTasks();
            this.debugConfiguration = null;
            if (this.engine) this.releaseEngineHostServices(this.engine, false);
            if (this.engine) this.releaseEngineHostDevice(this.engine);
            this.hostServices.clear();
            this.hostDeviceRegistration = undefined;
            this.runtimeFileTree = emptyDirectory();
            this.runtimeBinaryFiles = {};
            this.runtimeCppArtifacts = undefined;
            this.runtimePathByWorkspacePath.clear();
            this.workspacePathByRuntimePath.clear();
            this.userRuntimePaths.clear();
            this.streamInterceptor = undefined;
            if (this.engine) {
                this.engine.fs = emptyDirectory();
                if ('binaryFiles' in this.engine) {
                    const artifacts = this.engine as ArtifactEngine;
                    artifacts.binaryFiles = {};
                    artifacts.cppArtifacts = undefined;
                }
            }
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

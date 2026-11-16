import type { DirNode, CppArtifacts } from 'debugger-sh'
import type { CppOptions, Engine, Process, Duplex, DebuggerProtocol } from 'debugger-sh-upstream'
import type { CppBuildPlanV1 } from '@/web-ide/contracts/cpp'
import type { RuntimeHostDeviceOpener } from '@/web-ide/contracts/runtime'
import { runtimeRelativeFilePath } from '@/web-ide/core/workspace-path'
import type { RuntimeEngine, RuntimeEngineResult } from './engine-backend'

type UpstreamModule = typeof import('debugger-sh-upstream')
const HOST_DEVICE_PATH = '/dev/debugger-sh-host'
const BUILD_DIRECTORY = '/.web-ide-build'

class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>()
  on(_event: string, listener: (value: T) => void): void { this.listeners.add(listener) }
  emit(value: T): void { for (const listener of this.listeners) listener(value) }
}

class DebugAdapter extends Signal<unknown> {
  enabled = false
  filterInternals = false
  private protocol?: DebuggerProtocol
  private initialize?: Parameters<DebuggerProtocol['send']>[0]

  reset(): void { this.protocol = undefined; this.initialize = undefined }
  attach(protocol?: DebuggerProtocol): void {
    this.protocol = protocol
    if (!protocol) return
    protocol.on('event', (event) => { if (this.protocol === protocol) this.emit(event) })
    if (this.initialize) { protocol.send(this.initialize); this.initialize = undefined }
  }
  send(message: unknown): unknown {
    const request = message as Parameters<DebuggerProtocol['send']>[0]
    if (this.protocol) return this.protocol.send(request)
    // Session initialization can arrive while owned filesystem inputs are mounting.
    if (request.command === 'initialize') {
      this.initialize = request
      return { type: 'response', request_seq: request.seq, command: request.command, success: true }
    }
    return { type: 'response', request_seq: request.seq, command: request.command, success: false }
  }
}

interface Operation {
  readonly abort: AbortController
  readonly done: Promise<RuntimeEngineResult>
  process?: Process
  duplex?: Duplex
  cleanup?: () => void
  input: Promise<void>
}

/** Maps upstream processes into the existing shared session lifecycle. */
export class UpstreamEngineAdapter implements RuntimeEngine {
  fs: DirNode = {}
  binaryFiles: Record<string, Uint8Array> = {}
  cppArtifacts?: CppArtifacts
  cppBuildPlan?: CppBuildPlanV1
  hostDevice: RuntimeHostDeviceOpener | undefined
  readonly stdout = new Signal<Uint8Array>()
  readonly stderr = new Signal<Uint8Array>()
  readonly debugger = new DebugAdapter()
  readonly stdin = {
    write: async (value: string | Uint8Array): Promise<void> => {
      const active = this.active
      if (!active?.process || active.abort.signal.aborted) return
      const owned = typeof value === 'string' ? value : new Uint8Array(value)
      // Pipes require one writer. Pasted lines can arrive before the guest has
      // consumed the previous line, so serialize even callers that do not await.
      active.input = active.input.then(async () => {
        if (active.abort.signal.aborted || active.process!.stdin.closed) return
        if (owned === '\x04') active.process!.stdin.close()
        else await active.process!.stdin.write(owned)
      }).catch(error => { if (!active.abort.signal.aborted && !active.process!.stdin.closed) throw error })
      await active.input
    },
  }

  private module: UpstreamModule
  private engine?: Engine
  private readonly language: 'c' | 'python'
  private active?: Operation
  private disposed = false
  private disposal?: Promise<void>
  private operationId = 0
  private latest?: NonNullable<RuntimeEngine['cacheStats']['latest']>

  static async create(language: 'c' | 'python'): Promise<UpstreamEngineAdapter> {
    const module = await import('debugger-sh-upstream')
    return new UpstreamEngineAdapter(language, module, await module.Engine.create())
  }

  private constructor(language: 'c' | 'python', module: UpstreamModule, engine: Engine) {
    this.language = language
    this.module = module
    this.engine = engine
  }

  get cacheStats(): RuntimeEngine['cacheStats'] {
    return { backend: 'upstream', operationId: this.operationId, ...(this.latest ? { latest: { ...this.latest } } : {}) }
  }

  run(): Promise<RuntimeEngineResult> { return this.submit('run') }
  compile(): Promise<RuntimeEngineResult> { return this.submit('compile') }
  prepareCompiler(): Promise<RuntimeEngineResult> { return this.submit('prepare_compiler') }

  private submit(kind: 'run' | 'compile' | 'prepare_compiler'): Promise<RuntimeEngineResult> {
    if (this.disposed) return Promise.reject(new Error('Engine adapter is disposed'))
    if (this.active) return Promise.reject(new Error('Engine operation is already active'))
    const abort = new AbortController()
    this.debugger.reset()
    // Capture inputs and device ownership before the first asynchronous operation.
    const files = structuredClone(this.fs)
    const binary = Object.fromEntries(Object.entries(this.binaryFiles).map(([path, bytes]) => [path, new Uint8Array(bytes)]))
    const artifacts = structuredClone(this.cppArtifacts)
    const buildPlan = structuredClone(this.cppBuildPlan)
    const opener = kind === 'run' ? this.hostDevice : undefined
    const debug = kind === 'run' && this.debugger.enabled
    const began = performance.now()
    const operation: Operation = {
      abort,
      input: Promise.resolve(),
      done: Promise.resolve().then(async (): Promise<RuntimeEngineResult> => {
        try {
          this.engine ??= await this.module.Engine.create()
          abort.signal.throwIfAborted()
          const engine = this.engine
          if (kind !== 'prepare_compiler') {
            this.validateToolchain(artifacts, buildPlan)
            await this.mount(engine, files, binary, abort.signal)
          }
          abort.signal.throwIfAborted()
          const duplex = opener ? new this.module.Duplex() : undefined
          operation.duplex = duplex
          if (duplex && opener) {
            // The guest still opens ONE read/write path. Framing/correlation are
            // unchanged and remain in the companion's shared device multiplexer.
            duplex.from.flow()
            operation.cleanup = opener({
              signal: abort.signal,
              onData: (listener) => {
                const forward = (bytes: Uint8Array) => { if (!abort.signal.aborted) listener(new Uint8Array(bytes)) }
                duplex.on('data', forward)
                return () => { duplex.off('data', forward) }
              },
              write: async (bytes) => {
                abort.signal.throwIfAborted()
                await duplex.write(new Uint8Array(bytes))
                abort.signal.throwIfAborted()
              },
            }) ?? undefined
          }
          abort.signal.throwIfAborted()
          const io = { stdin: true as const, debug, ...(duplex ? { devices: { [HOST_DEVICE_PATH]: duplex } } : {}) }
          const process = kind === 'prepare_compiler'
            ? engine.run('clang', ['--version'], { sysroot: 'cpp' })
            : this.language === 'python'
              ? engine.run('python', ['/main.py'], io)
              : engine.run('cpp', { ...io, ...this.cppOptions(artifacts, buildPlan), compileOnly: kind === 'compile' })
          operation.process = process
          process.stdout.on('data', (bytes) => { if (!abort.signal.aborted) this.stdout.emit(bytes) })
          process.stderr.on('data', (bytes) => { if (!abort.signal.aborted) this.stderr.emit(bytes) })
          this.debugger.attach(process.debugger?.dap)
          if (abort.signal.aborted) process.kill()
          const result = await process
          if (result.killed || abort.signal.aborted) return { type: 'stopped' }
          // Loading the runtime is a host failure, distinct from a guest program
          // deliberately returning the same numeric exit status (126 or 127).
          if (result.error) {
            return { type: 'error', error: { type: 'EngineLoadError', message: result.error.message } }
          }
          return { type: 'completed', exitCode: result.exitCode }
        } catch (error) {
          if (abort.signal.aborted) return { type: 'stopped' }
          return { type: 'error', error: { type: error instanceof Error ? error.name : 'EngineError', message: String(error instanceof Error ? error.message : error) } }
        } finally {
          abort.abort()
          operation.duplex?.close()
          try { operation.cleanup?.() }
          finally {
            this.debugger.reset()
            this.latest = { operation: kind, elapsedMs: performance.now() - began }
            this.operationId++
            if (this.active === operation) this.active = undefined
          }
        }
      }),
    }
    this.active = operation
    return operation.done
  }

  private validateToolchain(artifacts?: CppArtifacts, plan?: CppBuildPlanV1): void {
    if (this.language !== 'c') return
    const identity = this.module.toolchainProvenance.cpp.sha256
    const required = artifacts?.requiredToolchain
    if (required && (required.compilerSha256 !== identity.llvm || required.sysrootSha256 !== identity.sysroot
      || required.exceptionsSha256 !== identity.sysroot)) {
      throw new Error('Precompiled inputs require a different C++ toolchain; use the upstream course artifact profile')
    }
    if (plan && (plan.profile.toolchain.compilerDigest !== identity.llvm || plan.profile.toolchain.sysrootDigest !== identity.sysroot)) {
      throw new Error('C++ build plan toolchain does not match the pinned upstream artifact')
    }
  }

  private cppOptions(artifacts?: CppArtifacts, plan?: CppBuildPlanV1): CppOptions {
    const path = (value: string) => `/${runtimeRelativeFilePath(value)}`
    const cxxFlags = ['-I/', '-fno-pch-timestamp', '-fvalidate-ast-input-files-content']
    if (plan) {
      cxxFlags.push(`-std=${plan.profile.languageStandard}`)
      for (const include of plan.profile.includeDirectories) cxxFlags.push('-I', path(include))
      for (const define of plan.profile.defines) cxxFlags.push(`-D${define.name}${define.value === undefined ? '' : `=${define.value}`}`)
    }
    if (artifacts?.precompiledHeader) cxxFlags.push('-include-pch', artifacts.precompiledHeader)
    const lldFlags = plan
      ? plan.archives.flatMap(archive => archive.wholeArchive
        ? ['--whole-archive', path(archive.path), '--no-whole-archive'] : [path(archive.path)])
      : [...(artifacts?.archives ?? [])]
    for (const library of plan?.linkLibraries ?? []) lldFlags.push(`-l${library}`)
    // Upstream treats these as globs relative to its filesystem root. Legacy
    // artifact paths are absolute; passing them through silently matches nothing.
    const sources = (artifacts?.sources ?? plan?.sources)?.map(runtimeRelativeFilePath)
    return { buildDir: BUILD_DIRECTORY, cxxFlags, lldFlags, ...(sources ? { sources: [...sources] } : {}) }
  }

  private async mount(engine: Engine, files: DirNode, binary: Record<string, Uint8Array>, signal: AbortSignal): Promise<void> {
    // Only compiler-owned objects survive. Guest-created files never cross runs.
    for (const name of await engine.fs.readDir('/')) {
      signal.throwIfAborted()
      if (`/${name}` !== BUILD_DIRECTORY) await engine.fs.remove(`/${name}`, { recursive: true })
    }
    const write = async (path: string, bytes: string | Uint8Array) => {
      if (path === BUILD_DIRECTORY || path.startsWith(`${BUILD_DIRECTORY}/`)) throw new Error('Execution input collides with the compiler cache')
      signal.throwIfAborted()
      await engine.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
      signal.throwIfAborted()
      await engine.fs.writeFile(path, bytes)
    }
    const visit = async (tree: DirNode, prefix = ''): Promise<void> => {
      for (const [name, value] of Object.entries(tree)) {
        const path = `${prefix}/${name}`
        if (typeof value === 'string') await write(path, value)
        else await visit(value, path)
      }
    }
    await visit(files)
    for (const [path, bytes] of Object.entries(binary)) await write(path, bytes)
  }

  stop(): Promise<void> { return this.cancelCurrentOperation() }
  async cancelCurrentOperation(): Promise<void> {
    const active = this.active
    if (!active) return
    active.abort.abort()
    active.duplex?.close()
    active.process?.kill()
    await active.done
  }

  async releaseCompilerResources(options?: { signal?: AbortSignal }): Promise<'released' | 'cancelled'> {
    if (options?.signal?.aborted) return 'cancelled'
    const active = this.active
    if (active) {
      let onAbort!: () => void
      const aborted = new Promise<false>(resolve => { onAbort = () => resolve(false) })
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (!await Promise.race([active.done.then(() => true), aborted])) return 'cancelled'
      } finally { options?.signal?.removeEventListener('abort', onAbort) }
    }
    if (options?.signal?.aborted || this.active) return 'cancelled'
    this.engine?.dispose()
    this.engine = undefined
    return 'released'
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = this.cancelCurrentOperation().finally(() => { this.engine?.dispose(); this.engine = undefined })
    return this.disposal
  }
}

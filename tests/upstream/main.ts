import { createCppRuntimeProvider, createPythonRuntimeProvider } from 'web-ide/runtimes'
import type { RuntimeExecutionPlan, RuntimeHostDevice, RuntimeSession } from '../../src/web-ide/contracts/runtime'

const sessions: RuntimeSession[] = []
const state = { stdout: '', stderr: '', pauses: [] as unknown[], events: [] as string[], hostRequests: [] as number[][] }
let device: RuntimeHostDevice | undefined
const oldDevices: RuntimeHostDevice[] = []

const fixture = {
  state,
  async create(language: 'python' | 'cpp', host = false) {
    const provider = language === 'cpp'
      ? createCppRuntimeProvider({ backend: 'upstream', preserveCompilerOnCancel: true })
      : createPythonRuntimeProvider({ backend: 'upstream' })
    const session = provider.createSession()
    sessions.push(session)
    session.events.stdout.subscribe(text => { state.stdout += text; state.events.push(`out:${text}`) })
    session.events.stderr.subscribe(text => { state.stderr += text; state.events.push(`err:${text}`) })
    session.events.exit.subscribe(code => state.events.push(`exit:${code}`))
    session.events.debugPaused.subscribe(pause => state.pauses.push(pause))
    if (host) session.registerHostDevice?.(next => {
      if (device) oldDevices.push(device)
      device = next
      return next.onData(bytes => state.hostRequests.push([...bytes]))
    })
  },
  async run(plan: RuntimeExecutionPlan, breakpoints: Record<string, number[]> = {}) {
    const session = sessions.at(-1)!
    const prepared = await session.prepare(plan)
    if (!prepared.success) throw new Error(prepared.errors.join('\n'))
    for (const [file, lines] of Object.entries(breakpoints)) await session.setBreakpoints(file, lines)
    void session.start({ mode: plan.mode })
  },
  warmup: (plan: RuntimeExecutionPlan) => sessions.at(-1)!.warmup?.(plan),
  input: (text: string) => sessions.at(-1)!.writeStdin?.(text),
  stop: () => sessions.at(-1)!.stopAndWait?.(),
  outcome: () => sessions.at(-1)!.waitForSettlement?.(),
  continue: () => sessions.at(-1)!.continueExecution(),
  stepOver: () => sessions.at(-1)!.stepOver(),
  respond: (bytes: number[]) => device!.write(new Uint8Array(bytes)),
  staleResponse: async () => {
    try { await oldDevices.at(-1)!.write(new Uint8Array([99])); return 'accepted' }
    catch { return 'rejected' }
  },
  async dispose() { await Promise.all(sessions.splice(0).map(session => session.disposeAndWait?.())) },
}
Object.assign(window, { upstreamFixture: fixture })
document.querySelector('#ready')!.textContent = 'Runtime fixture ready'
export type UpstreamFixture = typeof fixture

interface CacheBuildInput {
  files: Record<string, string>
  flagValue?: number
  pchValue?: number
}

interface CompilerJob {
  source: string
  output: string
  generation: string | undefined
  args: string[]
}

const precompiledHeaders = new Map<number, { header: string, bytes: Uint8Array }>()

// Observe real compiler work without adding a cache/debug API to the package.
// Probe, linker, executable and PCH-creation jobs do not count as source compiles.
async function observeCompilerJobs<T>(run: () => Promise<T>): Promise<{ result: T, jobs: CompilerJob[] }> {
  const original = Worker.prototype.postMessage
  const jobs: CompilerJob[] = []
  Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
    const value = message as { type?: unknown, job?: { args?: unknown } } | null
    const args = value?.job?.args
    if (value?.type === 'run' && Array.isArray(args) && args.every(arg => typeof arg === 'string')
      && args.includes('-cc1') && args.includes('-emit-obj')) {
      const output = args[args.indexOf('-o') + 1] as string
      jobs.push({ source: args.at(-1) as string, output, generation: output.match(/^\/\.web-ide-build\/([a-f0-9]{64})\//)?.[1], args: [...args] })
    }
    return Reflect.apply(original, this, [message, ...rest])
  }
  try { return { result: await run(), jobs } }
  finally { Worker.prototype.postMessage = original }
}

const cacheFixture = {
  async reset() { await fixture.dispose(); await fixture.create('cpp') },
  async build(input: CacheBuildInput) {
    const { default: manifest } = await import('web-ide/upstream-toolchains.json')
    const pch = input.pchValue === undefined ? undefined : precompiledHeaders.get(input.pchValue)
    if (input.pchValue !== undefined && !pch) throw new Error('Prepare the binary PCH before measuring the build')
    const sources = Object.keys(input.files).filter(path => path.endsWith('.cpp'))
    const stdoutStart = state.stdout.length
    const stderrStart = state.stderr.length
    const observed = await observeCompilerJobs(async () => {
      await fixture.run({
        mode: 'run',
        files: { ...input.files, ...(pch ? { 'course.hpp': pch.header } : {}) },
        cppBuildPlan: {
          version: 1,
          profile: {
            version: 1, target: 'wasm32-wasip1', languageStandard: 'c++23',
            includeDirectories: [], defines: input.flagValue === undefined ? [] : [{ name: 'FLAG_VALUE', value: String(input.flagValue) }],
            warningPreset: 'default',
            toolchain: { compilerDigest: manifest.toolchains.cpp.sha256.llvm, sysrootDigest: manifest.toolchains.cpp.sha256.sysroot, cxxAbiId: 'upstream-libcxx-wasm-eh' },
          },
          sources, archives: [], linkLibraries: [], outputPath: '/main',
        },
        ...(pch ? { binaryFiles: { 'course.pch': pch.bytes }, cppArtifacts: { sources, precompiledHeader: 'course.pch' } } : {}),
      })
      return fixture.outcome()
    })
    const rawStdout = state.stdout.slice(stdoutStart)
    const progress = new Set([
      'Initializing execution environment...', `[build] Building ${sources.join(', ')}…`,
      '\u001b[1;34mInitializing execution environment...\u001b[0m', `\u001b[90m[build] Building ${sources.join(', ')}…\u001b[0m`,
      'Execution environment ready', '\u001b[1;34mExecution environment ready\u001b[0m',
    ])
    const stdout = rawStdout.replace(/\r\n/g, '\n').split('\n').filter(line => !progress.has(line)).join('\n')
    return { outcome: observed.result, jobs: observed.jobs, stdout, rawStdout, stderr: state.stderr.slice(stderrStart) }
  },
  async preparePch(value: number) {
    const { Engine } = await import('debugger-sh-upstream')
    const engine = await Engine.create()
    const header = `#pragma once\ninline int pch_value() { return ${value}; }\n`
    let diagnostics = ''
    try {
      await engine.fs.writeFile('/course.hpp', header)
      // Match the pinned upstream C++ frontend's target, language and EH flags.
      // Only this fixture setup uses Engine directly; all measured executions
      // consume these bytes through the public Web IDE provider above.
      const process = engine.run('clang', [
        '-cc1', '-triple', 'wasm32-wasip1', '-Werror', '-emit-pch', '-disable-free',
        '-isysroot', '/', '-internal-isystem', '/include/c++/v1', '-internal-isystem', '/include',
        '-internal-isystem', '/include/wasm32-wasip1', '-ferror-limit', '4', '-fcolor-diagnostics',
        '-x', 'c++-header', '-std=c++23', '-O0', '-debug-info-kind=standalone', '-dwarf-version=5',
        '-fcxx-exceptions', '-fexceptions', '-exception-model=wasm', '-target-feature',
        '+exception-handling', '-mllvm', '-wasm-enable-eh', '-mllvm', '-wasm-use-legacy-eh=true',
        '-I/', '-fno-pch-timestamp', '-fvalidate-ast-input-files-content', '-o', '/course.pch', '/course.hpp',
      ], { sysroot: 'cpp' })
      process.stderr.on('data', bytes => { diagnostics += new TextDecoder().decode(bytes) })
      const result = await process
      if (result.exitCode !== 0 || result.killed) throw new Error(`PCH setup failed: ${JSON.stringify(result)}\n${diagnostics}`)
      const bytes = new Uint8Array(await engine.fs.readFile('/course.pch'))
      precompiledHeaders.set(value, { header, bytes })
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      return { byteLength: bytes.length, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }
    } finally { engine.dispose() }
  },
}
Object.assign(window, { cacheFixture })
export type CacheFixture = typeof cacheFixture

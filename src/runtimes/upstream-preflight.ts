import type { Engine, Process } from 'debugger-sh-upstream'
import type { RuntimeEngineResult } from './engine-backend'

type Language = 'c' | 'python'
const ready = new WeakMap<Engine, Set<Language>>()
const STDERR_LIMIT = 8192

/**
 * Probe a known-zero host command before mounting guest files or opening devices.
 * The operation owner receives the process immediately and owns Stop/kill. No
 * probe output or debugger is attached to the guest session. Cache only success
 * on this exact Engine instance; a replaced/disposed Engine must load again.
 */
export async function preflightUpstreamRuntime(
  engine: Engine,
  language: Language,
  signal: AbortSignal,
  onProcess: (process: Process) => void,
): Promise<RuntimeEngineResult | undefined> {
  if (signal.aborted) return { type: 'stopped' }
  if (ready.get(engine)?.has(language)) return undefined

  let process: Process | undefined
  let stderr = ''
  let remaining = STDERR_LIMIT
  const decoder = new TextDecoder()
  const capture = (bytes: Uint8Array) => {
    if (signal.aborted || remaining === 0) return
    const bounded = bytes.subarray(0, remaining)
    remaining -= bounded.byteLength
    stderr += decoder.decode(bounded, { stream: true })
  }
  const failure = (detail: string): RuntimeEngineResult => ({
    type: 'error',
    error: {
      type: 'EngineLoadError',
      message: `Could not load the ${language === 'python' ? 'Python' : 'C++'} runtime: ${detail.slice(0, STDERR_LIMIT)}`,
    },
  })

  try {
    process = language === 'python'
      // Isolated mode plus no site initialization prevents residual guest
      // sitecustomize.py/PYTHONPATH from changing the known-zero host probe.
      ? engine.run('python', ['-I', '-S', '-c', 'pass'])
      : engine.run('clang', ['--version'], { sysroot: 'cpp' })
    process.stderr.on('data', capture)
    onProcess(process)
    const result = await process
    if (signal.aborted || result.killed) return { type: 'stopped' }
    if (result.exitCode !== 0) {
      stderr += decoder.decode()
      return failure(stderr.trim() || `Host probe exited with status ${String(result.exitCode)}.`)
    }
    const languages = ready.get(engine) ?? new Set<Language>()
    languages.add(language)
    ready.set(engine, languages)
    return undefined
  } catch (error) {
    if (signal.aborted) return { type: 'stopped' }
    return failure(error instanceof Error ? error.message : String(error))
  } finally {
    process?.stderr.off('data', capture)
  }
}

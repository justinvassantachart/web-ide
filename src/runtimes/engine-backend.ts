import type { Engine, DirNode, CppArtifacts, CppCacheStatistics } from 'debugger-sh'
import type { CppBuildPlanV1 } from '@/web-ide/contracts/cpp'
import type { RuntimeHostDeviceOpener } from '@/web-ide/contracts/runtime'

/** Temporary, instance-scoped migration switch. Existing consumers keep the legacy backend. */
export type EngineBackend = 'legacy' | 'upstream'

export function validateEngineBackend(backend: EngineBackend = 'legacy'): EngineBackend {
  if (backend !== 'legacy' && backend !== 'upstream') throw new TypeError(`Unknown Engine backend: ${String(backend)}`)
  return backend
}

export type RuntimeEngineResult =
  | { type: 'completed'; exitCode: number }
  | { type: 'stopped' }
  | { type: 'error'; error: { type: string; message: string } }

/** The shared session uses this surface; neither backend owns course policy. */
export interface RuntimeEngine {
  fs: DirNode
  binaryFiles: Record<string, Uint8Array>
  cppArtifacts?: CppArtifacts
  cppBuildPlan?: CppBuildPlanV1
  hostDevice?: RuntimeHostDeviceOpener
  readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown }
  readonly stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown }
  readonly stdin: Pick<Engine['stdin'], 'write'>
  readonly debugger: Pick<Engine['debugger'], 'enabled' | 'filterInternals' | 'send'> & {
    on(event: 'event', listener: (message: unknown) => void): unknown
  }
  readonly cacheStats: Omit<Partial<CppCacheStatistics>, 'latest'> & {
    readonly backend?: EngineBackend
    readonly latest?: Partial<NonNullable<CppCacheStatistics['latest']>> & { elapsedMs?: number }
  }
  run(): Promise<RuntimeEngineResult>
  compile(): Promise<RuntimeEngineResult>
  prepareCompiler(options?: { validateCacheInputs?: boolean }): Promise<RuntimeEngineResult>
  stop(): void | Promise<void>
  cancelCurrentOperation?(): Promise<void>
  releaseCompilerResources?: Engine['releaseCompilerResources']
  dispose(): void | Promise<void>
}

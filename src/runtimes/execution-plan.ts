import type { RuntimeExecutionPlan } from '@/web-ide/contracts/runtime'
import { normalizeRuntimeFiles } from '@/web-ide/core/workspace-path'

/** Pure, owned execution snapshot. Reading binaryFiles returns new owned bytes. */
export function buildRuntimeExecutionPlan(plan: RuntimeExecutionPlan): RuntimeExecutionPlan {
  const binaryFiles = Object.fromEntries(Object.entries(plan.binaryFiles ?? {}).map(([path, bytes]) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`Binary input must be bytes: ${path}`)
    return [path, new Uint8Array(bytes)]
  }))
  const snapshot: RuntimeExecutionPlan = {
    files: Object.freeze(normalizeRuntimeFiles(plan.files)),
    mode: plan.mode,
    ...(plan.entrypoint === undefined ? {} : { entrypoint: plan.entrypoint }),
    ...(plan.streamInterceptor === undefined ? {} : { streamInterceptor: plan.streamInterceptor }),
    ...(plan.sourceAliases === undefined ? {} : { sourceAliases: Object.freeze({ ...plan.sourceAliases }) }),
    ...(plan.cppBuildPlan === undefined ? {} : { cppBuildPlan: freezeValue(structuredClone(plan.cppBuildPlan)) }),
    ...(plan.cppArtifacts === undefined ? {} : { cppArtifacts: Object.freeze({
      ...plan.cppArtifacts,
      ...(plan.cppArtifacts.sources === undefined ? {} : { sources: Object.freeze([...plan.cppArtifacts.sources]) }),
      ...(plan.cppArtifacts.archives === undefined ? {} : { archives: Object.freeze([...plan.cppArtifacts.archives]) }),
    }) }),
  }
  if (plan.binaryFiles !== undefined) Object.defineProperty(snapshot, 'binaryFiles', {
    enumerable: true,
    get: () => Object.freeze(Object.fromEntries(Object.entries(binaryFiles).map(([path, bytes]) => [path, new Uint8Array(bytes)]))),
  })
  return Object.freeze(snapshot)
}

function freezeValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeValue(child)
    Object.freeze(value)
  }
  return value
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]))
  return value
}

/** Compare the complete submitted plan, including binary contents and callback identity. */
export function runtimeExecutionPlansEqual(left: RuntimeExecutionPlan, right: RuntimeExecutionPlan): boolean {
  const { binaryFiles: leftBinary = {}, streamInterceptor: leftStream, ...leftText } = left
  const { binaryFiles: rightBinary = {}, streamInterceptor: rightStream, ...rightText } = right
  if (leftStream !== rightStream || JSON.stringify(ordered(leftText)) !== JSON.stringify(ordered(rightText))) return false
  const paths = Object.keys(leftBinary).sort()
  if (paths.length !== Object.keys(rightBinary).length) return false
  for (const path of paths) {
    const a = leftBinary[path], b = rightBinary[path]
    if (!b || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  }
  return true
}

import type { IDEWorkspaceResourceContribution } from '../contracts/contributions'
import type { WorkspaceFiles } from '../contracts/host'
import {
  assertNoFlattenedRuntimePathCollisions,
  canonicalExecutionFilePath,
  canonicalWorkspaceFilePath,
} from './workspace-path'

export interface PartitionedWorkspaceResources {
  workspaceFiles?: WorkspaceFiles
  executionFiles?: WorkspaceFiles
}

function isExecutionOnly(
  contribution: IDEWorkspaceResourceContribution,
): boolean {
  if (
    contribution.scope !== undefined
    && contribution.scope !== 'workspace'
    && contribution.scope !== 'execution-only'
  ) {
    throw new TypeError(
      `Workspace resource scope is not supported: ${JSON.stringify(contribution.scope)}`,
    )
  }
  return contribution.scope === 'execution-only'
}

function assertResourceFileMap(
  files: unknown,
  contributionId: string,
): asserts files is WorkspaceFiles {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new TypeError(
      `Workspace resource ${JSON.stringify(contributionId)} must provide a file map`,
    )
  }
  const prototype = Object.getPrototypeOf(files)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `Workspace resource ${JSON.stringify(contributionId)} must provide a file map`,
    )
  }
}

function mergeResourceFileMap(
  target: WorkspaceFiles,
  files: WorkspaceFiles,
  canonicalize: (path: string) => string,
): void {
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      throw new TypeError(`Workspace file content must be a string: ${JSON.stringify(path)}`)
    }
    target[canonicalize(path)] = content
  }
}

/**
 * Separates persistent workspace seeds from runtime-only files while preserving
 * contribution order within each static plane. An omitted scope retains the
 * existing workspace behavior. Dynamic execution sources are deliberately not
 * invoked or materialized here; only execution-plan preparation resolves them.
 */
export function partitionWorkspaceResources(
  contributions: readonly IDEWorkspaceResourceContribution[],
): PartitionedWorkspaceResources {
  let workspaceFiles: WorkspaceFiles | undefined
  let executionFiles: WorkspaceFiles | undefined

  for (const contribution of contributions) {
    const executionOnly = isExecutionOnly(contribution)
    if (typeof contribution.files === 'function') {
      if (!executionOnly) {
        throw new TypeError(
          `Workspace resource ${JSON.stringify(contribution.id)} may use a files callback only with scope "execution-only"`,
        )
      }
      continue
    }

    const target = executionOnly
      ? (executionFiles ??= Object.create(null) as WorkspaceFiles)
      : (workspaceFiles ??= Object.create(null) as WorkspaceFiles)
    mergeResourceFileMap(
      target,
      contribution.files,
      executionOnly ? canonicalExecutionFilePath : canonicalWorkspaceFilePath,
    )
  }

  return { workspaceFiles, executionFiles }
}

function resolveExecutionResourceFiles(
  contributions: readonly IDEWorkspaceResourceContribution[],
): WorkspaceFiles | undefined {
  let executionFiles: WorkspaceFiles | undefined
  let validatedWorkspaceFiles: WorkspaceFiles | undefined

  for (const contribution of contributions) {
    const executionOnly = isExecutionOnly(contribution)
    const files = contribution.files
    if (!executionOnly) {
      if (typeof files === 'function') {
        throw new TypeError(
          `Workspace resource ${JSON.stringify(contribution.id)} may use a files callback only with scope "execution-only"`,
        )
      }
      mergeResourceFileMap(
        validatedWorkspaceFiles ??= Object.create(null) as WorkspaceFiles,
        files,
        canonicalWorkspaceFilePath,
      )
      continue
    }

    const dynamic = typeof files === 'function'
    const source = dynamic
      ? files()
      : files
    if (dynamic) assertResourceFileMap(source, contribution.id)
    const target = executionFiles ??= Object.create(null) as WorkspaceFiles
    mergeResourceFileMap(
      target,
      source,
      canonicalExecutionFilePath,
    )
  }

  return executionFiles
}

/**
 * Returns the only file plane that a host may persist as user workspace data.
 * Runtime-only and unscoped execution-plan entries are intentionally omitted.
 */
export function projectPersistedWorkspaceFiles(
  files: Readonly<WorkspaceFiles>,
): WorkspaceFiles {
  const persisted = Object.create(null) as WorkspaceFiles
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith('/workspace/')) continue
    if (typeof content !== 'string') {
      throw new TypeError(`Workspace file content must be a string: ${JSON.stringify(path)}`)
    }
    persisted[canonicalWorkspaceFilePath(path)] = content
  }
  return persisted
}

/** Adds runtime-only resources to a copied execution plan file map. */
export function mergeExecutionResourceFiles(
  contributions: readonly IDEWorkspaceResourceContribution[],
  planFiles: WorkspaceFiles,
): WorkspaceFiles {
  const executionFiles = resolveExecutionResourceFiles(contributions)
  if (executionFiles === undefined) return planFiles

  const overlappingPath = Object.keys(executionFiles)
    .filter((path) => Object.hasOwn(planFiles, path))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0]
  if (overlappingPath !== undefined) {
    throw new TypeError(
      `Execution-only resource path ${JSON.stringify(overlappingPath)} conflicts with an existing execution plan file; use a distinct path`,
    )
  }

  const merged = Object.assign(
    Object.create(null) as WorkspaceFiles,
    planFiles,
    executionFiles,
  )
  assertNoFlattenedRuntimePathCollisions(merged)
  return merged
}

/**
 * Builds one runtime/VFS seed from ordered plugin resources and host files.
 * Later contributions replace earlier ones; host-owned files always win.
 */
export function mergeWorkspaceFiles(
  contributions: readonly IDEWorkspaceResourceContribution[],
  hostFiles?: WorkspaceFiles,
): WorkspaceFiles | undefined {
  const { workspaceFiles } = partitionWorkspaceResources(contributions)
  if (workspaceFiles === undefined && hostFiles === undefined) return undefined

  const merged = Object.create(null) as WorkspaceFiles
  const merge = (files: WorkspaceFiles | undefined) => {
    for (const [path, content] of Object.entries(files ?? {})) {
      if (typeof content !== 'string') {
        throw new TypeError(`Workspace file content must be a string: ${JSON.stringify(path)}`)
      }
      merged[canonicalWorkspaceFilePath(path)] = content
    }
  }

  merge(workspaceFiles)
  merge(hostFiles)
  return merged
}

/** Exact, order-independent dependency key for a complete workspace seed. */
export function workspaceFilesFingerprint(files?: WorkspaceFiles): string {
  if (files === undefined) return ''
  return JSON.stringify(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  )
}

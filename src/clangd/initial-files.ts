import { isCppPath } from './config'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
import { normalizeContractVfsPath } from '@/web-ide/core/cpp-contracts'
import { canonicalStringifyV1 } from '@/web-ide/public/canonical-contract'

export const MAX_CLANGD_SUPPORT_FILES = 2_048
export const MAX_CLANGD_SUPPORT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_CLANGD_SUPPORT_TOTAL_BYTES = 32 * 1024 * 1024
export const CLANGD_SUPPORT_ROOTS = Object.freeze(['/support/', '/sysroot/'] as const)

export function normalizeClangdSupportFiles(
  input: Readonly<WorkspaceFiles> | undefined,
  allowWorkspace: boolean,
): WorkspaceFiles {
  if (input === undefined) return Object.create(null) as WorkspaceFiles
  const safe = JSON.parse(canonicalStringifyV1(input)) as WorkspaceFiles
  const entries = Object.entries(safe)
  if (entries.length > MAX_CLANGD_SUPPORT_FILES) {
    throw new RangeError(`clangd support files exceed the ${MAX_CLANGD_SUPPORT_FILES}-file limit`)
  }
  const supportFiles: WorkspaceFiles = Object.create(null)
  let aggregateBytes = 0
  for (const [inputPath, content] of entries) {
    const path = normalizeContractVfsPath(inputPath)
    if (path === '/workspace/.clangd' || path.endsWith('/.clangd')) {
      throw new TypeError('support files cannot replace clangd configuration')
    }
    const rootAllowed = CLANGD_SUPPORT_ROOTS.some((root) => path.startsWith(root))
      || (allowWorkspace && path.startsWith('/workspace/'))
    if (!rootAllowed) {
      throw new TypeError(`clangd support file must use a reviewed support root: ${path}`)
    }
    if (typeof content !== 'string') throw new TypeError(`support file ${path} is not text`)
    const bytes = new TextEncoder().encode(content).byteLength
    if (bytes > MAX_CLANGD_SUPPORT_FILE_BYTES) {
      throw new RangeError(`clangd support file exceeds the per-file byte limit: ${path}`)
    }
    aggregateBytes += bytes
    if (aggregateBytes > MAX_CLANGD_SUPPORT_TOTAL_BYTES) {
      throw new RangeError('clangd support files exceed the aggregate byte limit')
    }
    if (Object.hasOwn(supportFiles, path)) {
      throw new TypeError(`clangd support files contain a duplicate normalized path: ${path}`)
    }
    supportFiles[path] = content
  }
  return supportFiles
}

export interface ClangdInitialFilesConfiguration {
  readonly compileFlags: readonly string[]
  readonly supportFiles?: Readonly<Record<string, string>>
}

/** Builds the complete clangd VFS only after proving every input is unique. */
export function collectClangdInitialFiles(
  workspaceFiles: Readonly<Record<string, string>>,
  supplementalFiles: Readonly<Record<string, string>> | undefined,
  configuration: ClangdInitialFilesConfiguration,
): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (path: string, content: string, source: string) => {
    if (Object.hasOwn(out, path)) {
      throw new TypeError(`clangd ${source} collides with an existing input: ${path}`)
    }
    out[path] = content
  }
  const providerSupportFiles = normalizeClangdSupportFiles(supplementalFiles, true)
  const configuredSupportFiles = normalizeClangdSupportFiles(configuration.supportFiles, false)
  const supportEntries = [
    ...Object.entries(providerSupportFiles),
    ...Object.entries(configuredSupportFiles),
  ]
  if (supportEntries.length > MAX_CLANGD_SUPPORT_FILES) {
    throw new RangeError(`clangd support files exceed the ${MAX_CLANGD_SUPPORT_FILES}-file limit`)
  }
  let aggregateSupportBytes = 0
  for (const [, content] of supportEntries) {
    aggregateSupportBytes += new TextEncoder().encode(content).byteLength
    if (aggregateSupportBytes > MAX_CLANGD_SUPPORT_TOTAL_BYTES) {
      throw new RangeError('clangd support files exceed the aggregate byte limit')
    }
  }

  for (const [path, content] of Object.entries(workspaceFiles)) {
    if (isCppPath(path) || path === '/workspace/.clangd') {
      add(path, content, 'workspace file')
    }
  }
  for (const [path, content] of Object.entries(providerSupportFiles)) {
    if (!isCppPath(path)) continue
    // Provider editor support is a fallback for paths absent from the
    // canonical workspace. Once a user or external authority creates that
    // exact path, the committed workspace text must become authoritative in
    // clangd as it already is everywhere else in the workbench.
    if (path.startsWith('/workspace/') && Object.hasOwn(workspaceFiles, path)) continue
    add(path, content, 'supplemental file')
  }
  for (const [path, content] of Object.entries(configuredSupportFiles)) {
    if (isCppPath(path)) add(path, content, 'support file')
  }
  add('/workspace/.clangd', JSON.stringify({
    CompileFlags: { Add: [...configuration.compileFlags] },
  }), 'generated configuration')
  return out
}

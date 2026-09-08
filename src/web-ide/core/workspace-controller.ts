import { Volume } from 'memfs'
import type { StoreApi } from 'zustand/vanilla'
import type { DebugState } from '@/store/debug-store'
import type { EditorState } from '@/store/editor-store'
import type { FilesState, VFSNode } from '@/store/files-store'
import type { WorkspaceFiles } from '../contracts/host'
import type {
  WorkspaceApplyTransactionV1,
  WorkspaceChangeV1,
  WorkspaceMutationPolicy,
  WorkspaceMutationRequest,
  WorkspaceOperationV1,
  WorkspaceOriginV1,
  WorkspacePersistenceStatus,
} from '../contracts/workspace'
import { projectPersistedWorkspaceFiles } from './workspace-resources'
import {
  canonicalStringifyV1,
  normalizeWorkspacePathV1,
  normalizeWorkspaceTextV1,
  sha256Hex,
} from '../public/canonical-contract'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_REVISION = Number.MAX_SAFE_INTEGER
const MAX_OPERATIONS = 500
const MAX_FILES = 500
const MAX_TEXT_LENGTH = 2_097_152
const WORKSPACE_PREFIX = '/workspace/'
const LOCAL_WRITE_DELAY_MS = 500

let instanceSequence = 0

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0
  for (let index = 0; index < value.length;) {
    const unit = value.charCodeAt(index)
    index += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1
    count += 1
    if (count > limit) return true
  }
  return false
}

function createInstanceNamespace(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
  instanceSequence += 1
  return `web-ide-${instanceSequence}-${random ?? Date.now().toString(36)}`
}

function assertPlainObject<T>(value: T, label: string): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unexpected) throw new TypeError(`${label} contains unsupported property ${JSON.stringify(unexpected)}`)
}

/** Frozen public editable-path normalization used before every transaction commit. */
export function normalizePublicWorkspacePath(input: string): string {
  return normalizeWorkspacePathV1(input)
}

export function normalizeWorkspaceText(text: string): string {
  if (
    typeof text !== 'string'
    || exceedsCodePointLimit(text, MAX_TEXT_LENGTH)
  ) {
    throw new TypeError('workspace text must be a string no longer than 2097152 Unicode code points')
  }
  return normalizeWorkspaceTextV1(text)
}

function normalizeSnapshot(files: Readonly<WorkspaceFiles>): WorkspaceFiles {
  canonicalStringifyV1(files)
  assertPlainObject(files, 'workspace files')
  if (Object.keys(files).length > MAX_FILES) throw new RangeError('workspace contains more than 500 files')
  const result = Object.create(null) as WorkspaceFiles
  for (const [inputPath, inputText] of Object.entries(files)) {
    const path = normalizePublicWorkspacePath(inputPath)
    if (Object.hasOwn(result, path)) throw new TypeError(`duplicate normalized path: ${path}`)
    result[path] = normalizeWorkspaceText(inputText)
  }
  return result
}

function normalizeOrigin(value: WorkspaceOriginV1): WorkspaceOriginV1 {
  canonicalStringifyV1(value)
  assertPlainObject(value, 'workspace transaction origin')
  assertKeys(value, ['kind', 'source', 'echoToken'], 'workspace transaction origin')
  if (!['local-user', 'external-authority', 'bootstrap', 'restore', 'provider'].includes(value.kind)) {
    throw new TypeError('workspace transaction origin kind is invalid')
  }
  if (!ID.test(value.source)) throw new TypeError('workspace transaction origin source is invalid')
  if (value.echoToken !== undefined && !ID.test(value.echoToken)) {
    throw new TypeError('workspace transaction echo token is invalid')
  }
  return Object.freeze({
    kind: value.kind,
    source: value.source,
    ...(value.echoToken === undefined ? {} : { echoToken: value.echoToken }),
  })
}

function expectedDigest(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function normalizeOperations(operations: readonly WorkspaceOperationV1[]): WorkspaceOperationV1[] {
  canonicalStringifyV1(operations)
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    throw new RangeError('workspace transaction must contain between 1 and 500 operations')
  }
  return operations.map((input, index) => {
    assertPlainObject(input, `workspace operation ${index}`)
    if (input.op === 'write') {
      assertKeys(input, ['op', 'path', 'text', 'expectedSha256'], `workspace operation ${index}`)
      return Object.freeze({
        op: 'write' as const,
        path: normalizePublicWorkspacePath(input.path),
        text: normalizeWorkspaceText(input.text),
        ...(input.expectedSha256 === undefined
          ? {}
          : { expectedSha256: expectedDigest(input.expectedSha256, 'expectedSha256')! }),
      })
    }
    if (input.op === 'create') {
      assertKeys(input, ['op', 'path', 'text'], `workspace operation ${index}`)
      return Object.freeze({
        op: 'create' as const,
        path: normalizePublicWorkspacePath(input.path),
        text: normalizeWorkspaceText(input.text),
      })
    }
    if (input.op === 'delete') {
      assertKeys(input, ['op', 'path', 'expectedSha256'], `workspace operation ${index}`)
      return Object.freeze({
        op: 'delete' as const,
        path: normalizePublicWorkspacePath(input.path),
        ...(input.expectedSha256 === undefined
          ? {}
          : { expectedSha256: expectedDigest(input.expectedSha256, 'expectedSha256')! }),
      })
    }
    if (input.op === 'rename') {
      assertKeys(input, ['op', 'from', 'to', 'expectedSha256'], `workspace operation ${index}`)
      return Object.freeze({
        op: 'rename' as const,
        from: normalizePublicWorkspacePath(input.from),
        to: normalizePublicWorkspacePath(input.to),
        ...(input.expectedSha256 === undefined
          ? {}
          : { expectedSha256: expectedDigest(input.expectedSha256, 'expectedSha256')! }),
      })
    }
    if (input.op === 'replace') {
      assertKeys(input, ['op', 'files'], `workspace operation ${index}`)
      return Object.freeze({ op: 'replace' as const, files: Object.freeze(normalizeSnapshot(input.files)) })
    }
    throw new TypeError(`workspace operation ${index} has an invalid op`)
  })
}

function copyFiles(files: Readonly<WorkspaceFiles>): WorkspaceFiles {
  return Object.freeze({ ...files }) as WorkspaceFiles
}

function buildTree(volume: Volume, directory = '/workspace'): VFSNode[] {
  const entries = volume.readdirSync(directory, { encoding: 'utf8' }) as string[]
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .map((name) => {
      const path = `${directory}/${name}`
      const isDirectory = volume.statSync(path).isDirectory()
      return { name, path, isDirectory, children: isDirectory ? buildTree(volume, path) : undefined }
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

export interface WorkspaceControllerOptions {
  editorStore: StoreApi<EditorState>
  filesStore: StoreApi<FilesState>
  debugStore: StoreApi<DebugState>
}

export interface WorkspaceInitializationOptions {
  projectId: string
  initialFiles?: WorkspaceFiles
  ephemeral?: boolean
}

/** Error thrown before an atomic workspace transaction commits. */
export class WorkspaceTransactionError extends Error {
  readonly code: 'revision_mismatch' | 'permission_denied' | 'path_missing' | 'path_exists' | 'digest_mismatch' | 'disposed'

  constructor(
    code: 'revision_mismatch' | 'permission_denied' | 'path_missing' | 'path_exists' | 'digest_mismatch' | 'disposed',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceTransactionError'
    this.code = code
  }
}

/**
 * The sole mutation owner for one mounted workbench. Public paths remain
 * canonical while the controller's Monaco namespace is unique to the mount.
 */
export class WorkspaceController {
  readonly instanceNamespace = createInstanceNamespace()
  readonly monacoAuthority = this.instanceNamespace

  private volume = new Volume()
  private revisionValue = 0
  private transactionSequence = 0
  private initializationGeneration = 0
  private initializationKey: string | undefined
  private projectId = ''
  private ephemeral = true
  private readOnly = false
  private mutationPolicy: WorkspaceMutationPolicy | undefined
  private disposed = false
  private readonly listeners = new Set<(change: WorkspaceChangeV1) => void>()
  private readonly feedDeliveryQueue: Array<{
    change: WorkspaceChangeV1
    listeners: readonly ((change: WorkspaceChangeV1) => void)[]
  }> = []
  private deliveringFeed = false
  private committing = false
  private readonly statusListeners = new Set<(status: WorkspacePersistenceStatus) => void>()
  private readonly pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlightWrites = new Set<Promise<void>>()
  private externalSavingCount = 0
  private persistenceIssue: WorkspacePersistenceStatus | undefined
  private persistenceStatus: WorkspacePersistenceStatus = Object.freeze({ state: 'saved' })
  private readonly stores: WorkspaceControllerOptions

  constructor(stores: WorkspaceControllerOptions) {
    this.stores = stores
    this.volume.mkdirSync('/workspace', { recursive: true })
  }

  get revision(): number {
    return this.revisionValue
  }

  setLocalMutationPolicy(readOnly: boolean, policy?: WorkspaceMutationPolicy): void {
    this.readOnly = readOnly
    this.mutationPolicy = policy
  }

  toMonacoUri(path: string): string {
    return `file://${this.monacoAuthority}${normalizePublicWorkspacePath(path)}`
  }

  ownsMonacoUri(uri: { authority: string; path: string }): boolean {
    return uri.authority === this.monacoAuthority && uri.path.startsWith(WORKSPACE_PREFIX)
  }

  snapshot(): WorkspaceFiles {
    const result: WorkspaceFiles = Object.create(null)
    const walk = (directory: string) => {
      const entries = this.volume.readdirSync(directory, { encoding: 'utf8' }) as string[]
      for (const entry of entries) {
        const path = `${directory}/${entry}`
        const stat = this.volume.statSync(path)
        if (stat.isDirectory()) walk(path)
        else result[path] = this.volume.readFileSync(path, { encoding: 'utf8' }) as string
      }
    }
    walk('/workspace')
    return result
  }

  persistedFiles(): WorkspaceFiles {
    return copyFiles(projectPersistedWorkspaceFiles(this.snapshot()))
  }

  readFile(path: string): string {
    return this.volume.readFileSync(normalizePublicWorkspacePath(path), { encoding: 'utf8' }) as string
  }

  fileExists(path: string): boolean {
    try {
      return this.volume.existsSync(normalizePublicWorkspacePath(path))
    } catch {
      return false
    }
  }

  subscribe(listener: (change: WorkspaceChangeV1) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPersistenceStatus(): WorkspacePersistenceStatus {
    return this.persistenceStatus
  }

  subscribePersistenceStatus(listener: (status: WorkspacePersistenceStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  markExternalSaving(active: boolean): void {
    this.externalSavingCount = Math.max(0, this.externalSavingCount + (active ? 1 : -1))
    this.refreshPersistenceStatus()
  }

  setPersistenceRetry(message?: string): void {
    this.persistenceIssue = Object.freeze({ state: 'retrying', ...(message ? { message } : {}) })
    this.refreshPersistenceStatus()
  }

  setPersistenceError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.persistenceIssue = Object.freeze({ state: 'error', message })
    this.refreshPersistenceStatus()
  }

  clearPersistenceIssue(): void {
    this.persistenceIssue = undefined
    this.refreshPersistenceStatus()
  }

  writeLocal(path: string, text: string): WorkspaceChangeV1 | undefined {
    const normalizedPath = normalizePublicWorkspacePath(path)
    const normalizedText = normalizeWorkspaceText(text)
    if (this.fileExists(normalizedPath) && this.readFile(normalizedPath) === normalizedText) return undefined
    return this.applyLocal([{ op: 'write', path: normalizedPath, text: normalizedText }])
  }

  createFileLocal(path: string, text = ''): WorkspaceChangeV1 {
    return this.applyLocal([{ op: 'create', path, text }])
  }

  deleteLocal(path: string): WorkspaceChangeV1 | undefined {
    const normalized = normalizePublicWorkspacePath(path)
    if (!this.volume.existsSync(normalized)) return undefined
    const stat = this.volume.statSync(normalized)
    if (!stat.isDirectory()) return this.applyLocal([{ op: 'delete', path: normalized }])
    this.assertLocalAllowed({ kind: 'delete', path: normalized })
    const descendants = Object.keys(this.snapshot()).filter((candidate) => candidate.startsWith(`${normalized}/`))
    if (descendants.length === 0) {
      throw new WorkspaceTransactionError('path_missing', `${normalized} contains no text files`)
    }
    return this.applyLocal(descendants.map((candidate) => ({ op: 'delete' as const, path: candidate })))
  }

  renameLocal(from: string, to: string): WorkspaceChangeV1 | undefined {
    const normalizedFrom = normalizePublicWorkspacePath(from)
    const normalizedTo = normalizePublicWorkspacePath(to)
    if (!this.volume.existsSync(normalizedFrom)) return undefined
    const stat = this.volume.statSync(normalizedFrom)
    if (!stat.isDirectory()) return this.applyLocal([{ op: 'rename', from: normalizedFrom, to: normalizedTo }])
    const descendants = Object.keys(this.snapshot()).filter((candidate) => candidate.startsWith(`${normalizedFrom}/`))
    this.assertLocalAllowed({ kind: 'rename', path: normalizedFrom, to: normalizedTo })
    if (descendants.length === 0) {
      throw new WorkspaceTransactionError('path_missing', `${normalizedFrom} contains no text files`)
    }
    return this.applyLocal(descendants.map((candidate) => ({
      op: 'rename' as const,
      from: candidate,
      to: `${normalizedTo}${candidate.slice(normalizedFrom.length)}`,
    })))
  }

  createFolderLocal(path: string): void {
    const normalized = normalizePublicWorkspacePath(path)
    throw new WorkspaceTransactionError(
      'permission_denied',
      `empty workspace directories are derived from text files and cannot be created: ${normalized}`,
    )
  }

  async applyExternal(transaction: WorkspaceApplyTransactionV1): Promise<WorkspaceChangeV1> {
    // Validate and clone the complete untrusted value through property
    // descriptors before authorization. No caller getter or Proxy `get` trap
    // is observed by the authority check or later normalization.
    const data = JSON.parse(canonicalStringifyV1(transaction)) as WorkspaceApplyTransactionV1
    const normalized = this.normalizeApplyTransaction(data)
    if (normalized.origin.kind !== 'external-authority') {
      throw new WorkspaceTransactionError('permission_denied', 'external facade requires an external-authority origin')
    }
    return this.applyValidated(normalized)
  }

  replaceFromRestore(files: WorkspaceFiles, source = 'workspace-restore'): WorkspaceChangeV1 {
    return this.applyInternal([{ op: 'replace', files }], { kind: 'restore', source })
  }

  replaceFromProvider(files: WorkspaceFiles, source: string, echoToken?: string): WorkspaceChangeV1 {
    return this.applyInternal(
      [{ op: 'replace', files }],
      { kind: 'provider', source, ...(echoToken ? { echoToken } : {}) },
    )
  }

  async initialize(options: WorkspaceInitializationOptions): Promise<void> {
    this.assertLive()
    const initialFiles = options.initialFiles ? normalizeSnapshot(options.initialFiles) : undefined
    const initializationKey = canonicalStringifyV1({
      projectId: options.projectId,
      ephemeral: options.ephemeral === true,
      initialFiles: initialFiles ?? null,
    })
    // React StrictMode replays effects on the same retained instance. Treat an
    // identical replay as one bootstrap lifecycle, including while OPFS is
    // still resolving, rather than emitting a second synthetic transaction.
    if (initializationKey === this.initializationKey) return
    this.initializationKey = initializationKey
    const generation = ++this.initializationGeneration
    this.cancelPendingWrites()
    this.projectId = options.ephemeral ? '' : options.projectId
    this.ephemeral = options.ephemeral === true

    let files: WorkspaceFiles = Object.create(null)
    if (!this.ephemeral) {
      try {
        const { readWorkspaceFromOPFS } = await import('@/vfs/opfs-sync')
        files = normalizeSnapshot(await readWorkspaceFromOPFS(this.projectId))
      } catch {
        // Browser-local persistence is an optional, untrusted cache.
      }
    }
    if (generation !== this.initializationGeneration || this.disposed) return
    if (Object.keys(files).length === 0) files = initialFiles ?? {}
    if (Object.keys(files).length === 0 && !this.ephemeral) {
      const { DEFAULT_MAIN } = await import('@/vfs/default-main')
      if (generation !== this.initializationGeneration || this.disposed) return
      files = { '/workspace/main.cpp': DEFAULT_MAIN }
    }
    if (Object.keys(files).length === 0) {
      files = initialFiles ?? {}
    }
    this.applyInternal([{ op: 'replace', files }], { kind: 'bootstrap', source: 'workspace-bootstrap' })
  }

  async flushLocalPersistence(): Promise<void> {
    for (const path of [...this.pendingWrites.keys()]) this.flushScheduledPath(path)
    await Promise.all([...this.inFlightWrites])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.initializationGeneration += 1
    this.cancelPendingWrites()
    this.listeners.clear()
    this.statusListeners.clear()
  }

  private applyLocal(operations: readonly WorkspaceOperationV1[]): WorkspaceChangeV1 {
    const normalized = normalizeOperations(operations)
    for (const operation of normalized) {
      if (operation.op === 'replace') throw new WorkspaceTransactionError('permission_denied', 'local replace is not available')
      if (operation.op === 'rename') this.assertLocalAllowed({ kind: 'rename', path: operation.from, to: operation.to })
      else this.assertLocalAllowed({ kind: operation.op, path: operation.path })
    }
    return this.commit(normalized, {
      kind: 'local-user',
      source: 'workbench-ui',
    }, this.nextTransactionId('local'))
  }

  private applyInternal(operations: readonly WorkspaceOperationV1[], origin: WorkspaceOriginV1): WorkspaceChangeV1 {
    return this.commit(normalizeOperations(operations), normalizeOrigin(origin), this.nextTransactionId(origin.kind))
  }

  private normalizeApplyTransaction(transaction: WorkspaceApplyTransactionV1): WorkspaceApplyTransactionV1 {
    assertPlainObject(transaction, 'workspace transaction')
    assertKeys(transaction, ['version', 'kind', 'transactionId', 'expectedRevision', 'origin', 'operations'], 'workspace transaction')
    if (transaction.version !== 1 || transaction.kind !== 'apply') throw new TypeError('unsupported workspace transaction version or kind')
    if (typeof transaction.transactionId !== 'string' || !ID.test(transaction.transactionId)) {
      throw new TypeError('workspace transaction id is invalid')
    }
    if (
      !Number.isSafeInteger(transaction.expectedRevision)
      || transaction.expectedRevision < 0
      || transaction.expectedRevision > MAX_REVISION
    ) {
      throw new TypeError('workspace expected revision is invalid')
    }
    const origin = normalizeOrigin(transaction.origin)
    const operations = normalizeOperations(transaction.operations)
    return Object.freeze({
      version: 1,
      kind: 'apply',
      transactionId: transaction.transactionId,
      expectedRevision: transaction.expectedRevision,
      origin,
      operations: Object.freeze(operations),
    })
  }

  private async applyValidated(
    transaction: WorkspaceApplyTransactionV1,
  ): Promise<WorkspaceChangeV1> {
    this.assertLive()
    if (transaction.expectedRevision !== this.revisionValue) {
      throw new WorkspaceTransactionError('revision_mismatch', `expected revision ${transaction.expectedRevision}, current revision ${this.revisionValue}`)
    }
    const origin = transaction.origin
    const operations = transaction.operations
    const capturedRevision = this.revisionValue
    const current = this.snapshot()
    const candidate = this.applyToCandidate(current, operations)
    for (const operation of operations) {
      if (!('expectedSha256' in operation) || operation.expectedSha256 === undefined) continue
      const sourcePath = operation.op === 'rename' ? operation.from : operation.path
      const currentText = current[sourcePath]
      if (currentText === undefined || await sha256Hex(currentText) !== operation.expectedSha256) {
        throw new WorkspaceTransactionError('digest_mismatch', `workspace digest precondition failed for ${sourcePath}`)
      }
    }
    if (this.revisionValue !== capturedRevision) {
      throw new WorkspaceTransactionError('revision_mismatch', 'workspace changed while transaction preconditions were evaluated')
    }
    return this.commitCandidate(candidate, operations, origin, transaction.transactionId)
  }

  private commit(
    operations: readonly WorkspaceOperationV1[],
    origin: WorkspaceOriginV1,
    transactionId: string,
  ): WorkspaceChangeV1 {
    this.assertLive()
    const candidate = this.applyToCandidate(this.snapshot(), operations)
    return this.commitCandidate(candidate, operations, normalizeOrigin(origin), transactionId)
  }

  private applyToCandidate(current: WorkspaceFiles, operations: readonly WorkspaceOperationV1[]): WorkspaceFiles {
    let candidate = { ...current }
    for (const operation of operations) {
      if (operation.op === 'replace') {
        candidate = { ...operation.files }
        continue
      }
      if (operation.op === 'create') {
        if (Object.hasOwn(candidate, operation.path)) throw new WorkspaceTransactionError('path_exists', `${operation.path} already exists`)
        candidate[operation.path] = operation.text
        continue
      }
      const source = operation.op === 'rename' ? operation.from : operation.path
      if (!Object.hasOwn(candidate, source)) throw new WorkspaceTransactionError('path_missing', `${source} does not exist`)
      if (operation.op === 'write') candidate[operation.path] = operation.text
      else if (operation.op === 'delete') delete candidate[operation.path]
      else {
        if (Object.hasOwn(candidate, operation.to)) throw new WorkspaceTransactionError('path_exists', `${operation.to} already exists`)
        candidate[operation.to] = candidate[operation.from]
        delete candidate[operation.from]
      }
    }
    return candidate
  }

  private commitCandidate(
    candidate: WorkspaceFiles,
    operations: readonly WorkspaceOperationV1[],
    origin: WorkspaceOriginV1,
    transactionId: string,
  ): WorkspaceChangeV1 {
    if (this.committing) {
      throw new WorkspaceTransactionError(
        'revision_mismatch',
        'workspace mutation cannot re-enter an atomic commit',
      )
    }
    if (this.revisionValue >= MAX_REVISION) throw new RangeError('workspace revision exhausted')
    let change!: WorkspaceChangeV1
    this.committing = true
    try {
      const previous = this.snapshot()
      const nextVolume = new Volume()
      nextVolume.mkdirSync('/workspace', { recursive: true })
      for (const [path, text] of Object.entries(candidate)) {
        const directory = path.slice(0, path.lastIndexOf('/'))
        if (!nextVolume.existsSync(directory)) nextVolume.mkdirSync(directory, { recursive: true })
        nextVolume.writeFileSync(path, text, { encoding: 'utf8' })
      }
      this.volume = nextVolume
      this.synchronizeStores(operations, candidate)
      this.persistChanges(previous, candidate, operations)
      change = Object.freeze({
        version: 1 as const,
        kind: 'change' as const,
        revision: ++this.revisionValue,
        transactionId,
        origin,
        operations: Object.freeze([...operations]),
      })
    } finally {
      this.committing = false
    }
    this.enqueueFeedDelivery(change)
    return change
  }

  private enqueueFeedDelivery(change: WorkspaceChangeV1): void {
    this.feedDeliveryQueue.push({ change, listeners: [...this.listeners] })
    if (this.deliveringFeed) return
    this.deliveringFeed = true
    try {
      while (this.feedDeliveryQueue.length > 0) {
        const next = this.feedDeliveryQueue.shift()!
        for (const listener of next.listeners) {
          try { listener(next.change) } catch (error) { console.warn('[web-ide] workspace listener failed', error) }
        }
      }
    } finally {
      this.deliveringFeed = false
    }
  }

  private synchronizeStores(operations: readonly WorkspaceOperationV1[], files: WorkspaceFiles): void {
    const editor = this.stores.editorStore.getState()
    const debug = this.stores.debugStore.getState()
    const explorer = this.stores.filesStore.getState()
    for (const operation of operations) {
      if (operation.op === 'rename') {
        this.runStoreMutation(() => editor.renameOpenFile(operation.from, operation.to))
        this.runStoreMutation(() => debug.renameFileBreakpoints(operation.from, operation.to))
        this.runStoreMutation(() => explorer.renameExpandedPath(operation.from, operation.to))
      }
    }
    this.runStoreMutation(() => editor.pruneTabs(
      (path) => Object.hasOwn(files, path),
      (path) => files[path] ?? null,
    ))
    this.runStoreMutation(() => debug.pruneBreakpointFiles((path) => Object.hasOwn(files, path)))
    this.runStoreMutation(() => explorer.pruneExpandedDirs((path) =>
      this.volume.existsSync(path) && this.volume.statSync(path).isDirectory(),
    ))
    const current = this.stores.editorStore.getState().activeFile
    if (current && Object.hasOwn(files, current)) {
      this.runStoreMutation(() => editor.setActiveFile(current, files[current]))
    }
    else {
      const first = Object.keys(files).sort()[0]
      if (first) this.runStoreMutation(() => editor.setActiveFile(first, files[first]))
    }
    this.refreshFileTree()
  }

  private refreshFileTree(): void {
    const files = buildTree(this.volume)
    this.runStoreMutation(() => this.stores.filesStore.getState().setFiles(files))
  }

  private runStoreMutation(mutation: () => void): void {
    try {
      mutation()
    } catch (error) {
      // Zustand publishes synchronously after assigning the next state. A
      // throwing observer must not strand the accepted VFS transaction before
      // its remaining store reconciliation, revision, persistence, or feed.
      console.warn('[web-ide] workbench store observer failed', error)
    }
  }

  private assertLocalAllowed(request: WorkspaceMutationRequest): void {
    if (this.readOnly || this.mutationPolicy?.(request) === false) {
      throw new WorkspaceTransactionError('permission_denied', `local ${request.kind} is not permitted for ${request.path}`)
    }
  }

  private nextTransactionId(prefix: string): string {
    this.transactionSequence += 1
    return `${prefix}:${this.transactionSequence}`
  }

  private persistChanges(
    previous: WorkspaceFiles,
    candidate: WorkspaceFiles,
    operations: readonly WorkspaceOperationV1[],
  ): void {
    if (!this.projectId || this.ephemeral) return
    const isSingleLocalWrite = operations.length === 1 && operations[0]?.op === 'write'
    for (const path of Object.keys(previous)) {
      if (!Object.hasOwn(candidate, path)) void this.persistDelete(path)
    }
    for (const [path, text] of Object.entries(candidate)) {
      if (previous[path] === text) continue
      if (isSingleLocalWrite) this.scheduleWrite(path, text)
      else this.persistWrite(path, text)
    }
  }

  private scheduleWrite(path: string, text: string): void {
    const current = this.pendingWrites.get(path)
    if (current) clearTimeout(current)
    this.pendingWrites.set(path, setTimeout(() => {
      this.pendingWrites.delete(path)
      this.persistWrite(path, text)
      this.refreshPersistenceStatus()
    }, LOCAL_WRITE_DELAY_MS))
    this.refreshPersistenceStatus()
  }

  private flushScheduledPath(path: string): void {
    const timer = this.pendingWrites.get(path)
    if (!timer) return
    clearTimeout(timer)
    this.pendingWrites.delete(path)
    if (this.fileExists(path)) this.persistWrite(path, this.readFile(path))
  }

  private persistWrite(path: string, text: string): void {
    const projectId = this.projectId
    const task = import('@/vfs/opfs-sync')
      .then(({ syncToOPFS }) => syncToOPFS(projectId, path, text))
      .finally(() => {
        this.inFlightWrites.delete(task)
        this.refreshPersistenceStatus()
      })
    this.inFlightWrites.add(task)
    this.refreshPersistenceStatus()
  }

  private persistDelete(path: string): Promise<void> {
    const projectId = this.projectId
    const task = import('@/vfs/opfs-sync')
      .then(({ deleteFromOPFS }) => deleteFromOPFS(projectId, path))
      .finally(() => {
        this.inFlightWrites.delete(task)
        this.refreshPersistenceStatus()
      })
    this.inFlightWrites.add(task)
    this.refreshPersistenceStatus()
    return task
  }

  private cancelPendingWrites(): void {
    for (const timer of this.pendingWrites.values()) clearTimeout(timer)
    this.pendingWrites.clear()
    this.refreshPersistenceStatus()
  }

  private refreshPersistenceStatus(): void {
    const state = this.persistenceIssue ?? (this.pendingWrites.size || this.inFlightWrites.size || this.externalSavingCount
      ? Object.freeze({ state: 'saving' as const })
      : Object.freeze({ state: 'saved' as const }))
    this.updatePersistenceStatus(state)
  }

  private updatePersistenceStatus(status: WorkspacePersistenceStatus): void {
    if (this.persistenceStatus.state === status.state
      && ('message' in this.persistenceStatus ? this.persistenceStatus.message : undefined)
        === ('message' in status ? status.message : undefined)) return
    this.persistenceStatus = status
    for (const listener of [...this.statusListeners]) {
      try { listener(status) } catch { /* status observers cannot interrupt persistence */ }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new WorkspaceTransactionError('disposed', 'workspace controller is disposed')
  }
}

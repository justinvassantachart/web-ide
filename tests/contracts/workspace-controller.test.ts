import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { WorkspaceTransactionError } from '../../src/web-ide/core/workspace-controller'
import type { WorkspaceMutationRequest } from '../../src/web-ide/contracts/workspace'

async function initialized(files: Record<string, string>) {
  const instance = createWorkbenchInstance()
  await instance.workspace.initialize({
    projectId: 'memory-test',
    initialFiles: files,
    ephemeral: true,
  })
  return instance
}

describe('instance-owned workspace controller', () => {
  it('isolates overlapping canonical paths, stores, breakpoints, URIs, and feeds', async () => {
    const first = await initialized({ '/workspace/main.cpp': 'first\n' })
    const second = await initialized({ '/workspace/main.cpp': 'second\n' })
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    first.workspace.subscribe(firstListener)
    second.workspace.subscribe(secondListener)

    first.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 4)
    first.workspace.writeLocal('/workspace/main.cpp', 'changed\n')

    expect(first.workspace.readFile('/workspace/main.cpp')).toBe('changed\n')
    expect(second.workspace.readFile('/workspace/main.cpp')).toBe('second\n')
    expect(first.debugStore.getState().breakpoints['/workspace/main.cpp']).toEqual([4])
    expect(second.debugStore.getState().breakpoints).toEqual({})
    expect(first.workspace.toMonacoUri('/workspace/main.cpp'))
      .not.toBe(second.workspace.toMonacoUri('/workspace/main.cpp'))
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()
  })

  it('normalizes and emits one atomic local change with one revision increment', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const initialRevision = instance.workspace.revision
    const listener = vi.fn()
    instance.workspace.subscribe(listener)

    const change = instance.workspace.writeLocal('/workspace/main.cpp', 'new\r\n')

    expect(change).toMatchObject({
      kind: 'change',
      revision: initialRevision + 1,
      origin: { kind: 'local-user', source: 'workbench-ui' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'new\n' }],
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(change)
  })

  it('queues reentrant commits so every observer receives each revision once in order', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const first: number[] = []
    const second: number[] = []
    let reentered = false
    instance.workspace.subscribe((change) => {
      first.push(change.revision)
      if (!reentered) {
        reentered = true
        instance.workspace.writeLocal('/workspace/main.cpp', 'nested\n')
      }
    })
    instance.workspace.subscribe((change) => second.push(change.revision))
    const initialRevision = instance.workspace.revision

    instance.workspace.writeLocal('/workspace/main.cpp', 'outer\n')

    expect(first).toEqual([initialRevision + 1, initialRevision + 2])
    expect(second).toEqual(first)
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('nested\n')
  })

  it('completes an accepted commit despite throwing store and public observers', async () => {
    const instance = await initialized({
      '/workspace/main.cpp': 'old\n',
      '/workspace/other.cpp': 'other\n',
    })
    instance.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 3)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const storeError = new Error('throwing store observer')
    const unsubscribers = [
      instance.editorStore.subscribe(() => { throw storeError }),
      instance.filesStore.subscribe(() => { throw storeError }),
      instance.debugStore.subscribe(() => { throw storeError }),
    ]
    const delivered = vi.fn()
    instance.workspace.subscribe(() => { throw new Error('throwing feed observer') })
    instance.workspace.subscribe(delivered)
    const revision = instance.workspace.revision

    const change = await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'observer-isolation',
      expectedRevision: revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'rename', from: '/workspace/main.cpp', to: '/workspace/renamed.cpp' }],
    })

    expect(instance.workspace.revision).toBe(revision + 1)
    expect(instance.workspace.snapshot()).toEqual({
      '/workspace/other.cpp': 'other\n',
      '/workspace/renamed.cpp': 'old\n',
    })
    expect(instance.debugStore.getState().breakpoints['/workspace/renamed.cpp']).toEqual([3])
    expect(instance.editorStore.getState().openFiles).toContain('/workspace/renamed.cpp')
    expect(delivered).toHaveBeenCalledExactlyOnceWith(change)
    expect(warnings).toHaveBeenCalled()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    warnings.mockRestore()
  })

  it('rejects store-observer mutation reentry before publishing the atomic commit', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const feed = vi.fn()
    let attempted = false
    const unsubscribeStore = instance.editorStore.subscribe(() => {
      if (attempted) return
      attempted = true
      instance.workspace.writeLocal('/workspace/main.cpp', 'reentered\n')
    })
    instance.workspace.subscribe(feed)
    const revision = instance.workspace.revision

    const change = instance.workspace.writeLocal('/workspace/main.cpp', 'accepted\n')

    expect(attempted).toBe(true)
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('accepted\n')
    expect(instance.workspace.revision).toBe(revision + 1)
    expect(feed).toHaveBeenCalledExactlyOnceWith(change)
    expect(warnings).toHaveBeenCalledWith(
      '[web-ide] workbench store observer failed',
      expect.objectContaining({ code: 'revision_mismatch' }),
    )
    unsubscribeStore()
    warnings.mockRestore()
  })

  it('treats a StrictMode-style identical initialization replay as one bootstrap', async () => {
    const instance = createWorkbenchInstance()
    const listener = vi.fn()
    instance.workspace.subscribe(listener)
    const options = {
      projectId: 'strict-bootstrap',
      initialFiles: { '/workspace/main.cpp': 'main\n' },
      ephemeral: true,
    }

    await instance.workspace.initialize(options)
    const revision = instance.workspace.revision
    await instance.workspace.initialize(options)

    expect(instance.workspace.revision).toBe(revision)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('applies external authority once without reclassifying it as local', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const listener = vi.fn()
    instance.workspace.subscribe(listener)
    const revision = instance.workspace.revision

    const change = await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-change-1',
      expectedRevision: revision,
      origin: {
        kind: 'external-authority',
        source: 'external-provider',
        echoToken: 'upstream-9',
      },
      operations: [
        { op: 'write', path: '/workspace/main.cpp', text: 'remote\n' },
        { op: 'create', path: '/workspace/remote.h', text: '#pragma once\n' },
      ],
    })

    expect(change.origin).toEqual({
      kind: 'external-authority',
      source: 'external-provider',
      echoToken: 'upstream-9',
    })
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('remote\n')
    expect(instance.workspace.readFile('/workspace/remote.h')).toBe('#pragma once\n')
    expect(instance.editorStore.getState().activeFileContent).toBe('remote\n')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('leaves all files and the revision unchanged when any operation fails', async () => {
    const instance = await initialized({
      '/workspace/main.cpp': 'main\n',
      '/workspace/existing.h': 'header\n',
    })
    const before = instance.workspace.snapshot()
    const revision = instance.workspace.revision
    const listener = vi.fn()
    instance.workspace.subscribe(listener)

    await expect(instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-change-2',
      expectedRevision: revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [
        { op: 'write', path: '/workspace/main.cpp', text: 'partial\n' },
        { op: 'create', path: '/workspace/existing.h', text: 'collision\n' },
      ],
    })).rejects.toMatchObject({ code: 'path_exists' })

    expect(instance.workspace.snapshot()).toEqual(before)
    expect(instance.workspace.revision).toBe(revision)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects the 501st local or external create without changing state, revision, or feed', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`/workspace/file-${index}.cpp`, `${index}\n`]),
    )
    const local = await initialized(files)
    const localBefore = local.workspace.snapshot()
    const localRevision = local.workspace.revision
    const localListener = vi.fn()
    local.workspace.subscribe(localListener)

    expect(() => local.workspace.createFileLocal('/workspace/file-500.cpp', 'overflow\n'))
      .toThrow(/more than 500 files/)
    expect(local.workspace.snapshot()).toEqual(localBefore)
    expect(local.workspace.revision).toBe(localRevision)
    expect(localListener).not.toHaveBeenCalled()

    const external = await initialized(files)
    const externalBefore = external.workspace.snapshot()
    const externalRevision = external.workspace.revision
    const externalListener = vi.fn()
    external.workspace.subscribe(externalListener)

    await expect(external.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'external-file-limit',
      expectedRevision: externalRevision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [
        { op: 'write', path: '/workspace/file-0.cpp', text: 'must-not-commit\n' },
        { op: 'create', path: '/workspace/file-500.cpp', text: 'overflow\n' },
      ],
    })).rejects.toThrow(/more than 500 files/)
    expect(external.workspace.snapshot()).toEqual(externalBefore)
    expect(external.workspace.revision).toBe(externalRevision)
    expect(externalListener).not.toHaveBeenCalled()
  })

  it('renames and prunes breakpoint paths with the committed file transaction', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'main\n' })
    instance.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 3)

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-rename',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'rename', from: '/workspace/main.cpp', to: '/workspace/program.cpp' }],
    })
    expect(instance.debugStore.getState().breakpoints).toEqual({
      '/workspace/program.cpp': [3],
    })

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-delete',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'delete', path: '/workspace/program.cpp' }],
    })
    expect(instance.debugStore.getState().breakpoints).toEqual({})
  })

  it('derives directories from files and lowers directory rename/delete atomically', async () => {
    const instance = await initialized({
      '/workspace/source/a.cpp': 'a\n',
      '/workspace/source/nested/b.h': 'b\n',
      '/workspace/keep.cpp': 'keep\n',
    })
    const listener = vi.fn()
    instance.workspace.subscribe(listener)

    expect(() => instance.workspace.createFolderLocal('/workspace/empty'))
      .toThrow(/derived from text files/)
    const renameRevision = instance.workspace.revision
    const renamed = instance.workspace.renameLocal('/workspace/source', '/workspace/lib')
    expect(renamed).toMatchObject({
      revision: renameRevision + 1,
      operations: [
        { op: 'rename', from: '/workspace/source/a.cpp', to: '/workspace/lib/a.cpp' },
        { op: 'rename', from: '/workspace/source/nested/b.h', to: '/workspace/lib/nested/b.h' },
      ],
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(Object.keys(instance.workspace.snapshot())).not.toContain('/workspace/lib')

    const deleteRevision = instance.workspace.revision
    const deleted = instance.workspace.deleteLocal('/workspace/lib')
    expect(deleted).toMatchObject({ revision: deleteRevision + 1 })
    expect(deleted?.operations).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(instance.workspace.snapshot()).toEqual({ '/workspace/keep.cpp': 'keep\n' })
    expect(instance.workspace.deleteLocal('/workspace/empty')).toBeUndefined()
    expect(instance.workspace.renameLocal('/workspace/empty', '/workspace/new')).toBeUndefined()
  })

  it('blocks local read-only mutations but accepts authoritative external updates', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    instance.workspace.setLocalMutationPolicy(true)

    expect(() => instance.workspace.writeLocal('/workspace/main.cpp', 'local\n'))
      .toThrow(WorkspaceTransactionError)
    instance.debugStore.getState().toggleBreakpoint('/workspace/main.cpp', 2)
    expect(instance.debugStore.getState().breakpoints['/workspace/main.cpp']).toEqual([2])

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-change-3',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'remote\n' }],
    })
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('remote\n')
  })

  it('applies the fine-grained policy to every local file mutation kind only', async () => {
    const instance = await initialized({
      '/workspace/main.cpp': 'main\n',
      '/workspace/delete.cpp': 'delete\n',
      '/workspace/rename.cpp': 'rename\n',
    })
    const policy = vi.fn((request: WorkspaceMutationRequest) => request.path.length === 0)
    instance.workspace.setLocalMutationPolicy(false, policy)
    const before = instance.workspace.snapshot()
    const revision = instance.workspace.revision

    expect(() => instance.workspace.writeLocal('/workspace/main.cpp', 'changed\n'))
      .toThrow(/not permitted/)
    expect(() => instance.workspace.createFileLocal('/workspace/new.cpp'))
      .toThrow(/not permitted/)
    expect(() => instance.workspace.deleteLocal('/workspace/delete.cpp'))
      .toThrow(/not permitted/)
    expect(() => instance.workspace.renameLocal('/workspace/rename.cpp', '/workspace/renamed.cpp'))
      .toThrow(/not permitted/)

    expect(policy.mock.calls.map(([request]) => request.kind)).toEqual([
      'write',
      'create',
      'delete',
      'rename',
    ])
    expect(instance.workspace.snapshot()).toEqual(before)
    expect(instance.workspace.revision).toBe(revision)

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'policy-bypass-authority',
      expectedRevision: revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'authority\n' }],
    })
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('authority\n')
    expect(policy).toHaveBeenCalledTimes(4)
  })

  it('rejects backslashes, traversal, oversized code-point paths, and unpaired surrogates', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const applyPath = (path: string) => instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'invalid-path',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'create', path, text: '' }],
    })

    await expect(applyPath('/workspace/bad\\name.cpp')).rejects.toThrow()
    await expect(applyPath('/workspace/../bad.cpp')).rejects.toThrow()
    await expect(applyPath(`/workspace/${'😀'.repeat(1_025)}`)).rejects.toThrow()
    await expect(applyPath('/workspace/bad\ud800.cpp')).rejects.toThrow()
    await expect(instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'invalid-text',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'external-provider' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: '\ud800' }],
    })).rejects.toThrow()
  })

  it('rejects non-JSON transaction shapes without invoking accessors', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const base = () => ({
      version: 1 as const,
      kind: 'apply' as const,
      transactionId: 'invalid-json-shape',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority' as const, source: 'external-provider' },
      operations: [{ op: 'write' as const, path: '/workspace/main.cpp', text: 'new\n' }],
    })

    const symbolTransaction = base() as ReturnType<typeof base> & Record<symbol, boolean>
    symbolTransaction[Symbol('hidden')] = true
    await expect(instance.workspace.applyExternal(symbolTransaction)).rejects.toThrow(/symbol key/)

    const sparseTransaction = base()
    sparseTransaction.operations = new Array(1) as typeof sparseTransaction.operations
    await expect(instance.workspace.applyExternal(sparseTransaction)).rejects.toThrow(/dense array/)

    const accessorTransaction = base()
    const sourceGetter = vi.fn(() => 'external-provider')
    Object.defineProperty(accessorTransaction.origin, 'source', {
      enumerable: true,
      get: sourceGetter,
    })
    await expect(instance.workspace.applyExternal(accessorTransaction)).rejects.toThrow(/data property/)
    expect(sourceGetter).not.toHaveBeenCalled()

    const unauthorizedWithGetter = base()
    unauthorizedWithGetter.origin.kind = 'local-user' as 'external-authority'
    const operationGetter = vi.fn(() => 'new\n')
    Object.defineProperty(unauthorizedWithGetter.operations[0], 'text', {
      enumerable: true,
      get: operationGetter,
    })
    await expect(instance.workspace.applyExternal(unauthorizedWithGetter)).rejects.toThrow(/data property/)
    expect(operationGetter).not.toHaveBeenCalled()

    let propertyReads = 0
    const proxied = new Proxy(base(), {
      get() {
        propertyReads += 1
        throw new Error('untrusted get trap was invoked')
      },
    })
    await expect(instance.workspace.applyExternal(proxied)).resolves.toMatchObject({
      transactionId: 'invalid-json-shape',
      origin: { kind: 'external-authority' },
    })
    expect(propertyReads).toBe(0)

    const nestedBase = base()
    let nestedPropertyReads = 0
    nestedBase.operations = new Proxy(nestedBase.operations, {
      get() {
        nestedPropertyReads += 1
        throw new Error('nested untrusted get trap was invoked')
      },
    })
    await expect(instance.workspace.applyExternal({
      ...nestedBase,
      transactionId: 'nested-proxy-shape',
      expectedRevision: instance.workspace.revision,
    })).resolves.toMatchObject({ transactionId: 'nested-proxy-shape' })
    expect(nestedPropertyReads).toBe(0)
  })

  it('rejects accessor descriptors even when Object.prototype fabricates an inherited value', async () => {
    const instance = await initialized({ '/workspace/main.cpp': 'old\n' })
    const revision = instance.workspace.revision
    const listener = vi.fn()
    instance.workspace.subscribe(listener)
    const sourceGetter = vi.fn(() => 'must-not-run')
    const inheritedValueGetter = vi.fn(() => 'external-provider')
    const previousValueDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
    const origin = { kind: 'external-authority' as const, source: 'placeholder' }
    Object.defineProperty(origin, 'source', {
      configurable: true,
      enumerable: true,
      get: sourceGetter,
    })
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get: inheritedValueGetter,
    })

    let application!: ReturnType<typeof instance.workspace.applyExternal>
    try {
      application = instance.workspace.applyExternal({
        version: 1,
        kind: 'apply',
        transactionId: 'inherited-descriptor-value',
        expectedRevision: revision,
        origin,
        operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'forged\n' }],
      })
    } finally {
      if (previousValueDescriptor) Object.defineProperty(Object.prototype, 'value', previousValueDescriptor)
      else delete (Object.prototype as Record<string, unknown>).value
    }

    await expect(application).rejects.toThrow(/data property/)
    expect(sourceGetter).not.toHaveBeenCalled()
    expect(inheritedValueGetter).not.toHaveBeenCalled()
    expect(instance.workspace.readFile('/workspace/main.cpp')).toBe('old\n')
    expect(instance.workspace.revision).toBe(revision)
    expect(listener).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { createWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'

type PersistenceCall =
  | { kind: 'write'; projectId: string; path: string; text: string }
  | { kind: 'delete'; projectId: string; path: string }

function createOPFSHarness() {
  const projects = new Map<string, Map<string, string>>()
  const calls: PersistenceCall[] = []
  const writeBarriers: Promise<void>[] = []
  const project = (projectId: string) => {
    let files = projects.get(projectId)
    if (!files) {
      files = new Map()
      projects.set(projectId, files)
    }
    return files
  }
  const directory = (projectId: string, segments: readonly string[]) => ({
    kind: 'directory',
    async getDirectoryHandle(name: string) {
      return directory(projectId, [...segments, name])
    },
    async getFileHandle(name: string) {
      const path = `/workspace/${[...segments, name].join('/')}`
      return {
        kind: 'file',
        async createWritable() {
          let pending = ''
          return {
            async write(text: string) {
              pending = text
            },
            async close() {
              calls.push({ kind: 'write', projectId, path, text: pending })
              await writeBarriers.shift()
              project(projectId).set(path, pending)
            },
          }
        },
        async getFile() {
          const text = project(projectId).get(path)
          if (text === undefined) throw new Error(`missing fake OPFS file ${path}`)
          return { text: async () => text }
        },
      }
    },
    async removeEntry(name: string) {
      const path = `/workspace/${[...segments, name].join('/')}`
      calls.push({ kind: 'delete', projectId, path })
      project(projectId).delete(path)
    },
    async *entries(): AsyncGenerator<readonly [string, never]> {
      // Every test begins with an empty browser-local cache. The Map records
      // writes and deletes after bootstrap so ordering can be asserted exactly.
    },
  })
  const root = {
    async getDirectoryHandle(name: string) {
      if (name !== 'projects') throw new Error(`unexpected fake OPFS root ${name}`)
      return {
        async getDirectoryHandle(projectId: string) {
          project(projectId)
          return directory(projectId, [])
        },
      }
    },
  }
  return { projects, calls, writeBarriers, root }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const instances: WorkbenchInstance[] = []
let opfs = createOPFSHarness()

async function initialized(projectId: string): Promise<WorkbenchInstance> {
  const instance = createWorkbenchInstance()
  instances.push(instance)
  await instance.workspace.initialize({
    projectId,
    initialFiles: { '/workspace/main.cpp': 'initial\n' },
  })
  await instance.workspace.flushLocalPersistence()
  opfs.calls.length = 0
  return instance
}

function persisted(projectId: string): Record<string, string> {
  return Object.fromEntries(opfs.projects.get(projectId) ?? [])
}

beforeEach(() => {
  opfs = createOPFSHarness()
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn(async () => opfs.root) },
  })
})

afterEach(() => {
  for (const instance of instances.splice(0)) instance.workspace.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('instance-owned workspace browser-local persistence ordering', () => {
  it('cancels a pending local write before a newer delete persists', async () => {
    vi.useFakeTimers()
    const projectId = 'delete-ordering'
    const instance = await initialized(projectId)

    instance.workspace.writeLocal('/workspace/main.cpp', 'typed\n')
    instance.workspace.deleteLocal('/workspace/main.cpp')
    expect(instance.workspace.snapshot()).toEqual({})

    await vi.advanceTimersByTimeAsync(500)
    await instance.workspace.flushLocalPersistence()

    expect(persisted(projectId)).toEqual({})
    expect(opfs.calls).toEqual([
      { kind: 'delete', projectId, path: '/workspace/main.cpp' },
    ])
  })

  it('cancels a pending source write before a newer rename persists', async () => {
    vi.useFakeTimers()
    const projectId = 'rename-ordering'
    const instance = await initialized(projectId)

    instance.workspace.writeLocal('/workspace/main.cpp', 'typed\n')
    instance.workspace.renameLocal('/workspace/main.cpp', '/workspace/renamed.cpp')
    expect(instance.workspace.snapshot()).toEqual({ '/workspace/renamed.cpp': 'typed\n' })

    await vi.advanceTimersByTimeAsync(500)
    await instance.workspace.flushLocalPersistence()

    expect(persisted(projectId)).toEqual({ '/workspace/renamed.cpp': 'typed\n' })
    expect(opfs.calls).toEqual([
      { kind: 'delete', projectId, path: '/workspace/main.cpp' },
      { kind: 'write', projectId, path: '/workspace/renamed.cpp', text: 'typed\n' },
    ])
  })

  it('cancels pending local text before a newer authoritative multi-operation write', async () => {
    vi.useFakeTimers()
    const projectId = 'authoritative-ordering'
    const instance = await initialized(projectId)

    instance.workspace.writeLocal('/workspace/main.cpp', 'typed\n')
    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'authoritative-after-local',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-provider' },
      operations: [
        { op: 'write', path: '/workspace/main.cpp', text: 'authoritative\n' },
        { op: 'create', path: '/workspace/remote.h', text: '#pragma once\n' },
      ],
    })
    expect(instance.workspace.snapshot()).toEqual({
      '/workspace/main.cpp': 'authoritative\n',
      '/workspace/remote.h': '#pragma once\n',
    })

    await vi.advanceTimersByTimeAsync(500)
    await instance.workspace.flushLocalPersistence()

    expect(persisted(projectId)).toEqual(instance.workspace.snapshot())
    expect(opfs.calls).toHaveLength(2)
    expect(opfs.calls).toEqual(expect.arrayContaining([
      { kind: 'write', projectId, path: '/workspace/main.cpp', text: 'authoritative\n' },
      { kind: 'write', projectId, path: '/workspace/remote.h', text: '#pragma once\n' },
    ]))
  })

  it('serializes a fired local write before a newer authoritative transaction', async () => {
    vi.useFakeTimers()
    const projectId = 'in-flight-ordering'
    const instance = await initialized(projectId)
    const stalledLocalWrite = deferred()
    opfs.writeBarriers.push(stalledLocalWrite.promise)

    instance.workspace.writeLocal('/workspace/main.cpp', 'typed\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(opfs.calls).toEqual([
      { kind: 'write', projectId, path: '/workspace/main.cpp', text: 'typed\n' },
    ])

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'authoritative-after-fired-write',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-provider' },
      operations: [
        { op: 'write', path: '/workspace/main.cpp', text: 'authoritative\n' },
        { op: 'create', path: '/workspace/remote.h', text: '#pragma once\n' },
      ],
    })
    await Promise.resolve()
    // The authoritative write to the same path remains queued until the older
    // write settles; the independent header path does not have to wait.
    expect(opfs.calls.filter((call) => call.path === '/workspace/main.cpp')).toEqual([
      { kind: 'write', projectId, path: '/workspace/main.cpp', text: 'typed\n' },
    ])

    let flushed = false
    const flush = instance.workspace.flushLocalPersistence().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    stalledLocalWrite.resolve()
    await flush

    expect(persisted(projectId)).toEqual(instance.workspace.snapshot())
    expect(opfs.calls.filter((call) => call.path === '/workspace/main.cpp')).toEqual([
      { kind: 'write', projectId, path: '/workspace/main.cpp', text: 'typed\n' },
      { kind: 'write', projectId, path: '/workspace/main.cpp', text: 'authoritative\n' },
    ])
    expect(opfs.calls).toContainEqual(
      { kind: 'write', projectId, path: '/workspace/remote.h', text: '#pragma once\n' },
    )
  })
})

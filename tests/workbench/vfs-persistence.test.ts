import { describe, expect, it, beforeEach, vi } from 'vitest'

// Minimal in-memory fake of the parts of OPFS we use: getDirectoryHandle,
// getFileHandle, createWritable, removeEntry, entries(). Backs everything
// with plain Maps so a "reload" can be modeled by reusing the same root
// across two initVFS calls.
type FakeFile = { kind: 'file'; name: string; content: string }
type FakeDir = {
    kind: 'directory'
    name: string
    children: Map<string, FakeFile | FakeDir>
}

function makeDir(name: string): FakeDir {
    return { kind: 'directory', name, children: new Map() }
}

function wrapDir(d: FakeDir): FileSystemDirectoryHandle {
    return {
        kind: 'directory',
        name: d.name,
        async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
            const existing = d.children.get(name)
            if (existing && existing.kind === 'directory') return wrapDir(existing)
            if (existing) throw new Error('not a directory')
            if (!opts?.create) throw new Error('directory not found: ' + name)
            const created = makeDir(name)
            d.children.set(name, created)
            return wrapDir(created)
        },
        async getFileHandle(name: string, opts?: { create?: boolean }) {
            const existing = d.children.get(name)
            if (existing && existing.kind === 'file') return wrapFile(existing)
            if (existing) throw new Error('not a file')
            if (!opts?.create) throw new Error('file not found: ' + name)
            const created: FakeFile = { kind: 'file', name, content: '' }
            d.children.set(name, created)
            return wrapFile(created)
        },
        async removeEntry(name: string) { d.children.delete(name) },
        async *entries() {
            for (const [k, v] of d.children) {
                yield [k, v.kind === 'directory' ? wrapDir(v) : wrapFile(v)] as const
            }
        },
    } as unknown as FileSystemDirectoryHandle
}

function wrapFile(f: FakeFile): FileSystemFileHandle {
    return {
        kind: 'file',
        name: f.name,
        async getFile() {
            return { text: async () => f.content } as File
        },
        async createWritable() {
            return {
                async write(chunk: string) { f.content = chunk },
                async close() { },
            } as FileSystemWritableFileStream
        },
    } as unknown as FileSystemFileHandle
}

const opfsRoot = makeDir('/')

beforeEach(() => {
    opfsRoot.children.clear()
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => wrapDir(opfsRoot) } })
    vi.resetModules()
})

async function importVfs() {
    const volume = await import('../../src/vfs/volume')
    const sync = await import('../../src/vfs/opfs-sync')
    return { ...volume, ...sync }
}

describe('VFS persistence', () => {
    it('persists empty files created in the explorer through a reload', async () => {
        const { initVFS, createFile } = await importVfs()
        await initVFS({ projectId: 'test-empty-files' })

        createFile('/workspace/CandyShop.h', '')
        createFile('/workspace/CandyShop.cpp', '')

        // Let the queued OPFS syncs complete.
        await new Promise((r) => setTimeout(r, 50))

        // Simulate reload: re-import all modules so the memfs volume is
        // freshly empty, then re-init from the same OPFS project.
        vi.resetModules()
        const fresh = await importVfs()
        await fresh.initVFS({ projectId: 'test-empty-files' })

        expect(fresh.fileExists('/workspace/CandyShop.h')).toBe(true)
        expect(fresh.fileExists('/workspace/CandyShop.cpp')).toBe(true)
    })

    it('still persists files created with content (regression guard)', async () => {
        const { initVFS, createFile } = await importVfs()
        await initVFS({ projectId: 'test-with-content' })

        createFile('/workspace/main.cpp', 'int main() { return 0; }')
        await new Promise((r) => setTimeout(r, 50))

        vi.resetModules()
        const fresh = await importVfs()
        await fresh.initVFS({ projectId: 'test-with-content' })

        expect(fresh.readFile('/workspace/main.cpp')).toBe('int main() { return 0; }')
    })

    it('coalesces rapid writes into a single debounced OPFS sync', async () => {
        const { initVFS, createFile, writeFile } = await importVfs()
        await initVFS({ projectId: 'test-coalesce' })

        createFile('/workspace/notes.txt', '')
        // Let the immediate-sync from createFile resolve so the project dir exists.
        await new Promise((r) => setTimeout(r, 50))

        // Simulate fast keystrokes — multiple writes in <500ms should
        // collapse into one OPFS write of the latest content.
        writeFile('/workspace/notes.txt', 'a')
        writeFile('/workspace/notes.txt', 'ab')
        writeFile('/workspace/notes.txt', 'abc')

        const readOpfs = () => {
            const projects = opfsRoot.children.get('projects') as FakeDir | undefined
            const proj = projects?.children.get('test-coalesce') as FakeDir | undefined
            const f = proj?.children.get('notes.txt') as FakeFile | undefined
            return f?.content
        }

        // Before the debounce, OPFS still has the createFile state.
        expect(readOpfs()).toBe('')

        // After the debounce, the final value lands.
        await new Promise((r) => setTimeout(r, 700))
        expect(readOpfs()).toBe('abc')
    })

    it('drops queued writes when the project switches via initVFS', async () => {
        const { initVFS, createFile, writeFile } = await importVfs()
        await initVFS({ projectId: 'project-a' })
        createFile('/workspace/file.txt', '')
        await new Promise((r) => setTimeout(r, 50))
        writeFile('/workspace/file.txt', 'pending-in-a')

        // Switch projects before the debounce fires.
        await initVFS({ projectId: 'project-b' })
        await new Promise((r) => setTimeout(r, 700))

        // The queued write should have been cancelled — project-a's
        // file.txt is still empty (from createFile), not "pending-in-a".
        const projects = opfsRoot.children.get('projects') as FakeDir | undefined
        const a = projects?.children.get('project-a') as FakeDir | undefined
        const fA = a?.children.get('file.txt') as FakeFile | undefined
        expect(fA?.content).toBe('')
        // project-b shouldn't have leaked file.txt either.
        const b = projects?.children.get('project-b') as FakeDir | undefined
        expect(b?.children.get('file.txt')).toBeUndefined()
    })

    it('renames an unsynced file using the in-memory fallback content', async () => {
        const { initVFS, createFile, renameItem } = await importVfs()
        await initVFS({ projectId: 'test-rename' })

        createFile('/workspace/draft.cpp', '// hello')
        // Rename immediately, before the queued createFile sync has a chance
        // to write the original path — the rename path needs the in-memory
        // fallback to still produce a non-empty OPFS file.
        renameItem('/workspace/draft.cpp', '/workspace/final.cpp')
        await new Promise((r) => setTimeout(r, 50))

        vi.resetModules()
        const fresh = await importVfs()
        await fresh.initVFS({ projectId: 'test-rename' })

        expect(fresh.fileExists('/workspace/final.cpp')).toBe(true)
        expect(fresh.fileExists('/workspace/draft.cpp')).toBe(false)
        expect(fresh.readFile('/workspace/final.cpp')).toBe('// hello')
    })
})

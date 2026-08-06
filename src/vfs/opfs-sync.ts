// ── OPFS Sync ─────────────────────────────────────────────────────
import { writeFile, vol } from './volume'

async function getProjectDir(projectId: string): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle('projects', { create: true })
    return projects.getDirectoryHandle(projectId, { create: true })
}

export async function syncToOPFS(projectId: string, path: string, content: string) {
    if (!projectId) return  // ephemeral session (e.g. teacher review) — don't persist
    try {
        const projectDir = await getProjectDir(projectId)
        const parts = path.replace('/workspace/', '').split('/')
        let dir = projectDir
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i], { create: true })
        }
        const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
        const writable = await handle.createWritable()
        await writable.write(content)
        await writable.close()
    } catch (err) {
        console.warn('[OPFS] sync failed:', err)
    }
}

export async function deleteFromOPFS(projectId: string, path: string) {
    if (!projectId) return
    try {
        const projectDir = await getProjectDir(projectId)
        const parts = path.replace('/workspace/', '').split('/')
        let dir = projectDir
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i])
        }
        await dir.removeEntry(parts[parts.length - 1], { recursive: true })
    } catch (err) {
        console.warn('[OPFS] delete failed:', err)
    }
}

export async function renameInOPFS(projectId: string, oldPath: string, newPath: string, fallbackContent?: string) {
    if (!projectId) return
    // OPFS has no rename — read old, write new, delete old
    try {
        const projectDir = await getProjectDir(projectId)
        const oldParts = oldPath.replace('/workspace/', '').split('/')
        let content: string
        try {
            let dir = projectDir
            for (let i = 0; i < oldParts.length - 1; i++) {
                dir = await dir.getDirectoryHandle(oldParts[i])
            }
            const oldHandle = await dir.getFileHandle(oldParts[oldParts.length - 1])
            const file = await oldHandle.getFile()
            content = await file.text()
        } catch {
            // Old path not in OPFS (e.g. file was created but never synced).
            // Fall back to the in-memory content so rename still persists.
            if (fallbackContent === undefined) throw new Error('source missing in OPFS and no fallback content')
            content = fallbackContent
        }
        await syncToOPFS(projectId, newPath, content)
        await deleteFromOPFS(projectId, oldPath)
    } catch (err) {
        console.warn('[OPFS] rename failed:', err)
    }
}

export async function createFolderInOPFS(projectId: string, path: string) {
    if (!projectId) return
    try {
        const projectDir = await getProjectDir(projectId)
        const parts = path.replace('/workspace/', '').split('/').filter(Boolean)
        let dir = projectDir
        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create: true })
        }
    } catch (err) {
        console.warn('[OPFS] create folder failed:', err)
    }
}

export async function hydrateFromOPFS(
    projectId: string,
    isCurrent: () => boolean = () => true,
) {
    if (!projectId) return
    try {
        const projectDir = await getProjectDir(projectId)
        if (!isCurrent()) return
        await walk(projectDir, '/workspace', isCurrent)
    } catch (err) {
        console.warn('[OPFS] hydration failed:', err)
    }
}

async function walk(
    dir: FileSystemDirectoryHandle,
    base: string,
    isCurrent: () => boolean,
) {
    for await (const [name, handle] of (dir as any).entries()) { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!isCurrent()) return
        const path = `${base}/${name}`
        if (handle.kind === 'directory') {
            // Materialize the directory eagerly so empty folders survive reload;
            // writeFile below auto-creates non-empty ones.
            if (!vol.existsSync(path)) vol.mkdirSync(path, { recursive: true })
            await walk(handle as FileSystemDirectoryHandle, path, isCurrent)
        } else {
            const file = await (handle as FileSystemFileHandle).getFile()
            const content = await file.text()
            if (!isCurrent()) return
            writeFile(path, content)
        }
    }
}

// ── PCH OPFS Cache ────────────────────────────────────────────────

export async function savePchToOPFS(hash: string, buffer: ArrayBuffer) {
    try {
        const root = await navigator.storage.getDirectory()
        const cacheDir = await root.getDirectoryHandle('.compiler_cache', { create: true })

        // Clean up old PCH files to save space silently
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const name of (cacheDir as any).keys()) {
            if (name.endsWith('.pch') && name !== `nova_${hash}.pch`) {
                await cacheDir.removeEntry(name).catch(() => { })
            }
        }

        const handle = await cacheDir.getFileHandle(`nova_${hash}.pch`, { create: true })
        const writable = await handle.createWritable()
        await writable.write(buffer.slice(0))
        await writable.close()
    } catch (err) {
        console.warn('[OPFS] save PCH failed:', err)
    }
}

export async function loadPchFromOPFS(hash: string): Promise<ArrayBuffer | null> {
    try {
        const root = await navigator.storage.getDirectory()
        const cacheDir = await root.getDirectoryHandle('.compiler_cache')
        const handle = await cacheDir.getFileHandle(`nova_${hash}.pch`)
        const file = await handle.getFile()
        return await file.arrayBuffer()
    } catch {
        return null // Cache miss
    }
}

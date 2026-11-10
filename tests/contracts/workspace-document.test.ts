import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'
import { imageSha256, type WorkspaceDocumentV2, type WorkspaceAssetPort } from '../../src/assets'

const asset = { path: '/workspace/images/photo.png', blobId: 'blob-1', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png' as const }
const document: WorkspaceDocumentV2 = { schemaVersion: 2, files: [{ path: '/workspace/main.py', content: 'print(1)' }], assets: [asset] }
async function workspace() { const instance = createWorkbenchInstance(); await instance.workspace.initialize({ projectId: 'images', initialDocument: document, ephemeral: true }); return instance.workspace }

describe('atomic workspace document', () => {
  it('checks host limits before upload and preserves edits made while staging', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))
    const receipt = { ...asset, byteLength: png.length, sha256: await imageSha256(png) }
    let finish!: (ref: typeof receipt) => void
    const stage = vi.fn<WorkspaceAssetPort['stage']>(async () => new Promise((resolve) => { finish = resolve }))
    const port: WorkspaceAssetPort = { read: async () => png, stage, validateDocument: (doc) => { if (doc.files.length + doc.assets.length > 1) throw new Error('Host entry limit') } }
    const controller = createWorkbenchInstance().workspace
    const init = { projectId: 'import', initialDocument: { ...document, assets: [] }, ephemeral: true }
    await controller.initialize({ ...init, assets: port })
    await expect(controller.importAssetLocal(asset.path, png, 'image/png')).rejects.toThrow('Host entry limit')
    expect(stage).not.toHaveBeenCalled()
    await controller.initialize({ ...init, assets: { ...port, validateDocument: undefined } })
    const pending = controller.importAssetLocal(asset.path, png, 'image/png')
    controller.writeLocal('/workspace/main.py', 'latest edit')
    finish(receipt)
    await pending
    expect(controller.documentSnapshot()).toMatchObject({ files: [{ content: 'latest edit' }], assets: [receipt] })
    controller.dispose()
  })
  it('refuses to undo an image that is no longer authorized without changing source or revision', async () => {
    const controller = createWorkbenchInstance().workspace
    await controller.initialize({ projectId: 'undo', initialDocument: document, ephemeral: true, assets: { read: async () => { throw new Error('Image no longer available') }, stage: async () => { throw new Error('unused') } } })
    controller.deleteLocal(asset.path)
    const before = controller.documentSnapshot(), revision = controller.revision
    await expect(controller.restoreAssetsLocal({}, [asset])).rejects.toThrow('no longer available')
    expect(controller.documentSnapshot()).toEqual(before)
    expect(controller.revision).toBe(revision)
    controller.writeLocal('/workspace/main.py', 'source still saves')
    expect(controller.snapshot()['/workspace/main.py']).toBe('source still saves')
    controller.dispose()
  })
  it('keeps the existing V1 source path contract when notifying document observers', async () => {
    const controller = createWorkbenchInstance().workspace
    await controller.initialize({ projectId: 'legacy', initialFiles: {}, ephemeral: true })
    const observed: WorkspaceDocumentV2[] = []
    controller.subscribeDocument((change) => observed.push(change.document))
    controller.createFileLocal('/workspace/a\tb.py', 'text')
    expect(observed[0].files[0]).toEqual({ path: '/workspace/a\tb.py', content: 'text' })
    controller.dispose()
  })
  it('replaces asset authority without reseeding edits and rejects a late prior read', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))
    const initialDocument = { ...document, assets: [{ ...asset, byteLength: png.length, sha256: await imageSha256(png) }] }
    let resolve!: (bytes: Uint8Array) => void
    let signal: AbortSignal | undefined
    const previous: WorkspaceAssetPort = { read: async (_asset, requestedSignal) => { signal = requestedSignal; return new Promise((done) => { resolve = done }) }, stage: async () => { throw new Error('unused') } }
    const next: WorkspaceAssetPort = { ...previous, read: async () => png }
    const controller = createWorkbenchInstance().workspace
    const init = { projectId: 'images', initialDocument, ephemeral: true }
    await controller.initialize({ ...init, assets: previous })
    controller.writeLocal('/workspace/main.py', 'unsaved edit')
    const pending = controller.materializeAssets()
    await controller.initialize({ ...init, assets: next })
    expect(signal?.aborted).toBe(true)
    resolve(png)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(controller.readFile('/workspace/main.py')).toBe('unsaved edit')
    expect((await controller.materializeAssets())[asset.path]).toEqual(png)
    controller.dispose()
  })
  it('keeps source projection clean and shares one revision for source and asset changes', async () => {
    const controller = await workspace()
    const initial = controller.revision
    const seen: WorkspaceDocumentV2[] = []
    controller.subscribeDocument((change) => seen.push(change.document))
    expect(controller.snapshot()).toEqual({ '/workspace/main.py': 'print(1)' })
    expect(() => controller.readFile(asset.path)).toThrow('source text')
    controller.writeLocal('/workspace/main.py', 'print(2)')
    controller.renameLocal('/workspace/images', '/workspace/pictures')
    expect(controller.revision).toBe(initial + 2)
    expect(seen[0].assets).toEqual([asset])
    expect(seen[1].assets[0].path).toBe('/workspace/pictures/photo.png')
    controller.deleteLocal('/workspace/pictures')
    expect(controller.documentSnapshot().assets).toEqual([])
  })
  it('rejects stale atomic replacement, text downgrade and source/image collisions without changing either plane', async () => {
    const controller = await workspace()
    const before = controller.documentSnapshot()
    await expect(controller.applyDocument({ version: 2, expectedRevision: 0, transactionId: 'stale', origin: { kind: 'external-authority', source: 'test' }, document: { ...document, assets: [] } })).rejects.toMatchObject({ code: 'revision_mismatch' })
    expect(() => controller.replaceFromRestore({ '/workspace/main.py': 'oops' })).toThrow('applyDocument')
    expect(() => controller.createFileLocal(asset.path)).toThrow()
    expect(() => controller.createFileLocal('/workspace/images', 'collision')).toThrow()
    expect(controller.documentSnapshot()).toEqual(before)
    await controller.applyDocument({ version: 2, expectedRevision: controller.revision, transactionId: 'replace', origin: { kind: 'external-authority', source: 'test' }, document: { schemaVersion: 2, files: [{ path: '/workspace/new.py', content: 'new' }], assets: [] } })
    expect(controller.snapshot()).toEqual({ '/workspace/new.py': 'new' })
    expect(controller.documentSnapshot().assets).toEqual([])
  })
  it('keeps ordered immutable full documents when a subscriber applies another edit', async () => {
    const controller = await workspace()
    const texts: string[] = []
    controller.subscribe(() => { if (controller.readFile('/workspace/main.py') === 'first') controller.writeLocal('/workspace/main.py', 'second') })
    controller.subscribeDocument((change) => texts.push(change.document.files[0].content))
    controller.writeLocal('/workspace/main.py', 'first')
    expect(texts).toEqual(['first', 'second'])
  })
})

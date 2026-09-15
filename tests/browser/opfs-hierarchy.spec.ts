import { expect, test, type Page } from '@playwright/test'
import {
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

const PROJECT_ID = 'browser-opfs-hierarchy-v1'

type ProbeOperation =
  | { op: 'write'; path: string; text: string }
  | { op: 'create'; path: string; text: string }
  | { op: 'delete'; path: string }

interface BrowserWorkspaceProbe {
  handle(): {
    workspace: {
      snapshot(): Record<string, string>
      revision(): number
      apply(transaction: {
        version: 1
        kind: 'apply'
        transactionId: string
        expectedRevision: number
        origin: { kind: 'external-authority'; source: string }
        operations: ProbeOperation[]
      }): Promise<unknown>
    }
    persistence: { snapshot(): { state: string } }
  } | null
}

interface OPFSCloseGate {
  arm(): void
  waitStarted(): Promise<void>
  release(): void
}

type ProbeWindow = typeof window & {
  __webIDEWorkspaceProbe?: BrowserWorkspaceProbe
  __opfsCloseGate?: OPFSCloseGate
}

async function waitForProbe(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const scope = window as ProbeWindow
    return Boolean(scope.__webIDEWorkspaceProbe?.handle())
  })).toBe(true)
}

async function waitForLocalCache(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const scope = window as ProbeWindow
    return scope.__webIDEWorkspaceProbe?.handle()?.persistence.snapshot().state
  })).toBe('saved')
}

async function snapshot(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const handle = (window as ProbeWindow).__webIDEWorkspaceProbe?.handle()
    if (!handle) throw new Error('workspace probe is unavailable')
    return handle.workspace.snapshot()
  })
}

async function apply(page: Page, transactionId: string, operations: ProbeOperation[]): Promise<void> {
  await page.evaluate(async ({ id, operations: browserOperations }) => {
    const handle = (window as ProbeWindow).__webIDEWorkspaceProbe?.handle()
    if (!handle) throw new Error('workspace probe is unavailable')
    await handle.workspace.apply({
      version: 1,
      kind: 'apply',
      transactionId: id,
      expectedRevision: handle.workspace.revision(),
      origin: { kind: 'external-authority', source: 'browser-opfs-probe' },
      operations: browserOperations,
    })
  }, { id: transactionId, operations })
}

async function readOPFSFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async ({ projectId, workspacePath }) => {
    try {
      const root = await navigator.storage.getDirectory()
      const projects = await root.getDirectoryHandle('projects')
      const project = await projects.getDirectoryHandle(projectId)
      const parts = workspacePath.replace('/workspace/', '').split('/')
      let directory = project
      for (const part of parts.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(part)
      }
      const handle = await directory.getFileHandle(parts.at(-1)!)
      return await (await handle.getFile()).text()
    } catch {
      return null
    }
  }, { projectId: PROJECT_ID, workspacePath: path })
}

async function armNextOPFSClose(page: Page): Promise<void> {
  await page.evaluate(() => (window as ProbeWindow).__opfsCloseGate!.arm())
}

async function waitForBlockedOPFSClose(page: Page): Promise<void> {
  await page.evaluate(() => (window as ProbeWindow).__opfsCloseGate!.waitStarted())
}

async function releaseOPFSClose(page: Page): Promise<void> {
  await page.evaluate(() => (window as ProbeWindow).__opfsCloseGate!.release())
}

test('persists overlapping file-directory replacements through real OPFS in both directions', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const opfsWarnings: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[OPFS]')) {
      opfsWarnings.push(message.text())
    }
  })

  await page.addInitScript(() => {
    const scope = window as ProbeWindow
    const constructor = (globalThis as typeof globalThis & {
      FileSystemWritableFileStream: {
        prototype: { close(): Promise<void> }
      }
    }).FileSystemWritableFileStream
    const originalClose = constructor.prototype.close
    let armed = false
    let started: Promise<void> = Promise.resolve()
    let release: Promise<void> = Promise.resolve()
    let markStarted: () => void = () => undefined
    let permitClose: () => void = () => undefined

    scope.__opfsCloseGate = {
      arm() {
        armed = true
        started = new Promise<void>((resolve) => { markStarted = resolve })
        release = new Promise<void>((resolve) => { permitClose = resolve })
      },
      waitStarted: () => started,
      release: () => permitClose(),
    }
    constructor.prototype.close = function closeWithTestGate() {
      if (!armed) return originalClose.call(this)
      armed = false
      markStarted()
      return release.then(() => originalClose.call(this))
    }
  })

  const landing = await page.goto('/')
  await expectIsolatedRuntime(page, landing)
  await page.evaluate(async (projectId) => {
    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle('projects', { create: true })
    await projects.removeEntry(projectId, { recursive: true }).catch(() => undefined)
  }, PROJECT_ID)

  const navigation = await page.goto('/?runtime=cpp&workspace-probe=opfs-hierarchy')
  await expectIsolatedRuntime(page, navigation)
  await waitForProbe(page)
  await waitForLocalCache(page)
  await expect.poll(() => readOPFSFile(page, '/workspace/node/child.cpp')).toBe('initial child\n')

  // Replacing the last model stops its worker; let the lazy bootstrap finish first.
  await expect.poll(async () => (await Promise.all(page.workers().map(worker =>
    worker.evaluate(() => performance.getEntriesByName(
      'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs/assets/editor.worker-lj3bdIIn.js',
    ).some(entry => entry.entryType === 'resource')),
  ))).some(Boolean)).toBe(true)

  await armNextOPFSClose(page)
  await apply(page, 'browser-fired-child-write', [
    { op: 'write', path: '/workspace/node/child.cpp', text: 'fired child\n' },
  ])
  await waitForBlockedOPFSClose(page)
  await apply(page, 'browser-descendant-to-file', [
    { op: 'delete', path: '/workspace/node/child.cpp' },
    { op: 'create', path: '/workspace/node', text: 'authoritative file\n' },
    { op: 'create', path: '/workspace/unrelated-one.cpp', text: 'parallel one\n' },
  ])
  await expect.poll(() => readOPFSFile(page, '/workspace/unrelated-one.cpp')).toBe('parallel one\n')
  expect(await readOPFSFile(page, '/workspace/node')).not.toBe('authoritative file\n')
  await releaseOPFSClose(page)
  await waitForLocalCache(page)
  await expect.poll(() => readOPFSFile(page, '/workspace/node')).toBe('authoritative file\n')

  await page.reload()
  await waitForProbe(page)
  await waitForLocalCache(page)
  expect(await snapshot(page)).toEqual({
    '/workspace/node': 'authoritative file\n',
    '/workspace/unrelated-one.cpp': 'parallel one\n',
  })

  await armNextOPFSClose(page)
  await apply(page, 'browser-fired-parent-write', [
    { op: 'write', path: '/workspace/node', text: 'fired parent\n' },
  ])
  await waitForBlockedOPFSClose(page)
  await apply(page, 'browser-file-to-descendant', [
    { op: 'delete', path: '/workspace/node' },
    { op: 'create', path: '/workspace/node/child.cpp', text: 'authoritative child\n' },
    { op: 'create', path: '/workspace/unrelated-two.cpp', text: 'parallel two\n' },
  ])
  await expect.poll(() => readOPFSFile(page, '/workspace/unrelated-two.cpp')).toBe('parallel two\n')
  expect(await readOPFSFile(page, '/workspace/node/child.cpp')).not.toBe('authoritative child\n')
  await releaseOPFSClose(page)
  await waitForLocalCache(page)
  await expect.poll(() => readOPFSFile(page, '/workspace/node/child.cpp')).toBe('authoritative child\n')

  await page.reload()
  await waitForProbe(page)
  await waitForLocalCache(page)
  expect(await snapshot(page)).toEqual({
    '/workspace/node/child.cpp': 'authoritative child\n',
    '/workspace/unrelated-one.cpp': 'parallel one\n',
    '/workspace/unrelated-two.cpp': 'parallel two\n',
  })

  expect(opfsWarnings).toEqual([])
  expectCleanBrowser(diagnostics)
})

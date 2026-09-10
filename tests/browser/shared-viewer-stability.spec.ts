import { test, expect, type Page } from '@playwright/test'
import { observeBrowserDiagnostics, expectCleanBrowser, type BrowserDiagnostics } from './browser-test-helpers'
import type { WorkspaceOperationV1 } from '../../src/web-ide/contracts/workspace'

const diagnostics = new WeakMap<Page, BrowserDiagnostics>()
test.beforeEach(({ page }) => { diagnostics.set(page, observeBrowserDiagnostics(page)) })
test.afterEach(({ page }) => { expectCleanBrowser(diagnostics.get(page)!) })

async function frames(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function open(page: Page, path: string, instance = 0) {
    await page.evaluate(({ path, instance }) => window.viewer.handle(instance).ensureFilesOpen([path], path), { path, instance })
    await page.locator(`[data-instance="${instance}"]`).getByRole('tablist', { name: 'Open editors' }).getByRole('tab').filter({ hasText: path.split('/').at(-1) }).click()
    await frames(page)
}
async function measure(page: Page, instance = 0) { return page.evaluate(instance => window.viewer.measure(instance), instance) }
async function apply(page: Page, operations: WorkspaceOperationV1[], instance = 0) {
    await page.evaluate(({ operations, instance }) => {
        const handle = window.viewer.handle(instance)
        return handle.workspace.apply({ version: 1, kind: 'apply', transactionId: crypto.randomUUID(),
            expectedRevision: handle.workspace.revision(), origin: { kind: 'external-authority', source: 'acceptance' }, operations })
    }, { operations, instance })
    await frames(page)
}
async function prepare(page: Page, query = '') {
    await page.goto(`/${query}`)
    await page.waitForFunction(() => window.viewer?.counts.editorCreates > 0)
    await open(page, '/workspace/a.py')
    await page.evaluate(() => {
        const editor = window.viewer.editor()
        editor.setSelections([
            { selectionStartLineNumber: 509, selectionStartColumn: 135, positionLineNumber: 505, positionColumn: 90 },
            { selectionStartLineNumber: 515, selectionStartColumn: 15, positionLineNumber: 517, positionColumn: 40 },
        ])
        editor.focus()
        editor.setScrollPosition({ scrollTop: 11007, scrollLeft: 700 }, 1)
    })
    await frames(page)
}
function stable(before: Awaited<ReturnType<typeof measure>>, after: Awaited<ReturnType<typeof measure>>) {
    for (const key of ['editorId', 'modelId', 'domNodeId', 'domRemovals', 'editorCreates', 'editorDisposes', 'modelDisposes', 'flushes', 'active', 'scrollLeft', 'focus'] as const) expect(after[key], key).toEqual(before[key])
    expect(after.domConnected).toBe(true)
}

test('range edits preserve directional selections, viewport source and exact pixel remainder', async ({ page }) => {
    await prepare(page)
    const before = await measure(page)
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    const lines = files['/workspace/a.py'].split('\n')
    lines.splice(10, 0, ...Array.from({ length: 20 }, (_, i) => `# inserted ${i}`))
    lines[950] = '# below viewport changed'
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: lines.join('\n') }])
    const after = await measure(page)
    stable(before, after)
    expect(after.scrollTop).toBe(before.scrollTop + 440)
    expect(after.topSource).toBe(before.topSource)
    expect(after.selections).toEqual(before.selections!.map(selection => Object.fromEntries(Object.entries(selection).map(([key, value]) => [key, key.endsWith('LineNumber') ? Number(value) + 20 : value]))))
    expect(await page.evaluate(() => window.viewer.feed.filter(change => change.origin === 'local-user'))).toEqual([])
    expect(await page.evaluate(() => window.viewer.editEvents)).toEqual([])
    expect(after.renders).toBeGreaterThan(before.renders)
})

test('inactive views, actual rename and unrelated file mutations preserve browsing', async ({ page }) => {
    await prepare(page)
    const before = await measure(page)
    await open(page, '/workspace/b.py')
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: '# new\n' + files['/workspace/a.py'] }, { op: 'delete', path: '/workspace/c.py' }, { op: 'create', path: '/workspace/new.py', text: '# new file' }])
    await open(page, '/workspace/a.py')
    const returned = await measure(page)
    expect(returned.modelId).toBe(before.modelId)
    expect(returned.scrollTop).toBe(before.scrollTop + 22)
    expect(returned.scrollLeft).toBe(before.scrollLeft)
    expect(returned.topSource).toBe(before.topSource)
    await apply(page, [{ op: 'rename', from: '/workspace/a.py', to: '/workspace/renamed.py' }])
    const renamed = await measure(page)
    expect(renamed.active).toBe('/workspace/renamed.py')
    expect(renamed.scrollTop).toBe(returned.scrollTop)
    expect(renamed.selections).toEqual(returned.selections)
    // Renaming changes URI/model; snapshot delete/create does not assert identity.
    expect(renamed.modelId).not.toBe(returned.modelId)
    await apply(page, [{ op: 'delete', path: '/workspace/renamed.py' }])
    expect((await measure(page)).active).toBe('/workspace/b.py')
})

test('deleted selections clamp; CRLF, emoji, folding and wrapped anchors remain valid', async ({ page }) => {
    await prepare(page)
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    const lines = files['/workspace/a.py'].split('\n')
    lines.splice(502, 18)
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: lines.join('\n') }])
    const selections = (await measure(page)).selections!
    expect(selections[0].selectionStartLineNumber).toBe(503)
    expect(selections[0].positionLineNumber).toBe(503)
    const source = Array.from({ length: 100 }, (_, i) => `def f_${i}():\r\n    # 😀 ${'wide '.repeat(70)}\r\n    pass\r\n`).join('')
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: source }])
    await page.evaluate(async () => {
        const editor = window.viewer.editor()
        editor.updateOptions({ wordWrap: 'on' })
        editor.setPosition({ lineNumber: 1, column: 1 })
        await editor.getAction('editor.fold')!.run()
        editor.setScrollPosition({ scrollTop: 3307, scrollLeft: 0 }, 1)
    })
    await frames(page)
    const before = await measure(page)
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: '# inserted\r\n' + source }])
    const after = await measure(page)
    expect(after.topSource).toBe(before.topSource)
    expect(after.scrollTop).toBe(before.scrollTop + 22)
    expect(after.flushes).toBe(0)
})

test('undo keeps peer source and decorations follow surviving source', async ({ page }) => {
    await prepare(page, '?editable')
    await page.evaluate(() => {
        const editor = window.viewer.editor()
        editor.setPosition({ lineNumber: 900, column: 1 })
        editor.trigger('keyboard', 'type', { text: 'LOCAL' })
        editor.getModel()!.pushStackElement()
    })
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    const marker = await page.evaluate(() => window.viewer.editor().getModel()!.deltaDecorations([], [{ range: new window.monaco.Range(505, 2, 505, 10), options: { className: 'test-marker' } }])[0])
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: files['/workspace/a.py'] + '\n# REMOTE' }])
    await page.evaluate(() => window.viewer.editor().trigger('keyboard', 'undo', null))
    const source = await page.evaluate(() => window.viewer.editor().getModel()!.getValue())
    expect(source).not.toContain('LOCAL')
    expect(source.endsWith('# REMOTE')).toBe(true)
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: '# inserted\n' + source }])
    expect(await page.evaluate(marker => window.viewer.editor().getModel()!.getDecorationRange(marker)?.startLineNumber, marker)).toBe(506)
})

test('two same-path instances stay isolated through rapid full snapshots and cleanup', async ({ page }) => {
    await prepare(page, '?two')
    await page.waitForFunction(() => window.viewer.counts.editorCreates === 2)
    await open(page, '/workspace/a.py', 1)
    const before = await measure(page, 1)
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    for (let i = 0; i < 197; i++) files[`/workspace/file-${i}.py`] = '# additional'
    for (let i = 0; i < 15; i++) {
        files['/workspace/c.py'] += '# next\n'
        await apply(page, [{ op: 'replace', files }])
    }
    const after = await measure(page, 1)
    stable(before, after)
    expect(after.selections).toEqual(before.selections)
    expect(after.scrollTop).toBe(before.scrollTop)
    expect(await page.evaluate(() => Object.keys(window.viewer.handle(1).workspace.snapshot()).length)).toBe(3)
    expect(await page.evaluate(() => window.viewer.feed.filter(change => change.instance === 1 && change.origin === 'external-authority'))).toEqual([])
    await page.evaluate(() => window.viewer.handle(0).close())
    expect((await measure(page, 1)).modelId).toBe(before.modelId)
})

test('real native hidden and frozen recovery preserves browsing across skipped updates', async ({ playwright, baseURL }) => {
    const { runNativeLifecycle } = await import('../viewer/native-lifecycle.mjs')
    const result = await runNativeLifecycle({ url: baseURL!, executablePath: playwright.chromium.executablePath() })
    expect(result.initial).toBe('visible')
    expect(result.hidden).toBe('hidden')
    expect(result.frozen).toBe(true)
    expect(result.final).toBe('visible')
    expect(result.lifecycle).toEqual([
        { event: 'visibilitychange', state: 'hidden' }, { event: 'freeze', state: 'hidden' },
        { event: 'resume', state: 'hidden' }, { event: 'visibilitychange', state: 'visible' },
    ])
    stable(result.before, result.after)
    expect(result.after.topSource).toBe(result.before.topSource)
    expect(result.after.scrollTop).toBe(result.before.scrollTop + 440)
    expect(result.after.selections?.[0].startLineNumber).toBe(result.before.selections![0].startLineNumber + 20)
})

test('maximum Hamilton file and total-content bounds survive full reconnect snapshots', async ({ page }, testInfo) => {
    await prepare(page)
    const before = await measure(page)
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    files['/workspace/a.py'] += '\n#' + 'x'.repeat(262144 - files['/workspace/a.py'].length - 2)
    for (let i = 0; i < 197; i++) files[`/workspace/large-${i}.py`] = '#' + 'x'.repeat(6000)
    const total = Object.values(files).reduce((sum, text) => sum + text.length, 0)
    files['/workspace/large-0.py'] += 'x'.repeat(2097152 - total)
    expect(Math.max(...Object.values(files).map(text => text.length))).toBe(262144)
    await page.context().setOffline(true)
    await page.context().setOffline(false)
    const start = performance.now()
    await apply(page, [{ op: 'replace', files }])
    const elapsed = performance.now() - start
    const after = await measure(page)
    stable(before, after)
    expect(after.topSource).toBe(before.topSource)
    expect(after.selections).toEqual(before.selections)
    // Same-head/no-op and skipped remote revisions need no remount or model flush.
    await apply(page, [{ op: 'replace', files }])
    stable(after, await measure(page))
    await testInfo.attach('source-free-apply-cost', { body: JSON.stringify({ files: 200, contentBytes: 2097152, serializedBytes: JSON.stringify(files).length, applyMs: elapsed }), contentType: 'application/json' })
})

test('idle breakpoints track external source and can be toggled at their moved line', async ({ page }) => {
    await prepare(page)
    await page.evaluate(() => { const editor = window.viewer.editor(); editor.setPosition({ lineNumber: 505, column: 1 }); editor.focus() })
    await page.keyboard.press('F9')
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.breakpoints['/workspace/a.py'])).toEqual([505])
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: '# insert\n' + files['/workspace/a.py'] }])
    expect(await page.evaluate(() => window.viewer.handle().snapshot().debug.breakpoints['/workspace/a.py'])).toEqual([506])
    await page.evaluate(() => { const editor = window.viewer.editor(); editor.setPosition({ lineNumber: 506, column: 1 }); editor.focus() })
    await page.keyboard.press('F9')
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.breakpoints['/workspace/a.py'])).toEqual([])
})


test('explicit source navigation wins over cached browsing and is not replayed by incoming updates', async ({ page }) => {
    await prepare(page)
    await open(page, '/workspace/b.py')
    await page.getByRole('button', { name: 'Source navigation probe', exact: true }).click()
    await page.getByRole('button', { name: 'Reveal a.py line 25' }).click()
    await expect.poll(() => page.evaluate(() => window.viewer.editor().getPosition()?.lineNumber)).toBe(25)
    await page.waitForFunction(() => !window.viewer.editor().hasPendingScrollAnimation())
    const before = await measure(page)
    const files = await page.evaluate(() => window.viewer.handle().workspace.snapshot())
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: files['/workspace/a.py'] + '\n# below' }])
    stable(before, await measure(page))
    expect((await measure(page)).scrollTop).toBe(before.scrollTop)
})

test('real Python retains captured execution and uses mapped breakpoints on its next run', async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    const original = "value = 1\nvalue += 1\nprint('CAPTURED', value)\n"
    await apply(page, [{ op: 'replace', files: { '/workspace/main.py': original, '/workspace/other.py': '# other' } }])
    await page.evaluate(() => { const editor = window.viewer.editor(); editor.setPosition({ lineNumber: 2, column: 1 }); editor.focus() })
    await page.keyboard.press('F9')
    await page.locator('[data-command-id="workbench.debug"]').click()
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.debugMode), { timeout: 120_000 }).toBe('paused')
    expect(await page.evaluate(() => window.viewer.handle().snapshot().debug.currentLine)).toBe(2)
    await open(page, '/workspace/other.py')
    const before = await measure(page)
    const events = await page.evaluate(() => [...window.viewer.executionEvents])
    const latest = '# inserted\n' + original.replace('CAPTURED', 'LATEST')
    await apply(page, [{ op: 'write', path: '/workspace/main.py', text: latest }])
    stable(before, await measure(page))
    expect(await page.evaluate(() => window.viewer.executionEvents)).toEqual(events)
    expect(await page.evaluate(() => window.viewer.handle().snapshot().debug.currentLine)).toBe(2)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.viewer.output())).toContain('CAPTURED 2')
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.debugMode)).toBe('idle')
    expect(await page.evaluate(() => window.viewer.output())).not.toContain('LATEST')
    await open(page, '/workspace/main.py')
    await page.locator('[data-command-id="workbench.debug"]').click()
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.currentLine), { timeout: 120_000 }).toBe(3)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.viewer.output())).toContain('LATEST 2')
})


test('explicit breakpoint toggles after an external shift affect the captured run', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    const original = "value = 1\nvalue += 1\nvalue += 1\nvalue += 1\nprint('TOGGLE', value)\n"
    await apply(page, [{ op: 'replace', files: { '/workspace/main.py': original } }])
    const toggle = async (line: number) => {
        await page.evaluate(line => { const editor = window.viewer.editor(); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus() }, line)
        await page.keyboard.press('F9')
    }
    await toggle(2)
    await page.locator('[data-command-id="workbench.debug"]').click()
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.debugMode), { timeout: 120_000 }).toBe('paused')
    await apply(page, [{ op: 'write', path: '/workspace/main.py', text: '# shifted\n' + original }])
    await toggle(3)
    await toggle(5)
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.breakpoints['/workspace/main.py'])).toEqual([5])
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.viewer.handle().snapshot().debug.currentLine)).toBe(5)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.viewer.output())).toContain('TOGGLE 4')
})

test('an inactive edited model does not replay stale folding coordinates', async ({ page }) => {
    await prepare(page)
    const source = '# top\n'.repeat(99) + 'def folded():\n' + '    value = 1\n'.repeat(20) + '# end\n'.repeat(40)
    await apply(page, [{ op: 'replace', files: { '/workspace/a.py': source, '/workspace/b.py': '# other' } }])
    await page.evaluate(async () => { const editor = window.viewer.editor(); editor.setPosition({ lineNumber: 100, column: 1 }); await editor.getAction('editor.fold')?.run() })
    await open(page, '/workspace/b.py')
    await apply(page, [{ op: 'write', path: '/workspace/a.py', text: '# inserted\n'.repeat(20) + source }])
    await open(page, '/workspace/a.py')
    expect(await page.evaluate(() => window.viewer.editor().getTopForLineNumber(110) - window.viewer.editor().getTopForLineNumber(105))).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.viewer.editor().getModel()?.getLineContent(120))).toBe('def folded():')
})

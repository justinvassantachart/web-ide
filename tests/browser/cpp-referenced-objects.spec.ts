import { readFileSync } from 'node:fs'
import { expect, test, type Locator } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

const source = readFileSync(new URL('./fixtures/cpp-referenced-objects.cpp', import.meta.url), 'utf8')
const linkedLine = source.split('\n').findIndex(line => line.includes('// GRAPH_LINKED')) + 1
const cycleLine = source.split('\n').findIndex(line => line.includes('// GRAPH_CYCLE')) + 1

test('keeps observed C++ objects and pointer edges separate through expansion and new pauses', async ({ page }, testInfo) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.setViewportSize({ width: 1700, height: 1100 })
  await expectIsolatedRuntime(page, await page.goto('/?runtime=cpp&cppReferenceGraph=1'))
  const status = page.getByRole('contentinfo', { name: 'Status bar' })
  await expect(status).toContainText('Ready')
  await editorLine(page, 'phase += 1; // GRAPH_LINKED').click()
  await page.keyboard.press('F9')
  await expect(page.locator('.monaco-editor .breakpoint-dot')).toHaveCount(1)

  const debug = page.locator('[data-command-id="workbench.debug"]')
  await debug.click()
  await expect(status).toContainText(`Paused at main.cpp:${linkedLine}`)
  await page.getByRole('tab', { name: 'Graph', exact: true }).click()
  const cards = page.locator('.react-flow__node-heapNode')
  const stack = page.locator('.react-flow__node-stackFrame')
  await expect(stack).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('linked-list-initial.png'), fullPage: true })
  await testInfo.attach('initial-graph-semantics', {
    body: JSON.stringify(await page.locator('.react-flow__node, .react-flow__edge').evaluateAll(elements =>
      elements.map(element => ({ id: element.getAttribute('data-id'), text: element.textContent }))), null, 2),
    contentType: 'application/json',
  })
  // This is the original regression: the real debugger captured pointer
  // children, but Graph received no separate referenced objects at all.
  await expect(cards).toHaveCount(3, { timeout: 15_000 })

  async function pointer(row: Locator) {
    const button = row.locator(':scope > button')
    const value = await button.locator('span').last().getAttribute('title')
    expect(value).toMatch(/^0x[\da-f]+$/i)
    const address = Number(value)
    const storage = await button.getAttribute('title')
    expect(storage).toMatch(/^Address 0x[\da-f]+$/i)
    expect(Number(storage!.slice('Address '.length))).not.toBe(address)
    const handle = row.locator(':scope > button > .react-flow__handle.source')
    await expect(handle).toHaveCount(1)
    return {
      address,
      node: await handle.getAttribute('data-nodeid'),
      handle: await handle.getAttribute('data-handleid'),
    }
  }

  async function verifyGraph(cyclic = false) {
    await expect(cards).toHaveCount(3)
    const head = await pointer(stack.getByRole('treeitem', { name: 'head', exact: true }))
    const alias = await pointer(stack.getByRole('treeitem', { name: 'alias', exact: true }))
    const object = (address: number) => page.getByTestId(`rf__node-object-${address}`)
    const first = object(head.address)
    await expect(first.getByRole('treeitem', { name: 'value', exact: true })).toContainText('10')
    const firstNext = await pointer(first.getByRole('treeitem', { name: 'next', exact: true }))
    expect(alias.address).toBe(firstNext.address)
    const second = object(firstNext.address)
    await expect(second.getByRole('treeitem', { name: 'value', exact: true })).toContainText('20')
    const secondNext = await pointer(second.getByRole('treeitem', { name: 'next', exact: true }))
    const third = object(secondNext.address)
    await expect(third.getByRole('treeitem', { name: 'value', exact: true })).toContainText('30')
    expect(new Set([head.address, firstNext.address, secondNext.address]).size).toBe(3)
    const sources = [head, alias, firstNext, secondNext]
    const lastNext = third.getByRole('treeitem', { name: 'next', exact: true })
    if (cyclic) {
      const back = await pointer(lastNext)
      expect(back.address).toBe(head.address)
      sources.push(back)
    } else {
      await expect(lastNext.locator(':scope > button > .react-flow__handle.source')).toHaveCount(0)
    }
    const empty = stack.getByRole('treeitem', { name: 'empty', exact: true })
    await expect(empty.locator(':scope > button > .react-flow__handle.source')).toHaveCount(0)
    const expected = sources.map(source => `${source.node}/${source.handle}->object-${source.address}/target`).sort()
    await expect.poll(() => page.locator('.react-flow__edge').evaluateAll(edges =>
      edges.map(edge => edge.getAttribute('data-id')).sort())).toEqual(expected)
    for (const target of [first, second, third]) {
      await expect(target.locator('.react-flow__handle.target[data-handleid="target"]')).toHaveCount(1)
    }
    return expected
  }

  for (const mode of ['Pretty', 'Raw']) {
    await page.getByRole('group', { name: 'Debugger display' }).getByRole('button', { name: mode, exact: true }).click()
    const before = await verifyGraph()
    const head = await pointer(stack.getByRole('treeitem', { name: 'head', exact: true }))
    // Variables and Graph share the actual bounded presentation/expansion path.
    // Reopening a pointer must reuse observed objects and never multiply cards.
    await page.getByRole('tab', { name: 'Variables', exact: true }).click()
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.getByRole('button', { name: 'Expand head', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Collapse head', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Collapse head', exact: true }).click()
    }
    // The 101st array element is outside the initial 100-value native page.
    // Loading it exercises a real lazy debugger revision that must retain the
    // same three observed targets, including the newly captured alias to head.
    await page.getByRole('button', { name: 'Expand delayed', exact: true }).click()
    const delayed = page.getByRole('treeitem', { name: 'delayed', exact: true })
    await delayed.getByRole('button', { name: 'Load more values', exact: true }).click()
    const last = delayed.getByRole('treeitem', { name: '[100]', exact: true })
    await expect(last).toBeVisible()
    expect(Number(await last.locator(':scope > button span').last().getAttribute('title'))).toBe(head.address)
    await page.getByRole('button', { name: 'Collapse delayed', exact: true }).click()
    await page.getByRole('tab', { name: 'Graph', exact: true }).click()
    expect(await verifyGraph()).toEqual(before)
    await page.getByRole('button', { name: 'Fit', exact: true }).click()
    // Wait only for screenshot framing; graph correctness above uses identities.
    await page.locator('.react-flow__viewport').evaluate(viewport => new Promise<void>(resolve => {
      let previous = ''
      let stableFrames = 0
      const settled = () => {
        const transform = getComputedStyle(viewport).transform
        stableFrames = transform === previous ? stableFrames + 1 : 0
        previous = transform
        if (stableFrames >= 3) resolve()
        else requestAnimationFrame(settled)
      }
      requestAnimationFrame(settled)
    }))
    await page.screenshot({ path: testInfo.outputPath(`linked-list-${mode.toLowerCase()}.png`), fullPage: true })
  }

  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(status).toContainText(`Paused at main.cpp:${linkedLine + 1}`)
  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(status).toContainText(`Paused at main.cpp:${cycleLine}`)
  await verifyGraph(true)
  await page.locator('[data-command-id="workbench.stop"]').click()
  await expect(status).toContainText('Ready')
  await expect(cards).toHaveCount(0)
  await debug.click()
  await expect(status).toContainText(`Paused at main.cpp:${linkedLine}`)
  await verifyGraph()
  await page.locator('[data-command-id="workbench.stop"]').click()
  await expect(status).toContainText('Ready')
  await expect(cards).toHaveCount(0)
  expectCleanBrowser(diagnostics)
})

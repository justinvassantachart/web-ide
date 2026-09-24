import { expect, test } from '@playwright/test'
import {
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

test('places the terminal beneath the editor and preserves output through panel controls', async ({ page }, testInfo) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expectIsolatedRuntime(page, await page.goto('/'))
  const status = page.getByRole('contentinfo', { name: 'Status bar' })
  await expect(status).toContainText('Ready')
  const terminal = page.getByRole('region', { name: 'Terminal panel', exact: true })
  const editor = page.locator('[data-web-ide-region="editor-content"]')
  const right = page.locator('[data-web-ide-region="panel-column"]')
  const editorBox = await editor.boundingBox()
  const terminalBox = await terminal.boundingBox()
  const rightBox = await right.boundingBox()
  expect(editorBox).not.toBeNull()
  expect(terminalBox).not.toBeNull()
  expect(rightBox).not.toBeNull()
  expect(terminalBox!.x).toBeCloseTo(editorBox!.x, 0)
  expect(terminalBox!.width).toBeCloseTo(editorBox!.width, 0)
  expect(terminalBox!.y).toBeGreaterThanOrEqual(editorBox!.y + editorBox!.height)
  expect(rightBox!.height).toBeGreaterThan(editorBox!.height)
  expect(rightBox!.x).toBeGreaterThanOrEqual(terminalBox!.x + terminalBox!.width)

  await page.locator('[data-command-id="workbench.run"]').click()
  const output = terminal.locator('.xterm-rows')
  await expect(output).toContainText('Double 5 is 10')
  await expect(output).toContainText('Program exited with code 0')
  await expect(status).toContainText('Ready')

  const separator = page.getByRole('separator', { name: 'Resize terminal panel' })
  await separator.focus()
  const beforeResize = await separator.getAttribute('aria-valuenow')
  await page.keyboard.press('ArrowUp')
  await expect(separator).not.toHaveAttribute('aria-valuenow', beforeResize!)
  const resizedHeight = (await terminal.boundingBox())!.height

  await terminal.getByRole('button', { name: 'Maximize terminal panel' }).click()
  await expect(terminal.getByRole('button', { name: 'Restore terminal panel' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: /Editor content/ })).toHaveCount(0)
  await expect(output).toContainText('Double 5 is 10')
  await terminal.getByRole('button', { name: 'Restore terminal panel' }).click()
  await expect.poll(async () => (await terminal.boundingBox())!.height).toBeCloseTo(resizedHeight, 0)

  await terminal.getByRole('button', { name: 'Hide terminal panel' }).click()
  await expect(terminal).toHaveCount(0)
  await page.getByRole('button', { name: 'Show terminal panel' }).click()
  await expect(output).toContainText('Double 5 is 10')
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()

  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(output).toContainText('Double 5 is 10')
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(output).toContainText('Double 5 is 10')

  // Retain the two requested visual references as release review artifacts.
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.getByRole('menuitemradio', { name: `${theme} (Modern)` }).click()
    await expect(output).toContainText('Double 5 is 10')
    await terminal.screenshot({ path: testInfo.outputPath(`terminal-${theme}.png`) })
    await page.screenshot({ path: testInfo.outputPath(`workbench-${theme}.png`) })
  }

  await terminal.getByRole('button', { name: 'Clear terminal' }).click()
  await expect(output).not.toContainText('Double 5 is 10')
  expectCleanBrowser(diagnostics)
})

test('terminal shortcut and visibility belong to the focused workbench', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await expectIsolatedRuntime(page, await page.goto('/?layout=multiple'))
  const first = page.getByRole('region', { name: 'First workbench', exact: true })
  const second = page.getByRole('region', { name: 'Second workbench', exact: true })
  const firstTerminal = first.getByRole('region', { name: 'Terminal panel', exact: true })
  const secondTerminal = second.getByRole('region', { name: 'Terminal panel', exact: true })
  await first.getByRole('textbox', { name: 'Terminal input' }).focus()
  await page.keyboard.press('Control+Backquote')
  await expect(firstTerminal).toHaveCount(0)
  await expect(secondTerminal).toBeVisible()
  await page.keyboard.press('Control+Backquote')
  await expect(firstTerminal).toBeVisible()
  await expect(first.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()
  await expect(secondTerminal).toBeVisible()
  expectCleanBrowser(diagnostics)
})


test('keyboard collapse moves focus out of hidden terminal and editor panels', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await expectIsolatedRuntime(page, await page.goto('/'))
  await expect(page.locator('footer[aria-label="Status bar"]')).toContainText('Ready')
  const separator = page.getByRole('separator', { name: 'Resize terminal panel' })
  const terminal = page.getByRole('region', { name: 'Terminal panel', exact: true })
  const editor = page.getByRole('textbox', { name: /Editor content/ })
  await expect(editor).toBeAttached()

  await separator.focus()
  await page.keyboard.press('End')
  await expect(terminal).toHaveCount(0)
  await expect(editor).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await page.locator('[data-web-ide-region="terminal-content"]').evaluate(
    element => element.contains(document.activeElement),
  )).toBe(false)

  await page.getByRole('button', { name: 'Show terminal panel' }).click()
  await separator.focus()
  await page.keyboard.press('Home')
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await page.locator('[data-web-ide-region="editor-content"]').evaluate(
    element => element.contains(document.activeElement),
  )).toBe(false)
  expectCleanBrowser(diagnostics)
})

test('narrow terminal headers keep the tab separate from its controls', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.setViewportSize({ width: 480, height: 640 })
  await expectIsolatedRuntime(page, await page.goto('/?layout=custom'))
  await expect(page.locator('footer[aria-label="Status bar"]')).toContainText('Ready')
  const terminal = page.getByRole('region', { name: 'Terminal panel', exact: true })
  const tab = await terminal.getByRole('tab', { name: 'Terminal', exact: true }).boundingBox()
  const clear = await terminal.getByRole('button', { name: 'Clear terminal' }).boundingBox()
  expect(tab).not.toBeNull()
  expect(clear).not.toBeNull()
  expect(tab!.x + tab!.width).toBeLessThanOrEqual(clear!.x)
  await terminal.getByRole('button', { name: 'Hide terminal panel' }).click()
  await expect(page.getByRole('button', { name: 'Show terminal panel' })).toBeVisible()
  expectCleanBrowser(diagnostics)
})

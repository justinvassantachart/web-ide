import { expect, test } from '@playwright/test'
import { expectIsolatedRuntime } from './browser-test-helpers'

for (const theme of ['light', 'dark'] as const) {
  test(`image preview is centered and readable in the ${theme} workbench`, async ({ page }) => {
    await page.goto('/?workspace-probe=images')
    await expect(page.locator('.monaco-editor')).toBeVisible()
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.getByRole('menuitemradio', { name: theme === 'light' ? 'Light (Modern)' : 'Dark (Modern)', exact: true }).click()
    await expect(page.locator('.web-ide-root')).toHaveAttribute('data-theme', theme)
    const png = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(2, 2)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#f00'; context.fillRect(0, 0, 2, 2)
      return Array.from(new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()))
    })
    await page.locator('input[type=file]').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(png) })
    await page.getByRole('treeitem', { name: 'preview.png', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Image preview: preview.png' })
    await expect(dialog).toBeVisible()
    const appearance = await dialog.evaluate((element) => {
      const luminance = (color: string) => {
        const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const unit = value / 255
          return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
        })
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
      }
      const style = getComputedStyle(element)
      const background = luminance(style.backgroundColor)
      const contrast = (color: string) => {
        const text = luminance(color)
        return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
      }
      const bounds = element.getBoundingClientRect()
      return {
        textContrast: contrast(style.color),
        linkContrast: contrast(getComputedStyle(element.querySelector('a')!).color),
        offsetX: Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2),
        offsetY: Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2),
      }
    })
    expect(appearance.textContrast).toBeGreaterThanOrEqual(4.5)
    expect(appearance.linkContrast).toBeGreaterThanOrEqual(4.5)
    expect(appearance.offsetX).toBeLessThanOrEqual(2)
    expect(appearance.offsetY).toBeLessThanOrEqual(2)
    await dialog.getByRole('button', { name: 'Close image preview' }).focus()
    await expect(dialog.getByRole('button', { name: 'Close image preview' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}

test('imports, previews, renames, restores, saves and runs exact image bytes without a text model', async ({ page }) => {
  const navigation = await page.goto('/?workspace-probe=images')
  await expectIsolatedRuntime(page, navigation)
  await expect(page.locator('.monaco-editor')).toBeVisible()
  const png = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(2, 2)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f00'; context.fillRect(0, 0, 2, 2)
    return Array.from(new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()))
  })
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  const item = page.getByRole('treeitem', { name: 'photo.png', exact: true })
  await expect(item).toBeVisible()
  await item.click()
  const dialog = page.getByRole('dialog', { name: 'Image preview: photo.png' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2)
  await expect(page.getByRole('tab', { name: /photo.png/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close image preview' }).click()
  await page.evaluate(async () => {
    const handle = (window as unknown as { __webIDEWorkspaceProbe: { handle(): import('web-ide').WebIDEInstanceHandle } }).__webIDEWorkspaceProbe.handle()
    const document = handle.workspace.documentSnapshot()
    await handle.workspace.applyLocalDocument({ version: 2, transactionId: 'fixture-rename', expectedRevision: handle.workspace.revision(), origin: { kind: 'local-user', source: 'fixture' }, document: { ...document, assets: document.assets.map((asset) => ({ ...asset, path: '/workspace/renamed.png' })) } })
  })
  const renamed = page.getByRole('treeitem', { name: 'renamed.png', exact: true })
  await expect(renamed).toBeVisible()
  await renamed.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Delete/ }).click()
  await expect(renamed).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(renamed).toBeVisible()
  await page.evaluate(async () => {
    const handle = (window as unknown as { __webIDEWorkspaceProbe: { handle(): import('web-ide').WebIDEInstanceHandle } }).__webIDEWorkspaceProbe.handle()
    const document = handle.workspace.documentSnapshot()
    await handle.workspace.applyLocalDocument({ version: 2, transactionId: 'fixture-restore-name', expectedRevision: handle.workspace.revision(), origin: { kind: 'local-user', source: 'fixture' }, document: { ...document, assets: document.assets.map((asset) => ({ ...asset, path: '/workspace/photo.png' })) } })
    await handle.flushWorkspace()
  })
  const saved = await page.evaluate(() => (window as typeof window & { __imageWorkspaceSaved?: { files: { path: string }[]; assets: { path: string; byteLength: number }[] } }).__imageWorkspaceSaved)
  expect(saved?.files.map((file) => file.path)).toEqual(['/workspace/main.py'])
  expect(saved?.assets).toMatchObject([{ path: '/workspace/photo.png', byteLength: png.length }])
  await page.locator('[data-command-id="workbench.run"]').click()
  await expect(page.locator('.xterm-rows')).toContainText(`PNG bytes loaded: ${png.length}`)
  await expect(page.locator('.xterm-rows')).toContainText('Program exited with code 0')
  await page.locator('[data-command-id="workbench.debug"]').click()
  await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toContainText('Paused at main.py:1')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('.xterm-rows')).toContainText(`PNG bytes loaded: ${png.length}`)
  await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toContainText('Ready')
})

import { expect, test } from '@playwright/test'
import {
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

test('runs an execution-only resource without exposing it in the workspace', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?resources=execution-only&lifecycle=probe')

  await expectIsolatedRuntime(page, navigation)

  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const terminal = page.locator('.xterm-rows')
  const runCommand = page.locator('[data-command-id="workbench.run"]')

  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(statusBar).toContainText('Ready')
  await expect(page.getByRole('treeitem', { name: 'main.py', exact: true })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'protected_support.py', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'protected_support.py' })).toHaveCount(0)

  await runCommand.click()
  await expect(terminal).toContainText('Execution-only resource loaded')
  await expect(terminal).toContainText('Program exited with code 0')
  await expect(statusBar).toContainText('Ready')

  await expect(page.getByRole('treeitem', { name: 'protected_support.py', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'protected_support.py' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Inspect persisted files' }).click()
  await expect(page.getByRole('status')).toContainText('Persisted: /workspace/main.py')
  await expect(page.getByRole('status')).toContainText('execution-only absent: true')

  await page.getByRole('button', { name: 'Save and close workspace' }).click()
  await expect(page.getByRole('status')).toContainText('save:r1:change:/workspace/main.py')
  await expect(page.getByRole('status')).toContainText('save:r2:flush:/workspace/main.py')
  await expect(page.getByRole('status')).toContainText('→ flush → dispose')
  expectCleanBrowser(diagnostics)
})

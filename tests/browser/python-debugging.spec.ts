import { expect, test } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

test('debugs Python with production assets and clean browser diagnostics', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/')

  await expectIsolatedRuntime(page, navigation)

  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const debugCommand = page.locator('[data-command-id="workbench.debug"]')

  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(statusBar).toContainText('Ready')
  await expect(debugCommand).toBeVisible()
  await expect(debugCommand).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Variables', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Graph', exact: true })).toHaveCount(0)

  await page.getByRole('treeitem', { name: 'main.py', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'main.py' })).toHaveAttribute('aria-selected', 'true')
  const seedLine = editorLine(page, 'seed = 5')
  await expect(seedLine).toHaveCount(1)
  await seedLine.click()
  await page.keyboard.press('F9')
  await expect(page.locator('.monaco-editor .breakpoint-dot')).toHaveCount(1)

  await debugCommand.click()
  await expect(statusBar).toContainText('Paused at main.py:3')
  await expect(page.getByRole('toolbar', { name: 'Debug controls' })).toBeVisible()
  await expect(page.getByText('Call Stack', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.py:4')
  const locals = page.getByText('Locals', { exact: true }).locator('..')
  await expect(locals).toContainText('seed')
  await expect(locals).toContainText('5')

  await page.getByRole('button', { name: 'Step Into', exact: true }).click()
  await expect(statusBar).toContainText('Paused at helpers.py:2')
  await expect(page.getByRole('tab', { name: 'helpers.py' })).toHaveAttribute('aria-selected', 'true')
  await expect(locals).toContainText('value')
  await expect(locals).toContainText('5')

  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(statusBar).toContainText('Paused at helpers.py:3')
  await expect(locals).toContainText('result')
  await expect(locals).toContainText('10')

  await page.getByRole('button', { name: 'Step Out', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.py:5')
  await expect(page.getByRole('tab', { name: 'main.py' })).toHaveAttribute('aria-selected', 'true')
  await expect(locals).toContainText('answer')
  await expect(locals).toContainText('10')

  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(statusBar).toContainText('Ready')
  await expect(page.locator('.xterm-rows')).toContainText('Double 5 is 10')
  await expect(page.locator('.xterm-rows')).toContainText('Program exited with code 0')
  await expect(page.getByRole('toolbar', { name: 'Debug controls' })).toHaveCount(0)

  // Reuse the same adapter for another debug session, then stop it while
  // paused. This catches stale event/session cleanup regressions in the real
  // worker rather than only in the fake lifecycle suite.
  await debugCommand.click()
  await expect(statusBar).toContainText('Paused at main.py:3')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(statusBar).toContainText('Ready')
  await expect(page.getByRole('toolbar', { name: 'Debug controls' })).toHaveCount(0)

  const testCommand = page.locator('[data-command-id="workbench.test"]')
  await expect(testCommand).toBeVisible()
  await testCommand.click()
  await expect(statusBar).toContainText('Ready')
  await expect(page.getByText('1 passed', { exact: true })).toBeVisible()
  await expect(page.getByText(/test_double/)).toBeVisible()
  await expect(page.locator('.xterm-rows')).not.toContainText('###WEB_IDE_UNITTEST###')

  // Test providers stage an ephemeral file plan. That plan must not erase the
  // durable main.py breakpoint still shown in the editor.
  await debugCommand.click()
  await expect(statusBar).toContainText('Paused at main.py:3')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(statusBar).toContainText('Ready')

  expectCleanBrowser(diagnostics)
})

test('maps unittest failures in staged main.py back to the host workspace', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?tests=failing&source=probe')

  await expectIsolatedRuntime(page, navigation)

  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const testCommand = page.locator('[data-command-id="workbench.test"]')
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(statusBar).toContainText('Ready')

  await testCommand.click()
  await expect(statusBar).toContainText('Ready')
  await expect(page.getByText('1 failed', { exact: true })).toBeVisible()
  await expect(page.getByText(/^test_failure_location \(/)).toBeVisible()
  const location = page.getByRole('button', { name: 'main.py:8', exact: true })
  await expect(location).toBeVisible()
  await expect(page.getByText(/__web_ide_user_main__/)).toHaveCount(0)

  await location.click()
  await expect(page.getByRole('tab', { name: 'main.py' })).toHaveAttribute('aria-selected', 'true')
  await expect(statusBar).toContainText('Ln 8, Col 1')
  await expect(page.locator('.monaco-editor .source-presentation-error-line')).toHaveCount(1)

  // The activity and Tests panel own independent source presentations.
  await page.getByRole('button', { name: 'Execution and source', exact: true }).click()
  const probe = page.getByRole('region', { name: 'Execution and source probe' })
  await probe.getByRole('button', { name: 'Present historical main line' }).click()
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(1)
  await expect(page.locator('.monaco-editor .source-presentation-error-line')).toHaveCount(1)
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(0)
  await expect(page.locator('.monaco-editor .source-presentation-error-line')).toHaveCount(1)
  await page.getByRole('button', { name: 'Variables', exact: true }).click()
  await expect(page.locator('.monaco-editor .source-presentation-error-line')).toHaveCount(0)
  expectCleanBrowser(diagnostics)
})

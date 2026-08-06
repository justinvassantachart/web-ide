import { expect, test } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

test('runs and debugs C++ with the production runtime', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?runtime=cpp')

  await expectIsolatedRuntime(page, navigation)

  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const terminal = page.locator('.xterm-rows')
  const runCommand = page.locator('[data-command-id="workbench.run"]')
  const debugCommand = page.locator('[data-command-id="workbench.debug"]')

  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(statusBar).toContainText('Ready')
  await expect(runCommand).toBeVisible()
  await expect(debugCommand).toBeVisible()
  await expect(page.getByRole('button', { name: 'Variables', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Graph', exact: true })).toBeVisible()

  await runCommand.click()
  await expect(terminal).toContainText('Double 5 is 10')
  await expect(terminal).toContainText('Program exited with code 0')
  await expect(statusBar).toContainText('Ready')

  const seedLine = editorLine(page, 'int seed = 5;')
  await expect(seedLine).toHaveCount(1)
  await seedLine.click()
  await page.keyboard.press('F9')
  await expect(page.locator('.monaco-editor .breakpoint-dot')).toHaveCount(1)

  await debugCommand.click()
  await expect(statusBar).toContainText('Paused at main.cpp:9')
  await expect(page.getByRole('toolbar', { name: 'Debug controls' })).toBeVisible()

  // debugger-sh 0.3.15 cannot remove native breakpoints from a live C++
  // session. Web IDE must reject the edit and restore the authoritative dot.
  await seedLine.click()
  await page.keyboard.press('F9')
  await expect(terminal).toContainText('Stop the current debug session before changing breakpoints')
  await expect(page.locator('.monaco-editor .breakpoint-dot')).toHaveCount(1)

  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.cpp:10')
  const locals = page.getByText('Locals', { exact: true }).locator('..')
  await expect(locals).toContainText('seed')
  await expect(locals).toContainText('5')

  await page.getByRole('button', { name: 'Step Into', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.cpp:4')
  await expect(locals).toContainText('value')
  await expect(locals).toContainText('5')

  await page.getByRole('button', { name: 'Step Over', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.cpp:5')
  await expect(locals).toContainText('result')
  await expect(locals).toContainText('10')

  await page.getByRole('button', { name: 'Step Out', exact: true }).click()
  await expect(statusBar).toContainText('Paused at main.cpp:11')
  await expect(locals).toContainText('answer')
  await expect(locals).toContainText('10')

  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(statusBar).toContainText('Ready')
  await expect(page.getByRole('toolbar', { name: 'Debug controls' })).toHaveCount(0)

  expectCleanBrowser(diagnostics)
})

import { expect, test } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

const example = '/?runtime=cpp&build-status=multi-file'

test('shows cold initialization, multiple source files, and genuine cache reuse', async ({ page }, testInfo) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.setViewportSize({ width: 1440, height: 1000 })

  let releaseRuntime!: () => void
  let announceRuntime!: () => void
  const runtimeRequested = new Promise<void>((resolve) => { announceRuntime = resolve })
  const runtimeReleased = new Promise<void>((resolve) => { releaseRuntime = resolve })
  await page.route(/debugger-sh-[^/]+\.js$/, async (route) => {
    announceRuntime()
    await runtimeReleased
    await route.continue()
  })

  // Hold the real compiler download until the current-step feedback is visible.
  // This controls an observable network boundary without replacing the compiler.
  let releaseCompiler!: () => void
  let announceCompiler!: () => void
  const compilerRequested = new Promise<void>((resolve) => { announceCompiler = resolve })
  const compilerReleased = new Promise<void>((resolve) => { releaseCompiler = resolve })
  await page.route(/llvm\.core\.wasm(?:\?.*)?$/, async (route) => {
    announceCompiler()
    await compilerReleased
    await route.continue()
  })

  const navigation = await page.goto(example)
  await expectIsolatedRuntime(page, navigation)
  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const terminal = page.locator('.xterm-rows')
  const run = page.locator('[data-command-id="workbench.run"]')
  await expect(statusBar).toContainText('Ready')
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.getByRole('treeitem', { name: 'main.cpp', exact: true }).click()
  await expect(editorLine(page, '#include <iostream>')).toBeVisible()
  await run.click()
  try {
    await runtimeRequested
    await expect(terminal).toContainText('Initializing execution environment')
    await page.screenshot({ path: testInfo.outputPath('01-runtime-initialization.png'), fullPage: true })
    releaseRuntime()
    await compilerRequested
    await expect(terminal).toContainText(/\[build\].*Building helpers\.cpp, main\.cpp/i)
    await page.screenshot({ path: testInfo.outputPath('02-source-build-in-progress.png'), fullPage: true })
  } finally {
    releaseRuntime()
    releaseCompiler()
  }

  await expect(terminal).toContainText('Double 5 is 10')
  await expect(terminal).toContainText('Program exited with code 0')
  await expect(statusBar).toContainText('Ready')
  await expect(terminal).toContainText('main.cpp')
  await expect(terminal).toContainText('helpers.cpp')
  await expect(page.getByRole('region', { name: 'Build status', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('03-multiple-files-complete.png'), fullPage: true })

  await run.click()
  await expect(terminal).toContainText('Program exited with code 0')
  await expect(statusBar).toContainText('Ready')
  await expect(terminal).toContainText(/\[build\] Cache hits: helpers\.cpp/i)
  await expect(terminal).toContainText('main.cpp')
  await expect(terminal).toContainText('helpers.cpp')
  await page.screenshot({ path: testInfo.outputPath('04-cache-hits.png'), fullPage: true })
  expectCleanBrowser(diagnostics)
})

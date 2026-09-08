import { expect, test } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

interface PublicPathProbeWindow extends Window {
  __webIDEWorkspaceProbe?: {
    handle(): {
      reset(options?: { breakpointFiles?: readonly string[] }): void
      snapshot(): {
        editor: { activeFile: string | null; openFiles: readonly string[] }
        debug: { breakpoints: Readonly<Record<string, readonly number[]>> }
      }
    } | null
  }
  __webIDESourcePresentationProbe?: {
    source: {
      reveal(location: { path: string; line: number }): void
      replaceDecorations(decorations: readonly {
        path: string
        line: number
        kind: 'error'
      }[]): void
    }
  }
}

test('gives contributed activities isolated execution and source services', async ({ page, context }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?source=probe')

  await expectIsolatedRuntime(page, navigation)

  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const terminal = page.locator('.xterm-rows')
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(statusBar).toContainText('Ready')

  await page.getByRole('button', { name: 'Execution and source', exact: true }).click()
  const probe = page.getByRole('region', { name: 'Execution and source probe' })
  await expect(probe).toBeVisible()

  await probe.getByRole('button', { name: 'Run from activity' }).click()
  await expect(terminal).toContainText('Double 5 is 10')
  await expect(terminal).toContainText('Program exited with code 0')
  await expect(statusBar).toContainText('Ready')
  await expect(probe.locator('output')).toContainText('execution request settled')

  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await page.getByRole('treeitem', { name: 'main.py', exact: true }).click()
  const seedLine = editorLine(page, 'seed = 5')
  await expect(seedLine).toHaveCount(1)
  await seedLine.click()
  await page.keyboard.press('F9')
  await page.getByRole('button', { name: 'Execution and source', exact: true }).click()
  await probe.getByRole('button', { name: 'Debug from activity' }).click()
  await expect(statusBar).toContainText('Paused at main.py:3')
  await probe.getByRole('button', { name: 'Stop from activity' }).click()
  await expect(statusBar).toContainText('Ready')
  await expect(probe.locator('output')).toContainText('stop request settled')

  // Exercise both public path seams through the production bundle. The
  // workspace read facade accepts canonical aliases, but source presentation
  // must reject them and reset must never create an alias breakpoint key.
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await page.getByRole('treeitem', { name: 'caf\u00e9.py', exact: true }).click()
  await editorLine(page, 'print("canonical path")').click()
  await page.keyboard.press('F9')
  await expect.poll(() => page.evaluate(() => {
    const handle = (window as PublicPathProbeWindow).__webIDEWorkspaceProbe?.handle()
    return handle?.snapshot().debug.breakpoints['/workspace/caf\u00e9.py'] ?? null
  })).toEqual([1])
  await page.getByRole('button', { name: 'Execution and source', exact: true }).click()

  const publicPathResult = await page.evaluate(() => {
    const scope = window as PublicPathProbeWindow
    const handle = scope.__webIDEWorkspaceProbe?.handle()
    const source = scope.__webIDESourcePresentationProbe?.source
    if (!handle || !source) throw new Error('Public path probes are unavailable')
    const decomposed = '/workspace/cafe\u0301.py'
    const editorBefore = handle.snapshot().editor
    let revealError = ''
    let decorationsError = ''
    try {
      source.reveal({ path: decomposed, line: 1 })
    } catch (error) {
      revealError = String(error)
    }
    try {
      source.replaceDecorations([{ path: decomposed, line: 1, kind: 'error' }])
    } catch (error) {
      decorationsError = String(error)
    }
    handle.reset({ breakpointFiles: [decomposed] })
    const after = handle.snapshot()
    return {
      revealError,
      decorationsError,
      editorBefore,
      editorAfter: after.editor,
      breakpoints: after.debug.breakpoints,
    }
  })

  expect(publicPathResult.revealError).toContain('not canonical')
  expect(publicPathResult.decorationsError).toContain('not canonical')
  expect(publicPathResult.editorAfter).toEqual(publicPathResult.editorBefore)
  expect(publicPathResult.breakpoints['/workspace/caf\u00e9.py']).toEqual([])
  expect(publicPathResult.breakpoints).not.toHaveProperty('/workspace/cafe\u0301.py')
  await expect(page.locator('.monaco-editor [class*="source-presentation-"]')).toHaveCount(0)

  await probe.getByRole('button', { name: 'Present current helper line' }).click()
  await expect(page.getByRole('tab', { name: 'helpers.py' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor .source-presentation-current-line')).toHaveCount(1)
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(0)
  await expect(probe.locator('output')).toContainText('current: /workspace/helpers.py:2')
  await expect(statusBar).toContainText('Ln 2, Col 1')

  await probe.getByRole('button', { name: 'Present historical main line' }).click()
  await expect(page.getByRole('tab', { name: 'main.py' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor .source-presentation-current-line')).toHaveCount(0)
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(1)
  await expect(probe.locator('output')).toContainText('historical: /workspace/main.py:4')
  await expect(statusBar).toContainText('Ln 4, Col 1')

  await probe.getByRole('button', { name: 'Present error main line' }).click()
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(0)
  await expect(page.locator('.monaco-editor .source-presentation-error-line')).toHaveCount(1)
  await expect(probe.locator('output')).toContainText('error: /workspace/main.py:8')
  await expect(statusBar).toContainText('Ln 8, Col 1')

  // Switching activities unmounts this owner. Its decoration must disappear,
  // and reopening it must not resurrect stale presentation state.
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(probe).toHaveCount(0)
  await expect(page.locator('.monaco-editor [class*="source-presentation-"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Execution and source', exact: true }).click()
  await expect(page.locator('.monaco-editor [class*="source-presentation-"]')).toHaveCount(0)

  // Two production Web IDE realms retain independent owners and editor state.
  await probe.getByRole('button', { name: 'Present current helper line' }).click()
  await expect(page.locator('.monaco-editor .source-presentation-current-line')).toHaveCount(1)
  const secondPage = await context.newPage()
  const secondDiagnostics = observeBrowserDiagnostics(secondPage)
  const secondNavigation = await secondPage.goto('/?source=probe')
  await expectIsolatedRuntime(secondPage, secondNavigation)
  await expect(secondPage.getByRole('contentinfo', { name: 'Status bar' })).toContainText('Ready')
  const secondProbe = secondPage.getByRole('region', { name: 'Execution and source probe' })
  // Layout preference is intentionally shared through localStorage. If this
  // page did not inherit the already-open activity, open it exactly once.
  if (!await secondProbe.isVisible()) {
    await secondPage.getByRole('button', { name: 'Execution and source', exact: true }).click()
  }
  await expect(secondProbe).toBeVisible()
  await expect(secondPage.locator('.monaco-editor [class*="source-presentation-"]')).toHaveCount(0)
  await secondProbe.getByRole('button', { name: 'Present historical main line' }).click()
  await expect(secondPage.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(1)
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(page.locator('.monaco-editor [class*="source-presentation-"]')).toHaveCount(0)
  await expect(secondPage.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(1)

  await secondPage.close()
  expectCleanBrowser(diagnostics)
  expectCleanBrowser(secondDiagnostics)
})

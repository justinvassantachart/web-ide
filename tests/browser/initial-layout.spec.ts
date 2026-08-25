import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

async function expectPercent(
  panel: Locator,
  axis: 'height' | 'width',
  expected: number,
) {
  await expect(panel).toBeVisible()
  const percent = await panel.evaluate((element, selectedAxis) => {
    const panelRect = element.getBoundingClientRect()
    const panelGroup = element.parentElement
    if (!panelGroup) throw new Error('Resizable panel has no parent group')
    const panelSize = selectedAxis === 'width' ? panelRect.width : panelRect.height
    const totalPanelSize = [...panelGroup.children]
      .filter((child) => child.hasAttribute('data-web-ide-region'))
      .reduce((total, child) => {
        const rectangle = child.getBoundingClientRect()
        return total + (selectedAxis === 'width' ? rectangle.width : rectangle.height)
      }, 0)
    return panelSize / totalPanelSize * 100
  }, axis)
  expect(percent).toBeCloseTo(expected, 0)
}

async function expectReady(page: Page) {
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(page.locator('footer[aria-label="Status bar"]')).toContainText('Ready')
}

test('preserves default panel selection and 27/70 proportions', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?layout=default')
  await expectIsolatedRuntime(page, navigation)
  await expectReady(page)

  const variables = page.getByRole('tab', { name: 'Variables', exact: true })
  await expect(variables).toHaveAttribute('aria-selected', 'true')
  const tabpanel = page.getByRole('tabpanel')
  await expect(tabpanel).toHaveAttribute('aria-labelledby', await variables.getAttribute('id') ?? '')
  await expect(variables).toHaveAttribute('aria-controls', await tabpanel.getAttribute('id') ?? '')
  await expectPercent(page.locator('[data-web-ide-region="panel-column"]'), 'width', 27)
  await expectPercent(page.locator('[data-web-ide-region="panel-content"]'), 'height', 70)

  expectCleanBrowser(diagnostics)
})

test('applies requested ratios and shows the exact initial panel without a click', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const navigation = await page.goto('/?layout=custom')
  await expectIsolatedRuntime(page, navigation)
  await expectReady(page)

  const canvas = page.getByRole('tab', { name: 'Canvas', exact: true })
  await expect(canvas).toHaveAttribute('aria-selected', 'true')
  const activities = page.getByRole('navigation', { name: 'Activity Bar' }).getByRole('button')
  await expect(activities.nth(0)).toHaveAccessibleName('Instructions')
  await expect(activities.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(activities.nth(1)).toHaveAccessibleName('Explorer')
  await expect(page.getByRole('heading', { name: 'Host instructions' })).toBeVisible()
  await expectPercent(page.locator('[data-web-ide-region="panel-column"]'), 'width', 50)
  await expectPercent(page.locator('[data-web-ide-region="panel-content"]'), 'height', 85)

  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Tests', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Tests', exact: true })).toBeFocused()

  expectCleanBrowser(diagnostics)
})

test('rejects unknown and currently unavailable initial panels without a usable mount', async ({ page }) => {
  for (const [mode, message] of [
    ['invalid', 'No panel contributed with id "fixture.unknown-panel"'],
    ['invalid-activity', 'No activity contributed with id "fixture.unknown-activity"'],
    ['unavailable', 'Initial panel "graph" is not visible'],
  ] as const) {
    const diagnostics = observeBrowserDiagnostics(page)
    const navigation = await page.goto(`/?layout=${mode}`)
    await expectIsolatedRuntime(page, navigation)
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.locator('.web-ide-root')).toHaveCount(0)

    // React reports caught render errors to the console. Only the exact
    // fixture error is expected; transport, page, and unrelated diagnostics
    // remain failures.
    expect(diagnostics.consoleErrors.length).toBeGreaterThan(0)
    expect(diagnostics.consoleErrors.every((entry) => entry.includes(message))).toBe(true)
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.requestFailures).toEqual([])
    expect(diagnostics.errorResponses).toEqual([])
  }
})

test('restores requested state on remount and isolates simultaneous workbenches', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  let navigation = await page.goto('/?layout=remount')
  await expectIsolatedRuntime(page, navigation)
  await expectReady(page)

  await page.getByRole('tab', { name: 'Variables', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Variables', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('button', { name: 'Remount workbench' }).click()
  await expect(page.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Instructions' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  navigation = await page.goto('/?layout=multiple')
  await expectIsolatedRuntime(page, navigation)
  const first = page.getByRole('region', { name: 'First workbench' })
  const second = page.getByRole('region', { name: 'Second workbench' })
  await expect(first.locator('.monaco-editor')).toBeVisible()
  await expect(second.locator('.monaco-editor')).toBeVisible()
  await expect(first.getByRole('tab', { name: 'Variables', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(second.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  await first.getByRole('tab', { name: 'Tests', exact: true }).click()
  await expect(first.getByRole('tab', { name: 'Tests', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(second.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  expectCleanBrowser(diagnostics)
})

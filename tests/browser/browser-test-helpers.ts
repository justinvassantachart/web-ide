import { expect, type Page, type Response } from '@playwright/test'

export interface BrowserDiagnostics {
  consoleErrors: string[]
  pageErrors: string[]
  requestFailures: string[]
  errorResponses: string[]
}

export function observeBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    errorResponses: [],
  }

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message))
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown error'}`,
    )
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.errorResponses.push(`${response.status()} ${response.url()}`)
    }
  })

  return diagnostics
}

export async function expectIsolatedRuntime(page: Page, navigation: Response | null) {
  expect(navigation).not.toBeNull()
  expect(navigation!.headers()['cross-origin-opener-policy']).toBe('same-origin')
  expect(navigation!.headers()['cross-origin-embedder-policy']).toBe('require-corp')
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true)
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function')
}

export function editorLine(page: Page, source: string) {
  return page
    .locator('.monaco-editor .view-lines .view-line')
    .filter({ hasText: source })
}

export function expectCleanBrowser(diagnostics: BrowserDiagnostics) {
  expect(diagnostics).toEqual({
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    errorResponses: [],
  })
}

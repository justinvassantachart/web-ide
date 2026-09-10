import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
    testDir: './tests/browser',
    testMatch: ['shared-viewer-stability.spec.ts'],
    outputDir: './test-results/viewer',
    workers: 1,
    retries: 0,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, baseURL: 'http://127.0.0.1:4196', trace: 'off', screenshot: 'only-on-failure', video: 'off' },
    projects: [{ name: 'packed-viewer', use: { browserName: 'chromium' } }],
    webServer: { command: 'node tests/viewer/serve-packed-viewer.mjs', url: 'http://127.0.0.1:4196', reuseExistingServer: false, timeout: 240_000 },
})

import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const port = 4173
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'line',
  timeout: 5 * 60_000,
  expect: { timeout: 2 * 60_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
      },
    },
  ],
  webServer: {
    command:
      `npm run build && npm --workspace @web-ide/basic-example run preview -- --port ${port} --strictPort`,
    url: baseURL,
    // Never attach to an arbitrary development server: this suite certifies
    // the production bundle built by the command above.
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
})

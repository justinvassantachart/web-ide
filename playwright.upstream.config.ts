import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/upstream', testMatch: '**/*.spec.ts',
  timeout: 180_000, expect: { timeout: 90_000 }, workers: 1, retries: 0,
  outputDir: 'test-results/upstream', reporter: [['line'], ['json', { outputFile: '.artifacts/upstream-browser-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4196', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npx vite build --config tests/upstream/vite.config.ts && npx vite preview --config tests/upstream/vite.config.ts --host 127.0.0.1 --port 4196 --strictPort',
    url: 'http://127.0.0.1:4196', reuseExistingServer: false, timeout: 120_000,
  },
})

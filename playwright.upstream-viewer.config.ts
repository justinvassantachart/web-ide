import { defineConfig } from '@playwright/test'
import viewer from './playwright.viewer.config'

export default defineConfig({
  ...viewer,
  outputDir: './test-results/upstream-viewer',
  use: { ...viewer.use, baseURL: 'http://127.0.0.1:4207' },
  webServer: {
    command: 'WEB_IDE_UPSTREAM_VIEWER=1 node scripts/release/test-upstream-consumer.mjs',
    url: 'http://127.0.0.1:4207',
    reuseExistingServer: false,
    timeout: 240_000,
  },
})

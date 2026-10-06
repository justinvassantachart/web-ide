import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from '@playwright/test'

/** Runs only the packed public consumer, never a source alias. */
export async function verifyHostDeviceBrowser(consumerRoot, environment) {
  const port = 4198
  const server = spawn(process.execPath, [path.join(consumerRoot, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: consumerRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let browser
  const deadline = setTimeout(() => server.kill(), 10 * 60_000)
  try {
    await new Promise((resolve, reject) => {
      server.once('exit', (code) => reject(new Error(`consumer server exited: ${code}`)))
      server.stderr.on('data', (bytes) => process.stderr.write(bytes))
      server.stdout.on('data', (bytes) => { if (String(bytes).includes('http://127.0.0.1:')) resolve() })
    })
    browser = await chromium.launch()
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`) })
    const response = await page.goto(`http://127.0.0.1:${port}/?host-device`)
    if (response.headers()['cross-origin-opener-policy'] !== 'same-origin' || response.headers()['cross-origin-embedder-policy'] !== 'require-corp') throw new Error('Missing isolation headers')
    await page.getByRole('button', { name: 'Verify host byte devices' }).click()
    await page.getByRole('status').filter({ hasText: /(?:PASS|FAIL:)/u }).waitFor({ timeout: 9 * 60_000 })
    const result = await page.getByRole('status').textContent()
    process.stdout.write(`Chromium ${browser.version()}\n${result}\n`)
    if (!result.endsWith('PASS\n') || errors.length) throw new Error(`Packed byte-device consumer failed: ${result}\n${errors.join('\n')}`)
  } finally {
    clearTimeout(deadline)
    await browser?.close()
    server.kill()
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve))
  }
}

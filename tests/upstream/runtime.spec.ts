import { test, expect, type Page } from '@playwright/test'
import type { UpstreamFixture } from './main'
declare global { interface Window { upstreamFixture: UpstreamFixture } }
const pageErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('#ready')).toHaveText('Runtime fixture ready')
})
test.afterEach(async ({ page }, info) => {
  await info.attach('runtime-state', { body: JSON.stringify(await page.evaluate(() => window.upstreamFixture.state)), contentType: 'application/json' })
  await page.evaluate(() => window.upstreamFixture.dispose())
  expect(pageErrors.get(page)).toEqual([])
})

test('Python interactive input, UTF-8 output, binary mount and immediate rerun', async ({ page }) => {
  await page.evaluate(async () => {
    const f = window.upstreamFixture
    await f.create('python')
    await f.run({ mode: 'run', files: { '/workspace/main.py': 'print("ready", flush=True)\nx = input()\nprint("héllo", x, list(open("/image.bin", "rb").read()))\n' }, binaryFiles: { '/workspace/image.bin': new Uint8Array([0, 255, 128]) } })
  })
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('ready')
  await page.evaluate(() => { const f = window.upstreamFixture; f.input('world'); f.input('\r') })
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('héllo world [0, 255, 128]')
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
  await page.evaluate(() => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': 'import os\nprint("isolated", not os.path.exists("/image.bin"))' } }))
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('isolated True')
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
  await page.evaluate(() => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': 'import sys\nprint("readall", flush=True)\nprint("received", repr(sys.stdin.read()))' } }))
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('readall')
  await page.evaluate(() => {
    const f = window.upstreamFixture
    f.input('first'); f.input('\r'); f.input('second'); f.input('\r'); f.input('\x04')
    f.input('after EOF'); f.input('\r')
  })
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
  expect(await page.evaluate(() => window.upstreamFixture.state.stdout)).toContain("received 'first\\nsecond\\n'")
})

test('runtime download outage reports an error, then retries without mislabeling guest exit 127', async ({ page }) => {
  await page.route('**/python.wasm', route => route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Synthetic runtime outage' }))
  await page.evaluate(async () => {
    const f = window.upstreamFixture
    await f.create('python')
    await f.run({ mode: 'run', files: { 'main.py': 'print("must not execute")' } })
  })
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toMatchObject({ type: 'error', error: { type: 'EngineLoadError' } })
  expect(await page.evaluate(() => window.upstreamFixture.state.stdout)).not.toContain('must not execute')
  await page.unroute('**/python.wasm')
  await page.evaluate(() => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': 'import sys\nprint("retried")\nsys.exit(127)' } }))
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 127 })
  expect(await page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('retried')
})

test('single-path duplex, Stop with reply outstanding, and old-response isolation', async ({ page }) => {
  const program = 'import os\nf = os.open("/dev/debugger-sh-host", os.O_RDWR)\nos.write(f, b"ping")\nprint("reply", list(os.read(f, 4)), flush=True)\n'
  await page.evaluate(async source => { const f = window.upstreamFixture; await f.create('python', true); await f.run({ mode: 'run', files: { 'main.py': source } }) }, program)
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.hostRequests.flat())).toEqual([112, 105, 110, 103])
  expect(await page.evaluate(() => window.upstreamFixture.stop())).toEqual({ type: 'stopped' })
  await page.evaluate(source => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': source } }), program)
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.hostRequests.flat().length)).toBe(8)
  expect(await page.evaluate(() => window.upstreamFixture.staleResponse())).toBe('rejected')
  await page.evaluate(() => window.upstreamFixture.respond([1, 2, 3, 4]))
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('reply [1, 2, 3, 4]')
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
})

test('Stop while cold initialization or input is blocked then recover', async ({ page }) => {
  await page.evaluate(async () => {
    const f = window.upstreamFixture
    await f.create('python')
    await f.run({ mode: 'run', files: { 'main.py': 'print("must not run")' } })
    await f.stop()
  })
  expect(await page.evaluate(() => window.upstreamFixture.state.stdout)).not.toContain('must not run')
  await page.evaluate(() => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': 'print("waiting", flush=True)\ninput()' } }))
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('waiting')
  expect(await page.evaluate(() => window.upstreamFixture.stop())).toEqual({ type: 'stopped' })
  await page.evaluate(() => window.upstreamFixture.run({ mode: 'run', files: { 'main.py': 'print("recovered")' } }))
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('recovered')
})

test('C++ multi-file exceptions, debug source mapping, Stop at breakpoint and rerun', async ({ page }) => {
  const files = {
    '/workspace/main.cpp': '#include <cstdio>\nint work();\nint main() {\n  int result = work();\n  printf("result=%d\\n", result);\n  return 0;\n}\n',
    '/workspace/lib/work.cpp': 'int work() {\n  try { throw 42; }\n  catch (int value) {\n    return value;\n  }\n}\n',
  }
  await page.evaluate(async files => {
    const f = window.upstreamFixture
    await f.create('cpp')
    await f.run({ mode: 'run', files, cppArtifacts: { sources: Object.keys(files) } })
  }, files)
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('result=42')
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
  await page.evaluate(files => window.upstreamFixture.run({ mode: 'debug', files }, { '/workspace/lib/work.cpp': [4] }), files)
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.pauses.length)).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.upstreamFixture.state.pauses))).toContain('/workspace/lib/work.cpp')
  expect(await page.evaluate(() => window.upstreamFixture.stop())).toEqual({ type: 'stopped' })
  await page.evaluate(files => window.upstreamFixture.run({ mode: 'run', files }), files)
  expect(await page.evaluate(() => window.upstreamFixture.outcome())).toEqual({ type: 'completed', exitCode: 0 })
})

test('project sessions and tabs cannot observe another session filesystem', async ({ page, context }) => {
  await page.evaluate(async () => {
    const f = window.upstreamFixture
    await f.create('python')
    await f.run({ mode: 'run', files: { 'main.py': 'open("/owned.txt", "w").write("synthetic secret")\nprint("owner ready", flush=True)\ninput()' } })
  })
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('owner ready')
  await page.evaluate(async () => {
    const f = window.upstreamFixture
    await f.create('python')
    await f.run({ mode: 'run', files: { 'main.py': 'import os\nprint("project isolated", not os.path.exists("/owned.txt"))' } })
  })
  await expect.poll(() => page.evaluate(() => window.upstreamFixture.state.stdout)).toContain('project isolated True')
  const other = await context.newPage()
  try {
    await other.goto('/')
    await expect(other.locator('#ready')).toHaveText('Runtime fixture ready')
    await other.evaluate(async () => {
      const f = window.upstreamFixture
      await f.create('python')
      await f.run({ mode: 'run', files: { 'main.py': 'import os\nprint("tab isolated", not os.path.exists("/owned.txt"))' } })
    })
    await expect.poll(() => other.evaluate(() => window.upstreamFixture.state.stdout)).toContain('tab isolated True')
    await other.evaluate(() => window.upstreamFixture.dispose())
  } finally { await other.close() }
})

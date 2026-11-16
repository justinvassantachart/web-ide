import { test, expect, type Page } from '@playwright/test'
import type { CacheFixture } from './main'

declare global { interface Window { cacheFixture: CacheFixture } }
const pageErrors = new WeakMap<Page, string[]>()
type BuildResult = Awaited<ReturnType<CacheFixture['build']>>

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('#ready')).toHaveText('Runtime fixture ready')
  await page.evaluate(() => window.cacheFixture.reset())
})

test.afterEach(async ({ page }, info) => {
  await info.attach('runtime-state', { body: JSON.stringify(await page.evaluate(() => window.upstreamFixture.state)), contentType: 'application/json' })
  await page.evaluate(() => window.upstreamFixture.dispose())
  expect(pageErrors.get(page)).toEqual([])
})

function expectOutput(result: BuildResult, output: string, compiles: number) {
  expect(result.outcome, result.stderr).toEqual({ type: 'completed', exitCode: 0 })
  expect(result.stdout).toBe(output)
  expect(result.jobs).toHaveLength(compiles)
  for (const job of result.jobs) expect(job.generation).toMatch(/^[a-f0-9]{64}$/)
}

test('C++ cache reuses unchanged objects and invalidates source, header and compile flags', async ({ page }, info) => {
  const files = {
    'main.cpp': '#include <cstdio>\n#include "value.hpp"\nint work();\nint main() { printf("value=%d\\n", work() + HEADER_VALUE + FLAG_VALUE); }\n',
    'lib/work.cpp': '#include "value.hpp"\nint work() { return 5 + HEADER_VALUE; }\n',
    'value.hpp': '#define HEADER_VALUE 3\n',
  }
  const build = (files: Record<string, string>, flagValue: number) => page.evaluate(input => window.cacheFixture.build(input), { files, flagValue })
  const cold = await build(files, 10)
  expectOutput(cold, 'value=21\n', 2)
  expect(cold.jobs.map(job => job.source).sort()).toEqual(['/lib/work.cpp', '/main.cpp'])
  const warm = await build(files, 10)
  expectOutput(warm, 'value=21\n', 0)

  const sourceEdit = { ...files, 'lib/work.cpp': '#include "value.hpp"\nint work() { return 9 + HEADER_VALUE; }\n' }
  const edited = await build(sourceEdit, 10)
  expectOutput(edited, 'value=25\n', 1)
  expect(edited.jobs[0].source).toBe('/lib/work.cpp')
  const headerEdit = { ...sourceEdit, 'value.hpp': '#define HEADER_VALUE 7\n' }
  const header = await build(headerEdit, 10)
  expectOutput(header, 'value=33\n', 2)
  const flags = await build(headerEdit, 20)
  expectOutput(flags, 'value=43\n', 2)

  await page.evaluate(() => window.cacheFixture.reset())
  const cleanHeader = await build(headerEdit, 10)
  expectOutput(cleanHeader, header.stdout, 2)
  await page.evaluate(() => window.cacheFixture.reset())
  const cleanFlags = await build(headerEdit, 20)
  expectOutput(cleanFlags, flags.stdout, 2)
  await info.attach('compiler-jobs', { body: JSON.stringify({ cold, warm, edited, header, flags, cleanHeader, cleanFlags }, null, 2), contentType: 'application/json' })
})

test('replacing binary PCH bytes at the same path changes the cache generation and output', async ({ page }, info) => {
  const firstPch = await page.evaluate(() => window.cacheFixture.preparePch(7))
  const nextPch = await page.evaluate(() => window.cacheFixture.preparePch(19))
  expect(firstPch.byteLength).toBeGreaterThan(0)
  expect(nextPch.byteLength).toBeGreaterThan(0)
  expect(nextPch.sha256).not.toBe(firstPch.sha256)
  const files = { 'main.cpp': '#include <cstdio>\nint main() { printf("pch=%d\\n", pch_value()); }\n' }
  const build = (pchValue: number) => page.evaluate(input => window.cacheFixture.build(input), { files, pchValue })
  const cold = await build(7)
  expectOutput(cold, 'pch=7\n', 1)
  const warm = await build(7)
  expectOutput(warm, 'pch=7\n', 0)
  const changed = await build(19)
  expectOutput(changed, 'pch=19\n', 1)
  expect(changed.jobs[0].generation).not.toBe(cold.jobs[0].generation)
  for (const result of [cold, changed]) {
    const args = result.jobs[0].args
    expect(args[args.indexOf('-include-pch') + 1]).toBe('/course.pch')
  }
  const changedWarm = await build(19)
  expectOutput(changedWarm, 'pch=19\n', 0)
  await page.evaluate(() => window.cacheFixture.reset())
  const clean = await build(19)
  expectOutput(clean, changed.stdout, 1)
  await info.attach('pch-generations', { body: JSON.stringify({ firstPch, nextPch, cold, warm, changed, changedWarm, clean }, null, 2), contentType: 'application/json' })
})

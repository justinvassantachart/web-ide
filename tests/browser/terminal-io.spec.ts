import { expect, test } from '@playwright/test'
import {
  editorLine,
  expectCleanBrowser,
  expectIsolatedRuntime,
  observeBrowserDiagnostics,
} from './browser-test-helpers'

const programs = [
  {
    language: 'Python',
    url: '/',
    file: 'main.py',
    source: [
      'import sys',
      'name = input("Name? ")',
      'number = int(input("Number? "))',
      'print(f"RESULT: {name} | {number * 2}", flush=True)',
      'print("STDERR: complete", file=sys.stderr, flush=True)',
    ].join('\n'),
  },
  {
    language: 'C++',
    url: '/?runtime=cpp',
    file: 'main.cpp',
    source: [
      '#include <iostream>',
      '#include <string>',
      'int main() {',
      '  std::string name;',
      '  int number = 0;',
      '  std::cout << "Name? " << std::flush;',
      '  std::getline(std::cin, name);',
      '  std::cout << "Number? " << std::flush;',
      '  std::cin >> number;',
      '  std::cout << "RESULT: " << name << " | " << number * 2 << std::endl;',
      '  std::cerr << "STDERR: complete" << std::endl;',
      '  return 0;',
      '}',
    ].join('\n'),
  },
] as const

for (const program of programs) {
  test(`${program.language} reads terminal input and prints computed output in the production runtime`, async ({ page }) => {
    const diagnostics = observeBrowserDiagnostics(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    const navigation = await page.goto(program.url)
    await expectIsolatedRuntime(page, navigation)

    const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
    await expect(statusBar).toContainText('Ready')
    await page.getByRole('treeitem', { name: program.file, exact: true }).click()
    await editorLine(page, program.language === 'Python' ? 'from helpers import double' : '#include <iostream>').click()
    // The browser project emulates a desktop user agent. Match the editor's
    // advertised platform rather than the operating system running Playwright.
    const userAgent = await page.evaluate(() => navigator.userAgent)
    await page.keyboard.press(/Macintosh/.test(userAgent) ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(program.source)

    const terminal = page.locator('.xterm-rows')
    const terminalInput = page.getByRole('textbox', { name: 'Terminal input' })
    const run = page.locator('[data-command-id="workbench.run"]')

    // Exercise the real keyboard → xterm → runtime → program round trip twice.
    // The computed result cannot be satisfied by the terminal's local input echo.
    for (const [name, number, result] of [
      ['Ada Lovelace', '21', '42'],
      ['Grace Hopper', '7', '14'],
    ]) {
      await run.click()
      await expect(terminal).toContainText('Name?')
      await terminalInput.focus()
      await page.keyboard.type(`${name}x`)
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Enter')
      await expect(terminal).toContainText('Number?')
      await page.keyboard.type(number)
      await page.keyboard.press('Enter')

      await expect(terminal).toContainText(`RESULT: ${name} | ${result}`)
      await expect(terminal).toContainText('STDERR: complete')
      await expect(terminal).toContainText('Program exited with code 0')
      await expect(statusBar).toContainText('Ready')
    }

    expectCleanBrowser(diagnostics)
  })
}

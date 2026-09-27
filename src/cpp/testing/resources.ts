import header from './webide_test.h?raw'
import implementation from './webide_test.cpp?raw'
import runner from './webide_test_runner.cpp?raw'
import type { WorkspaceFiles } from '@/web-ide/contracts/host'
export const CPP_TEST_HEADER_PATH = '/workspace/webide_test.h'
export const CPP_TEST_IMPL_PATH = '/workspace/webide_test.cpp'
export const CPP_TEST_RUNNER_PATH = '/workspace/webide_test_runner.cpp'
export const CPP_TEST_CONFIG_PATH = '/workspace/webide_test_config.h'
export const CPP_TEST_RUNNER_SOURCE: string = runner
export const CPP_TEST_SUPPORT_FILES: Readonly<WorkspaceFiles> = Object.freeze({ [CPP_TEST_HEADER_PATH]: header, [CPP_TEST_IMPL_PATH]: implementation })
export const CPP_TEST_RESERVED_PATHS = Object.freeze([...Object.keys(CPP_TEST_SUPPORT_FILES), CPP_TEST_RUNNER_PATH, CPP_TEST_CONFIG_PATH])
export function makeCppTestConfig(runId: string, selectionKeys?: readonly string[]): string {
  if (!/^[a-f0-9]{16,128}$/.test(runId) || selectionKeys?.some(key => !/^[a-f0-9]{16}$/.test(key)) || (selectionKeys && (selectionKeys.length === 0 || selectionKeys.length > 10000))) throw new TypeError('Invalid C++ test run configuration')
  return `#define WEBIDE_TEST_NONCE "${runId}"\n#define WEBIDE_TEST_ALL ${selectionKeys ? 'false' : 'true'}\n#define WEBIDE_TEST_SELECTION std::vector<std::string>{${(selectionKeys ?? []).map(key => `"${key}"`).join(',')}}\n`
}
export function validateCppTestSupportFiles(files: WorkspaceFiles): void {
  const present = CPP_TEST_RESERVED_PATHS.filter(path => Object.hasOwn(files, path))
  if (!present.length) return
  for (const [path, content] of Object.entries(CPP_TEST_SUPPORT_FILES)) if (files[path] !== content) throw new TypeError(`Missing or modified trusted testing support: ${path}`)
  const hasRunner = Object.hasOwn(files, CPP_TEST_RUNNER_PATH), hasConfig = Object.hasOwn(files, CPP_TEST_CONFIG_PATH)
  if (hasRunner !== hasConfig || (hasRunner && files[CPP_TEST_RUNNER_PATH] !== CPP_TEST_RUNNER_SOURCE)) throw new TypeError('Missing or modified trusted test runner')
  if (hasConfig) {
    const match = /^#define WEBIDE_TEST_NONCE "([a-f0-9]{16,128})"\n#define WEBIDE_TEST_ALL (true|false)\n#define WEBIDE_TEST_SELECTION std::vector<std::string>\{((?:"[a-f0-9]{16}"(?:,"[a-f0-9]{16}")*)?)\}\n$/.exec(files[CPP_TEST_CONFIG_PATH])
    if (!match) throw new TypeError('Invalid trusted test configuration')
    const selected = JSON.parse(`[${match[3]}]`) as string[]
    if (makeCppTestConfig(match[1], match[2] === 'true' ? undefined : selected) !== files[CPP_TEST_CONFIG_PATH]) throw new TypeError('Invalid trusted test selection')
  }
}

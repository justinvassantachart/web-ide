import type { FunctionComponent, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCppClangdProvider,
  MAX_CLANGD_SUPPORT_FILES,
  MAX_CLANGD_SUPPORT_FILE_BYTES,
} from '../../src/clangd/plugin'
import {
  type ClangdProviderConfiguration,
} from '../../src/clangd/ClangdContext'
import { collectClangdInitialFiles } from '../../src/clangd/initial-files'
import { attachClangdWorkspaceSync } from '../../src/clangd/workspace-sync'
import type { CppCompileProfileV1 } from '../../src/web-ide/contracts/cpp'
import type { LanguageToolingProviderComponentProps } from '../../src/web-ide/contracts/language-tooling'
import { createWorkbenchInstance } from '../../src/web-ide/react/workbench-instance-context'

const profile: CppCompileProfileV1 = Object.freeze({
  version: 1,
  target: 'wasm32-wasip1',
  languageStandard: 'c++20',
  includeDirectories: Object.freeze(['/support/include']),
  defines: Object.freeze([{ name: 'SYNTHETIC_FEATURE', value: '1' }]),
  warningPreset: 'strict',
  toolchain: Object.freeze({
    compilerDigest: 'a'.repeat(64),
    sysrootDigest: 'b'.repeat(64),
    cxxAbiId: 'synthetic-libcxx-v1',
  }),
})

afterEach(() => vi.useRealTimers())

describe('configurable clangd provider', () => {
  it('validates a profile and derives reviewed flags without changing the default provider', () => {
    const provider = createCppClangdProvider({
      id: 'synthetic.clangd.cpp20',
      label: 'Synthetic C++20',
      profile,
      supportFiles: { '/support/include/synthetic.h': '#pragma once\n' },
    })
    const Component = provider.component as FunctionComponent<LanguageToolingProviderComponentProps>
    const element = Component({ disabled: true, publishService: vi.fn() }) as ReactElement<{
      configuration: ClangdProviderConfiguration
    }>

    expect(provider).toMatchObject({
      id: 'synthetic.clangd.cpp20',
      label: 'Synthetic C++20',
      languageIds: ['c', 'cpp'],
    })
    expect(element.props.configuration.compileFlags).toEqual([
      '-std=c++20',
      '--target=wasm32-wasip1',
      '-Wall',
      '-Wextra',
      '-Wpedantic',
      '-I/support/include',
      '-DSYNTHETIC_FEATURE=1',
    ])
    expect(element.props.configuration.supportFiles).toEqual({
      '/support/include/synthetic.h': '#pragma once\n',
    })
  })

  it('rejects duplicate define names and caller-supplied clangd configuration', () => {
    expect(() => createCppClangdProvider({
      id: 'synthetic.invalid',
      label: 'Invalid',
      profile: { ...profile, defines: [{ name: 'DUP' }, { name: 'DUP', value: '2' }] },
    })).toThrow('duplicate name')
    expect(() => createCppClangdProvider({
      id: 'synthetic.invalid',
      label: 'Invalid',
      profile,
      supportFiles: { '/workspace/.clangd': 'CompileFlags: { Add: [-unsafe] }' },
    })).toThrow('cannot replace clangd configuration')
  })

  it('bounds reviewed support roots, file counts, per-file bytes, and aggregate bytes', () => {
    expect(() => createCppClangdProvider({
      id: 'synthetic.invalid-root',
      label: 'Invalid root',
      profile,
      supportFiles: { '/workspace/injected.h': 'unsafe' },
    })).toThrow(/reviewed support root/)

    const tooMany = Object.fromEntries(Array.from(
      { length: MAX_CLANGD_SUPPORT_FILES + 1 },
      (_, index) => [`/support/include/f${index}.h`, ''],
    ))
    expect(() => createCppClangdProvider({
      id: 'synthetic.too-many',
      label: 'Too many',
      profile,
      supportFiles: tooMany,
    })).toThrow(/file limit/)

    expect(() => createCppClangdProvider({
      id: 'synthetic.too-large',
      label: 'Too large',
      profile,
      supportFiles: { '/support/include/large.h': 'x'.repeat(MAX_CLANGD_SUPPORT_FILE_BYTES + 1) },
    })).toThrow(/per-file byte limit/)

    const twoMegabytes = 'x'.repeat(MAX_CLANGD_SUPPORT_FILE_BYTES)
    const aggregate = Object.fromEntries(Array.from(
      { length: 17 },
      (_, index) => [`/support/include/aggregate-${index}.h`, twoMegabytes],
    ))
    expect(() => createCppClangdProvider({
      id: 'synthetic.aggregate',
      label: 'Aggregate',
      profile,
      supportFiles: aggregate,
    })).toThrow(/aggregate byte limit/)
  })

  it('rejects every initial-file collision before clangd boot', () => {
    const configuration: ClangdProviderConfiguration = {
      providerId: 'synthetic.clangd',
      compileFlags: [],
      supportFiles: { '/support/include/shared.h': 'provider' },
    }
    expect(() => collectClangdInitialFiles(
      { '/workspace/main.cpp': 'int main() {}' },
      { '/support/include/shared.h': 'supplemental' },
      configuration,
    )).toThrow(/collides/)
    expect(() => collectClangdInitialFiles(
      { '/workspace/.clangd': 'student config' },
      undefined,
      configuration,
    )).toThrow(/generated configuration collides/)
    expect(() => collectClangdInitialFiles(
      { '/workspace/main.cpp': 'int main() {}' },
      { '/unreviewed/provider.h': 'unsafe' },
      configuration,
    )).toThrow(/reviewed support root/)
    expect(() => collectClangdInitialFiles(
      { '/workspace/main.cpp': 'int main() {}' },
      { '/workspace/provider.h': 'x'.repeat(MAX_CLANGD_SUPPORT_FILE_BYTES + 1) },
      configuration,
    )).toThrow(/per-file byte limit/)

    const maximumSupportFile = 'x'.repeat(MAX_CLANGD_SUPPORT_FILE_BYTES)
    expect(() => collectClangdInitialFiles(
      { '/workspace/main.cpp': 'int main() {}' },
      Object.fromEntries(Array.from(
        { length: 9 },
        (_, index) => [`/workspace/provider-${index}.h`, maximumSupportFile],
      )),
      {
        ...configuration,
        supportFiles: Object.fromEntries(Array.from(
          { length: 8 },
          (_, index) => [`/support/include/configured-aggregate-${index}.h`, maximumSupportFile],
        )),
      },
    )).toThrow(/aggregate byte limit/)

    expect(() => collectClangdInitialFiles(
      { '/workspace/main.cpp': 'int main() {}' },
      { '/workspace/provider.h': '' },
      {
        ...configuration,
        supportFiles: Object.fromEntries(Array.from(
          { length: MAX_CLANGD_SUPPORT_FILES },
          (_, index) => [`/support/include/configured-${index}.h`, ''],
        )),
      },
    )).toThrow(/file limit/)

  })

  it.each(['local', 'external'] as const)(
    'makes a post-boot %s workspace file authoritative over provider fallback text',
    async (origin) => {
      vi.useFakeTimers()
      const instance = createWorkbenchInstance()
      await instance.workspace.initialize({
        projectId: `clangd-provider-shadow-${origin}`,
        initialFiles: { '/workspace/main.cpp': 'int main() {}\n' },
        ephemeral: true,
      })
      const supplementalFiles = { '/workspace/webide_test.h': 'provider fallback\n' }
      const configuration: ClangdProviderConfiguration = {
        providerId: 'synthetic.clangd',
        compileFlags: [],
      }
      const writeFiles = vi.fn()
      const deleteFile = vi.fn()
      const synchronization = attachClangdWorkspaceSync({
        workspace: {
          snapshot: () => instance.workspace.snapshot(),
          revision: () => instance.workspace.revision,
          subscribe: (listener) => instance.workspace.subscribe(listener),
        },
        client: { writeFiles, deleteFile },
        readFiles: () => collectClangdInitialFiles(
          instance.workspace.snapshot(),
          supplementalFiles,
          configuration,
        ),
        debounceMs: 0,
      })
      await vi.runAllTimersAsync()
      expect(writeFiles).toHaveBeenCalledWith(expect.objectContaining({
        '/workspace/webide_test.h': 'provider fallback\n',
      }))
      writeFiles.mockClear()

      if (origin === 'local') {
        instance.workspace.createFileLocal('/workspace/webide_test.h', 'workspace authority\n')
        await vi.runAllTimersAsync()
      } else {
        await instance.workspace.applyExternal({
          version: 1,
          kind: 'apply',
          transactionId: 'external-provider-shadow',
          expectedRevision: instance.workspace.revision,
          origin: { kind: 'external-authority', source: 'remote-clangd' },
          operations: [{
            op: 'create',
            path: '/workspace/webide_test.h',
            text: 'workspace authority\n',
          }],
        })
      }

      expect(writeFiles).toHaveBeenLastCalledWith({
        '/workspace/webide_test.h': 'workspace authority\n',
      })
      expect(deleteFile).not.toHaveBeenCalledWith('/workspace/webide_test.h')
      synchronization.dispose()
      instance.workspace.dispose()
    },
  )

  it('contains provider refresh errors while reconciling canonical workspace paths', async () => {
    vi.useFakeTimers()
    const instance = createWorkbenchInstance()
    await instance.workspace.initialize({
      projectId: 'clangd-provider-error',
      initialFiles: { '/workspace/main.cpp': 'int main() {}\n' },
      ephemeral: true,
    })
    let providerFails = false
    const writeFiles = vi.fn()
    const deleteFile = vi.fn()
    const onReadError = vi.fn()
    const synchronization = attachClangdWorkspaceSync({
      workspace: {
        snapshot: () => instance.workspace.snapshot(),
        revision: () => instance.workspace.revision,
        subscribe: (listener) => instance.workspace.subscribe(listener),
      },
      client: { writeFiles, deleteFile },
      readFiles: () => {
        if (providerFails) throw new Error('provider refresh failed')
        return {
          '/workspace/main.cpp': 'int main() {}\n',
          '/workspace/webide_test.h': 'provider fallback\n',
        }
      },
      debounceMs: 0,
      onReadError,
    })
    await vi.runAllTimersAsync()
    writeFiles.mockClear()
    providerFails = true

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'external-provider-error-create',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-clangd' },
      operations: [{
        op: 'create',
        path: '/workspace/webide_test.h',
        text: 'workspace authority\n',
      }],
    })
    expect(writeFiles).toHaveBeenLastCalledWith({
      '/workspace/webide_test.h': 'workspace authority\n',
    })

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'external-provider-error-delete',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-clangd' },
      operations: [{ op: 'delete', path: '/workspace/webide_test.h' }],
    })
    expect(deleteFile).toHaveBeenCalledWith('/workspace/webide_test.h')
    expect(onReadError).toHaveBeenCalledTimes(2)
    synchronization.dispose()
    instance.workspace.dispose()
  })

  it('invalidates through the same feed for authoritative external changes', async () => {
    vi.useFakeTimers()
    const instance = createWorkbenchInstance()
    await instance.workspace.initialize({
      projectId: 'clangd-feed',
      initialFiles: { '/workspace/main.cpp': 'int value = 1;\n' },
      ephemeral: true,
    })
    const writeFiles = vi.fn()
    const deleteFile = vi.fn()
    const subscription = attachClangdWorkspaceSync({
      workspace: {
        snapshot: () => instance.workspace.snapshot(),
        revision: () => instance.workspace.revision,
        subscribe: (listener) => instance.workspace.subscribe(listener),
      },
      client: { writeFiles, deleteFile },
      readFiles: () => instance.workspace.snapshot(),
      debounceMs: 0,
    })
    await vi.runAllTimersAsync()
    expect(writeFiles).toHaveBeenLastCalledWith({ '/workspace/main.cpp': 'int value = 1;\n' })

    await instance.workspace.applyExternal({
      version: 1,
      kind: 'apply',
      transactionId: 'remote-clangd-edit',
      expectedRevision: instance.workspace.revision,
      origin: { kind: 'external-authority', source: 'remote-clangd' },
      operations: [{ op: 'write', path: '/workspace/main.cpp', text: 'int value = 2;\n' }],
    })
    // Authoritative feed changes invalidate synchronously; no local-edit
    // debounce window can expose stale clangd files.
    expect(writeFiles).toHaveBeenLastCalledWith({ '/workspace/main.cpp': 'int value = 2;\n' })
    expect(deleteFile).not.toHaveBeenCalled()
    subscription.dispose()
  })

  it('cancels a pending feed flush and unsubscribes exactly once on teardown', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const writeFiles = vi.fn()
    const synchronization = attachClangdWorkspaceSync({
      workspace: {
        snapshot: () => ({ '/workspace/main.cpp': 'int main() {}\n' }),
        revision: () => 0,
        subscribe: () => unsubscribe,
      },
      client: { writeFiles, deleteFile: vi.fn() },
      readFiles: () => ({ '/workspace/main.cpp': 'int main() {}\n' }),
      debounceMs: 500,
    })

    synchronization.dispose()
    synchronization.dispose()
    await vi.runAllTimersAsync()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(writeFiles).not.toHaveBeenCalled()
  })
})

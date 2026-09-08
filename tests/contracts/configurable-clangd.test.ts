import type { FunctionComponent, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCppClangdProvider } from '../../src/clangd/plugin'
import type { ClangdProviderConfiguration } from '../../src/clangd/ClangdContext'
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
    await vi.runAllTimersAsync()

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

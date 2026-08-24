import { describe, expect, it } from 'vitest'

import type { IDEWorkspaceResourceContribution } from '../../src/web-ide/contracts/contributions'
import {
  mergeExecutionResourceFiles,
  mergeWorkspaceFiles,
  partitionWorkspaceResources,
  projectPersistedWorkspaceFiles,
  workspaceFilesFingerprint,
} from '../../src/web-ide/core/workspace-resources'
import { assertNoFlattenedRuntimePathCollisions } from '../../src/web-ide/core/workspace-path'

describe('workspace resource composition', () => {
  it('merges ordered plugin bundles and gives host-owned files final authority', () => {
    const resources: IDEWorkspaceResourceContribution[] = [
      {
        id: 'first.resources',
        files: {
          '/activity/library.hpp': 'first library',
          '/activity/world.json': 'first world',
        },
      },
      {
        id: 'replacement.resources',
        files: {
          '/activity/world.json': 'replacement world',
          '/activity/readme.txt': 'plugin instructions',
        },
      },
    ]
    const hostFiles = {
      '/activity/world.json': 'host-selected world',
      '/workspace/main.cpp': 'int main() {}',
    }

    const merged = mergeWorkspaceFiles(resources, hostFiles)
    expect(merged).toEqual({
      '/workspace/activity/library.hpp': 'first library',
      '/workspace/activity/world.json': 'host-selected world',
      '/workspace/activity/readme.txt': 'plugin instructions',
      '/workspace/main.cpp': 'int main() {}',
    })
    expect(Object.getPrototypeOf(merged)).toBeNull()
  })

  it('returns a fresh seed and preserves the no-seed standalone case', () => {
    const hostFiles = { '/workspace/main.cpp': 'original' }
    const merged = mergeWorkspaceFiles([], hostFiles)

    expect(mergeWorkspaceFiles([])).toBeUndefined()
    expect(merged).toEqual(hostFiles)
    expect(merged).not.toBe(hostFiles)
  })

  it('keeps execution-only resources out of the VFS seed and projects them under /sysroot', () => {
    const resources: IDEWorkspaceResourceContribution[] = [
      {
        id: 'ordinary.resources',
        scope: 'workspace',
        files: { '/workspace/main.py': 'print("student")' },
      },
      {
        id: 'runtime.resources',
        scope: 'execution-only',
        files: {
          '/workspace/support.py': 'SUPPORT = True',
          '/sysroot/world.json': '{"avenues": 4}',
        },
      },
    ]

    expect(mergeWorkspaceFiles(resources)).toEqual({
      '/workspace/main.py': 'print("student")',
    })
    const partitioned = partitionWorkspaceResources(resources)
    expect(partitioned.workspaceFiles).toEqual({
      '/workspace/main.py': 'print("student")',
    })
    expect(partitioned.executionFiles).toEqual({
      '/sysroot/support.py': 'SUPPORT = True',
      '/sysroot/world.json': '{"avenues": 4}',
    })
    const planFiles = {
      '/workspace/main.py': 'print("student")',
    }
    const runtimeFiles = mergeExecutionResourceFiles(resources, planFiles)
    expect(runtimeFiles).toEqual({
      '/workspace/main.py': 'print("student")',
      '/sysroot/support.py': 'SUPPORT = True',
      '/sysroot/world.json': '{"avenues": 4}',
    })
    expect(runtimeFiles).not.toBe(planFiles)
    expect(planFiles).toEqual({ '/workspace/main.py': 'print("student")' })
    expect(Object.getPrototypeOf(partitioned.workspaceFiles)).toBeNull()
    expect(Object.getPrototypeOf(partitioned.executionFiles)).toBeNull()
  })

  it('uses ordered replacement independently within each resource plane', () => {
    const { workspaceFiles, executionFiles } = partitionWorkspaceResources([
      {
        id: 'first',
        files: { '/same.txt': 'first workspace' },
      },
      {
        id: 'second',
        scope: 'execution-only',
        files: { '/same.txt': 'first runtime' },
      },
      {
        id: 'last',
        files: { '/same.txt': 'last workspace' },
      },
      {
        id: 'last-runtime',
        scope: 'execution-only',
        files: { '/same.txt': 'last runtime' },
      },
    ])

    expect(workspaceFiles).toEqual({ '/workspace/same.txt': 'last workspace' })
    expect(executionFiles).toEqual({ '/sysroot/same.txt': 'last runtime' })
  })

  it('resolves dynamic execution resources exactly once per run without exposing them to VFS or persistence', () => {
    let calls = 0
    let latestSource: Record<string, string> | undefined
    const resources: IDEWorkspaceResourceContribution[] = [{
      id: 'selected-world',
      scope: 'execution-only',
      files: () => {
        calls += 1
        latestSource = { '/world.json': `world-${calls}` }
        return latestSource
      },
    }]
    const planFiles = { '/workspace/main.py': 'print("student")' }

    expect(partitionWorkspaceResources(resources)).toEqual({
      workspaceFiles: undefined,
      executionFiles: undefined,
    })
    expect(mergeWorkspaceFiles(resources, planFiles)).toEqual(planFiles)
    expect(projectPersistedWorkspaceFiles(planFiles)).toEqual(planFiles)
    expect(calls).toBe(0)

    const first = mergeExecutionResourceFiles(resources, planFiles)
    expect(calls).toBe(1)
    expect(first['/sysroot/world.json']).toBe('world-1')
    latestSource!['/world.json'] = 'mutated after merge'
    expect(first['/sysroot/world.json']).toBe('world-1')

    const second = mergeExecutionResourceFiles(resources, planFiles)
    expect(calls).toBe(2)
    expect(second['/sysroot/world.json']).toBe('world-2')
    expect(first['/sysroot/world.json']).toBe('world-1')
  })

  it('propagates a dynamic execution resource failure after exactly one evaluation', () => {
    let calls = 0
    const resources: IDEWorkspaceResourceContribution[] = [{
      id: 'failing-world',
      scope: 'execution-only',
      files: () => {
        calls += 1
        throw new Error('selected world unavailable')
      },
    }]

    expect(() => mergeExecutionResourceFiles(resources, {})).toThrow(
      'selected world unavailable',
    )
    expect(calls).toBe(1)
  })

  it('validates dynamic execution resource maps, content, and paths', () => {
    const invalidMap: IDEWorkspaceResourceContribution[] = [{
      id: 'invalid-map',
      scope: 'execution-only',
      files: (() => null) as unknown as () => Record<string, string>,
    }]
    expect(() => mergeExecutionResourceFiles(invalidMap, {})).toThrow(
      'Workspace resource "invalid-map" must provide a file map',
    )

    const invalidContent: IDEWorkspaceResourceContribution[] = [{
      id: 'invalid-content',
      scope: 'execution-only',
      files: () => ({ '/support.py': 42 }) as unknown as Record<string, string>,
    }]
    expect(() => mergeExecutionResourceFiles(invalidContent, {})).toThrow(
      'Workspace file content must be a string: "/support.py"',
    )

    const unsafePath: IDEWorkspaceResourceContribution[] = [{
      id: 'unsafe-path',
      scope: 'execution-only',
      files: () => ({ '/sysroot/../outside.py': 'unsafe' }),
    }]
    expect(() => mergeExecutionResourceFiles(unsafePath, {})).toThrow(
      'Execution file path is not canonical',
    )
  })

  it('rejects workspace-scoped callbacks without invoking them', () => {
    let calls = 0
    const invalid = [{
      id: 'dynamic-workspace',
      scope: 'workspace',
      files: () => {
        calls += 1
        return { '/main.py': 'print("unsafe")' }
      },
    }] as unknown as IDEWorkspaceResourceContribution[]
    const expected = 'Workspace resource "dynamic-workspace" may use a files callback only with scope "execution-only"'

    expect(() => partitionWorkspaceResources(invalid)).toThrow(expected)
    expect(() => mergeWorkspaceFiles(invalid)).toThrow(expected)
    expect(() => mergeExecutionResourceFiles(invalid, {})).toThrow(expected)
    expect(calls).toBe(0)
  })

  it('applies exact and flattened collision rules to dynamic execution resources', () => {
    const resources: IDEWorkspaceResourceContribution[] = [{
      id: 'dynamic-support',
      scope: 'execution-only',
      files: () => ({ '/support.py': 'runtime content' }),
    }]

    expect(() => mergeExecutionResourceFiles(resources, {
      '/sysroot/support.py': 'provider content',
    })).toThrow(
      'Execution-only resource path "/sysroot/support.py" conflicts with an existing execution plan file',
    )
    expect(() => mergeExecutionResourceFiles(resources, {
      '/workspace/support.py': 'student content',
    })).toThrow(
      'Runtime file paths "/sysroot/support.py" and "/workspace/support.py" both flatten to "support.py"',
    )
  })

  it('rejects unsupported resource scopes at the runtime boundary', () => {
    const invalid = [{
      id: 'invalid-scope',
      scope: 'protected',
      files: { '/support.py': 'runtime content' },
    }] as unknown as IDEWorkspaceResourceContribution[]

    expect(() => partitionWorkspaceResources(invalid)).toThrow(
      'Workspace resource scope is not supported: "protected"',
    )
  })

  it('reports the exact path pair when resource planes collide after runtime flattening', () => {
    const { workspaceFiles, executionFiles } = partitionWorkspaceResources([
      {
        id: 'student',
        files: { '/lib/support.py': 'student content' },
      },
      {
        id: 'support',
        scope: 'execution-only',
        files: { '/lib/support.py': 'runtime content' },
      },
    ])
    expect(workspaceFiles).toBeDefined()
    expect(executionFiles).toBeDefined()
    expect(() => mergeExecutionResourceFiles([{
      id: 'support',
      scope: 'execution-only',
      files: { '/lib/support.py': 'runtime content' },
    }], workspaceFiles!)).toThrow(
      'Runtime file paths "/sysroot/lib/support.py" and "/workspace/lib/support.py" both flatten to "lib/support.py"',
    )
  })

  it('rejects exact execution-plan overlap instead of silently replacing a staged file', () => {
    const resources: IDEWorkspaceResourceContribution[] = [{
      id: 'runtime-support',
      scope: 'execution-only',
      files: {
        '/z-support.py': 'plugin z',
        '/a-support.py': 'plugin a',
      },
    }]

    expect(() => mergeExecutionResourceFiles(resources, {
      '/sysroot/z-support.py': 'provider z',
      '/sysroot/a-support.py': 'provider a',
    })).toThrow(
      'Execution-only resource path "/sysroot/a-support.py" conflicts with an existing execution plan file; use a distinct path',
    )
  })

  it('does not mistake nested workspace names for flattened cross-plane collisions', () => {
    expect(() => assertNoFlattenedRuntimePathCollisions({
      '/workspace/sysroot/support.py': 'student content',
      '/sysroot/support.py': 'runtime content',
    })).not.toThrow()
  })

  it('projects only canonical workspace files for persistence', () => {
    const persisted = projectPersistedWorkspaceFiles({
      '/workspace/main.py': 'print("student")',
      '/workspace/lib/helper.py': 'VALUE = 1',
      '/sysroot/support.py': 'runtime only',
      'ephemeral-runner.py': 'runtime only',
    })

    expect(persisted).toEqual({
      '/workspace/main.py': 'print("student")',
      '/workspace/lib/helper.py': 'VALUE = 1',
    })
    expect(Object.getPrototypeOf(persisted)).toBeNull()
    expect(() => projectPersistedWorkspaceFiles({
      '/workspace/../outside.py': 'unsafe',
    })).toThrow('not canonical')
  })

  it('stabilizes semantically identical seeds without hiding content changes', () => {
    expect(
      workspaceFilesFingerprint({ '/b.txt': 'b', '/a.txt': 'a' }),
    ).toBe(
      workspaceFilesFingerprint({ '/a.txt': 'a', '/b.txt': 'b' }),
    )
    expect(workspaceFilesFingerprint({ '/a.txt': 'first' })).not.toBe(
      workspaceFilesFingerprint({ '/a.txt': 'second' }),
    )
    expect(workspaceFilesFingerprint()).toBe('')
  })

  it('rejects traversal and safely carries special object-property names', () => {
    expect(() => mergeWorkspaceFiles([], {
      '/workspace/../outside.txt': 'no',
    })).toThrow('not canonical')

    const special = JSON.parse('{"/__proto__/resource.txt":"safe"}') as Record<string, string>
    const merged = mergeWorkspaceFiles([], special)!
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(Object.hasOwn(merged, '/workspace/__proto__/resource.txt')).toBe(true)
    expect(merged['/workspace/__proto__/resource.txt']).toBe('safe')

    expect(() => partitionWorkspaceResources([{
      id: 'unsafe-runtime',
      scope: 'execution-only',
      files: { '/sysroot/../outside.txt': 'no' },
    }])).toThrow('not canonical')

    const runtimeSpecial = partitionWorkspaceResources([{
      id: 'safe-runtime',
      scope: 'execution-only',
      files: JSON.parse('{"/__proto__/resource.txt":"safe"}') as Record<string, string>,
    }]).executionFiles!
    expect(Object.getPrototypeOf(runtimeSpecial)).toBeNull()
    expect(Object.hasOwn(runtimeSpecial, '/sysroot/__proto__/resource.txt')).toBe(true)
  })
})

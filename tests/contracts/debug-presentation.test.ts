import { describe, expect, it, vi } from 'vitest'
import { DebugPresentationService } from '../../src/web-ide/core/debug-presentation'
import { ContributionRegistry } from '../../src/web-ide/core/contribution-registry'
import { IDEPluginManager } from '../../src/web-ide/core/plugin-manager'
import type { DebugChildPage, DebugValueFormatter, DebugValueRef } from '../../src/web-ide/contracts/debug-presentation'
import type { DebugPauseState, RuntimeSession, VariableNode } from '../../src/web-ide/contracts/runtime'

const ref = (value: string) => value as DebugValueRef
function snapshot(value: VariableNode, revision = 0): DebugPauseState {
  return {
    debugSnapshot: { id: 'pause', revision }, line: 1, file: '/main.cpp', func: 'main', memorySnapshot: null,
    callStack: [{ id: '0', funcName: 'main', line: 1, isActive: true, variables: [value] }],
  }
}

const child: VariableNode = { debugRef: ref('child'), debugOrdinal: 100, name: '[100]', type: 'int', value: '42' }
const root: VariableNode = { debugRef: ref('root'), name: 'v', type: 'Vector<int>', value: '@12', childrenInfo: { total: 101, loaded: 0, complete: false }, members: [] }
const loaded: DebugChildPage = { children: [child], start: 100, total: 101, complete: true, availability: 'available' }

describe('shared debug presentations', () => {
  it('supports legacy raw-only providers and immutable metadata reads', async () => {
    const registry = new ContributionRegistry<DebugValueFormatter>()
    const service = new DebugPresentationService({} as RuntimeSession, registry)
    const legacy = { name: 'old', type: 'int', value: '7' }
    service.setSnapshot(snapshot(legacy))
    expect(await service.present(service.getRef(legacy))).toMatchObject({ kind: 'raw', summary: '7', children: [], complete: true })
    expect(Object.isFrozen(service.readValue(service.getRef(legacy)))).toBe(true)
    service.dispose()
  })

  it('shares page requests and resolutions between consumers, including sparse pages', async () => {
    const readDebugChildren = vi.fn(async () => loaded)
    const service = new DebugPresentationService({ readDebugChildren } as unknown as RuntimeSession, new ContributionRegistry())
    service.setSnapshot(snapshot(root))
    const page = { start: 100, count: 100 }
    const [left, right] = await Promise.all([service.present(root.debugRef!, page), service.present(root.debugRef!, page)])
    expect(left).toEqual(right)
    expect(readDebugChildren).toHaveBeenCalledTimes(1)
    expect(left.children).toEqual([{ key: '100', label: '[100]', value: child.debugRef }])
    expect(service.readValue(child.debugRef!)?.value).toBe('42')
    expect(service.getPresentation(root.debugRef!, page)).toBe(left)
    expect(Object.isFrozen(left.children)).toBe(true)
    expect(Object.isFrozen(left.children[0])).toBe(true)
    service.setSnapshot(snapshot({ ...root, members: [child], childrenInfo: { total: 101, loaded: 1, complete: false } }, 1))
    expect((await service.present(root.debugRef!, page)).children).toHaveLength(1)
    expect(readDebugChildren).toHaveBeenCalledTimes(1)
  })

  it('preserves captured heap-pointer expansion for legacy providers without native reads', async () => {
    const pointer: VariableNode = { name: 'p', type: 'Node *', value: '0x40', isPointer: true, pointsTo: 64 }
    const member: VariableNode = { name: 'data', type: 'int', value: '7' }
    const state = snapshot(pointer)
    state.memorySnapshot = { frames: state.callStack, heapAllocations: [
      { ptr: 64, size: 4, typeName: 'Node', label: 'Node', members: [member] },
    ] }
    const service = new DebugPresentationService({} as RuntimeSession, [])
    service.setSnapshot(state, false)
    const result = await service.present(service.getRef(pointer))
    expect(result).toMatchObject({ kind: 'raw', summary: '0x40', total: undefined, complete: false })
    expect(result.children).toEqual([{ key: '0', label: 'data', value: service.getRef(member) }])
    expect(service.readValue(service.getRef(pointer))?.members).toHaveLength(1)
    expect(pointer.members).toBeUndefined()
    service.dispose()
  })

  it('never reads uncaptured historical children or consults current native metadata', async () => {
    const readDebugChildren = vi.fn(async () => loaded)
    const readDebugValue = vi.fn(() => ({ ...root, value: 'NEW RUN' }))
    const service = new DebugPresentationService({ readDebugChildren, readDebugValue } as unknown as RuntimeSession, new ContributionRegistry())
    service.setSnapshot(snapshot(root), false)
    expect(await service.present(root.debugRef!, { start: 100, count: 100 })).toMatchObject({ complete: false, availability: 'partial', summary: '@12' })
    expect(readDebugChildren).not.toHaveBeenCalled()
    expect(readDebugValue).not.toHaveBeenCalled()
  })

  it('invalidates dependent presentations when raw revision or formatter registration changes', async () => {
    const registry = new ContributionRegistry<DebugValueFormatter>()
    const service = new DebugPresentationService({} as RuntimeSession, registry)
    service.setSnapshot(snapshot(child))
    const formatter = { id: 'test', matches: () => true, format: vi.fn((value: Readonly<VariableNode>) => ({ kind: 'scalar' as const, summary: `pretty ${value.value}`, children: [], start: 0, complete: true, availability: 'available' as const })) }
    const registration = registry.register(formatter)
    expect((await service.present(child.debugRef!)).summary).toBe('pretty 42')
    service.setSnapshot(snapshot({ ...child, value: '43' }, 1))
    expect(service.getPresentation(child.debugRef!)).toBeUndefined()
    expect((await service.present(child.debugRef!)).summary).toBe('pretty 43')
    registration.dispose()
    expect((await service.present(child.debugRef!)).kind).toBe('raw')
  })

  it('falls back to raw when a formatter rejects a layout and isolates instances', async () => {
    const formatter: DebugValueFormatter = { id: 'broken', matches: () => true, format: () => { throw new Error('unknown layout') } }
    const registry = new ContributionRegistry<DebugValueFormatter>()
    registry.register(formatter)
    const first = new DebugPresentationService({} as RuntimeSession, registry)
    const second = new DebugPresentationService({} as RuntimeSession, new ContributionRegistry())
    first.setSnapshot(snapshot(child))
    second.setSnapshot(snapshot({ ...child, value: 'other mount' }))
    expect((await first.present(child.debugRef!)).summary).toBe('42')
    expect((await second.present(child.debugRef!)).summary).toBe('other mount')
  })

  it('registers and disposes formatter contributions through the public plugin seams', () => {
    const formatter: DebugValueFormatter = { id: 'static', matches: () => false, format: () => undefined }
    const manager = new IDEPluginManager([{ id: 'formatter-plugin', contributes: { debugFormatters: [formatter] }, activate(context) { context.debugFormatters.register({ ...formatter, id: 'dynamic' }) } }])
    const activation = manager.activate()
    expect(manager.debugFormatters.getSnapshot().map((item) => item.id)).toEqual(['static', 'dynamic'])
    activation.dispose()
    expect(manager.debugFormatters.getSnapshot().map((item) => item.id)).toEqual(['static'])
    manager.dispose()
    expect(manager.debugFormatters.getSnapshot()).toEqual([])
  })

  it('bounds cyclic legacy trees and does not label an uncaptured structure empty', async () => {
    const cyclic: VariableNode = { name: 'cycle', type: 'Node', value: '', isStruct: true }
    cyclic.members = [cyclic]
    const service = new DebugPresentationService({} as RuntimeSession, [])
    service.setSnapshot(snapshot(cyclic))
    expect((await service.present(service.getRef(cyclic))).children).toHaveLength(1)
    const missing: VariableNode = { name: 'missing', type: 'Record', value: '', isStruct: true }
    service.setSnapshot(snapshot(missing))
    expect(await service.present(service.getRef(missing))).toMatchObject({ total: undefined, complete: false, availability: 'partial' })
    const emptyLegacy: VariableNode = { name: 'maybeEmpty', type: 'Vector<int>', value: '', isStruct: true, members: [] }
    service.setSnapshot(snapshot(emptyLegacy))
    expect(await service.present(service.getRef(emptyLegacy))).toMatchObject({ total: undefined, complete: false, availability: 'partial' })
    const large: VariableNode = { name: 'large', type: 'Record', value: '', members: Array.from({ length: 2000 }, (_, i) => ({ name: String(i), type: 'int', value: i })) }
    service.setSnapshot(snapshot(large))
    expect(service.readValue(service.getRef(large))?.members).toHaveLength(999)
  })

  it('rejects invented child identities and displays the reason for Raw fallback', async () => {
    const formatter: DebugValueFormatter = {
      id: 'invalid', matches: () => true,
      format: () => ({ kind: 'sequence', summary: 'invented', children: [{ key: 'x', label: 'x', value: ref('foreign') }], start: 0, complete: true, availability: 'available' }),
    }
    const service = new DebugPresentationService({} as RuntimeSession, [formatter])
    service.setSnapshot(snapshot(child))
    expect(await service.present(child.debugRef!)).toMatchObject({ kind: 'raw', message: expect.stringContaining('unsupported presentation') })
  })

  it('times out an unfinished formatter and prevents its late continuation from reading', async () => {
    vi.useFakeTimers()
    try {
      let continueFormatting!: () => void
      const readDebugChildren = vi.fn(async () => loaded)
      const formatter: DebugValueFormatter = {
        id: 'slow', matches: () => true,
        async format(value, context) {
          await new Promise<void>((resolve) => { continueFormatting = resolve })
          await context.readChildren(value.debugRef!, { start: 100, count: 100 })
          return undefined
        },
      }
      const service = new DebugPresentationService({ readDebugChildren } as unknown as RuntimeSession, [formatter])
      service.setSnapshot(snapshot(root))
      const presentation = service.present(root.debugRef!, { start: 100, count: 100 })
      await vi.advanceTimersByTimeAsync(1501)
      expect(await presentation).toMatchObject({ kind: 'raw', message: expect.stringContaining('could not finish') })
      expect(readDebugChildren).toHaveBeenCalledTimes(1)
      continueFormatting()
      await vi.advanceTimersByTimeAsync(1)
      expect(readDebugChildren).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('never publishes an old formatter result after a revision or registration change', async () => {
    let finish!: () => void
    const registry = new ContributionRegistry<DebugValueFormatter>()
    const registration = registry.register({ id: 'pending', matches: () => true, async format() {
      await new Promise<void>((resolve) => { finish = resolve })
      return { kind: 'scalar', summary: 'old', children: [], start: 0, complete: true, availability: 'available' }
    } })
    const service = new DebugPresentationService({} as RuntimeSession, registry)
    service.setSnapshot(snapshot(child))
    const old = service.present(child.debugRef!)
    await Promise.resolve()
    registration.dispose()
    service.setSnapshot(snapshot({ ...child, value: 'new' }, 1))
    expect((await service.present(child.debugRef!)).summary).toBe('new')
    finish()
    await old
    expect(service.getPresentation(child.debugRef!)?.summary).toBe('new')
  })
})

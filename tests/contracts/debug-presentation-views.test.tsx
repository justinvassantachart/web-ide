// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { VariablesPanel } from '../../src/components/debug/VariablesPanel'
import { VariableRow } from '../../src/components/debug/VariableRow'
import { DebugPresentationToggle } from '../../src/components/debug/DebugPresentationToggle'
import { createWorkbenchInstance, WorkbenchInstanceContext } from '../../src/web-ide/react/workbench-instance-context'
import { DebugPresentationContext } from '../../src/web-ide/react/debug-presentation-state'
import { DebugPresentationService } from '../../src/web-ide/core/debug-presentation'
import { createDebugStore } from '../../src/store/debug-store'
import type { DebugValueFormatter } from '../../src/web-ide/contracts/debug-presentation'
import type { DebugPauseState, RuntimeSession, VariableNode } from '../../src/web-ide/contracts/runtime'

const scalar = (name: string, value: number): VariableNode => ({ name, type: 'int', value })
function pause(id: string, revision = 0, variables: VariableNode[] = []): DebugPauseState {
  const callStack = [{ id: 'main', funcName: 'main', line: 1, isActive: true, variables }]
  return { line: 1, func: 'main', file: '/main.cpp', callStack,
    memorySnapshot: { frames: callStack, heapAllocations: [] }, debugSnapshot: { id, revision } }
}
const listFormatter: DebugValueFormatter = {
  id: 'test.sequence', matches: value => value.type === 'DemoList<int>',
  async format(value, context, page) {
    const children = await context.readChildren(value.debugRef!, page)
    return { kind: 'sequence', summary: `List (${children.total})`, start: page.start,
      total: children.total, complete: children.complete, availability: children.availability,
      children: children.children.map((child, i) => ({ key: String(page.start + i), label: `[${page.start + i}]`, value: child.debugRef! })) }
  },
}
let root: Root | undefined
const disposals: (() => void)[] = []
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  for (const dispose of disposals.splice(0)) dispose()
})
async function click(container: HTMLElement, name: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === name || button.textContent === name)
  expect(button, name).toBeDefined()
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('shares semantic rows, pages and Pretty/Raw preferences across view remounts', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const instance = createWorkbenchInstance()
  const list: VariableNode = { name: 'numbers', type: 'DemoList<int>', value: '{...}', isStruct: true,
    childrenInfo: { total: 101, loaded: 101, complete: true },
    members: Array.from({ length: 101 }, (_, i) => scalar(`raw-${i}`, i)) }
  const snapshot = pause('first', 0, [list])
  instance.debugStore.getState().pushHistoryState(snapshot)
  const service = new DebugPresentationService({} as RuntimeSession, [listFormatter])
  service.setSnapshot(snapshot, false)
  disposals.push(() => service.dispose(), () => instance.workspace.dispose())
  const container = document.createElement('div')
  root = createRoot(container)
  const render = async (variables: boolean) => act(async () => {
    root!.render(<WorkbenchInstanceContext.Provider value={instance}>
      <DebugPresentationContext.Provider value={service}>
        {variables ? <VariablesPanel /> : <><DebugPresentationToggle /><div role="tree"><VariableRow variable={list} depth={0} /></div></>}
      </DebugPresentationContext.Provider>
    </WorkbenchInstanceContext.Provider>)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await render(true)
  expect(container.textContent).toContain('List (101)')
  await click(container, 'Expand numbers')
  expect(container.textContent).toContain('Showing 100 of 101')
  expect(container.querySelectorAll('[data-debug-value]')).toHaveLength(101)
  await click(container, 'Load more values')
  expect(container.textContent).toContain('Showing 101 of 101')
  await render(false)
  expect(container.textContent).toContain('Showing 101 of 101')
  await click(container, 'Raw')
  await click(container, 'Expand numbers')
  expect(container.textContent).toContain('raw-0')
  await click(container, 'Pretty')
  expect(container.textContent).toContain('Showing 101 of 101')
  const button = container.querySelector('[aria-label="Collapse numbers"]')!
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  expect(container.querySelector('[aria-label="Expand numbers"]')).not.toBeNull()
  await render(true)
  expect(container.querySelector('[aria-label="Expand numbers"]')).not.toBeNull()
  expect(instance.debugStore.getState().stepHistory).toHaveLength(1)
})

describe('debugger capture history', () => {
  it('refreshes only the matching live stop and preserves selected immutable history', () => {
    const store = createDebugStore()
    const first = pause('first', 0, [scalar('x', 1)])
    const second = pause('second', 0, [scalar('x', 2)])
    store.getState().pushHistoryState(first)
    store.getState().pushHistoryState(second)
    store.getState().stepBack()
    const updated = pause('second', 1, [scalar('x', 2), scalar('y', 3)])
    store.getState().refreshHistoryState(updated)
    expect(store.getState().activePause).toBe(first)
    expect(store.getState().stepIndex).toBe(0)
    expect(store.getState().stepHistory).toEqual([first, updated])
    expect(second.callStack[0].variables).toHaveLength(1)
    store.getState().refreshHistoryState(pause('foreign', 10))
    store.getState().refreshHistoryState(second)
    expect(store.getState().stepHistory).toEqual([first, updated])
    store.getState().stepForward()
    expect(store.getState().activePause).toBe(updated)
    expect(store.getState().stepIndex).toBe(-1)
  })

  it('bounds retained nodes during refresh while preserving a selected earlier stop', () => {
    const store = createDebugStore()
    const values = Array.from({ length: 1000 }, (_, i) => scalar(`v${i}`, i))
    for (let i = 0; i < 20; i++) store.getState().pushHistoryState(pause(String(i), 0, values))
    store.getState().stepBack()
    const selected = store.getState().activePause
    store.getState().refreshHistoryState(pause('19', 1, [...values, scalar('more', 1)]))
    expect(store.getState().stepHistory).toHaveLength(19)
    expect(store.getState().activePause).toBe(selected)
    expect(store.getState().stepHistory[store.getState().stepIndex]).toBe(selected)
    expect(store.getState().stepHistory[0].debugSnapshot?.id).toBe('1')
  })

  it('keeps view choices independent between workbench instances and clears per-pause expansion', () => {
    const first = createDebugStore()
    const second = createDebugStore()
    first.getState().setPresentationMode('raw')
    first.getState().setValueExpanded('x', true)
    first.getState().showNextPage('x')
    expect(second.getState().presentationMode).toBe('pretty')
    expect(second.getState().expandedValues).toEqual({})
    first.getState().pushHistoryState(pause('new'))
    expect(first.getState().expandedValues).toEqual({})
    expect(first.getState().visiblePages).toEqual({})
    expect(first.getState().presentationMode).toBe('raw')
  })
})

it('stops at an incomplete page and counts only captured values', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const instance = createWorkbenchInstance()
  const list: VariableNode = { name: 'partial', type: 'DemoList<int>', value: '{...}', isStruct: true,
    childrenInfo: { total: 205, loaded: 120, complete: false }, availability: 'partial',
    members: Array.from({ length: 120 }, (_, i) => scalar(`raw-${i}`, i)) }
  const snapshot = pause('partial', 0, [list])
  instance.debugStore.getState().pushHistoryState(snapshot)
  const service = new DebugPresentationService({} as RuntimeSession, [listFormatter])
  service.setSnapshot(snapshot, false)
  disposals.push(() => service.dispose(), () => instance.workspace.dispose())
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root!.render(<WorkbenchInstanceContext.Provider value={instance}><DebugPresentationContext.Provider value={service}>
      <VariablesPanel />
    </DebugPresentationContext.Provider></WorkbenchInstanceContext.Provider>)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await click(container, 'Expand partial')
  await click(container, 'Load more values')
  expect(container.textContent).toContain('Showing 120 of 205')
  expect(container.textContent).not.toContain('Load more values')
  expect(container.textContent).not.toContain('Showing 200')
})

it('offers all captured pages from an older provider while keeping its total unknown', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const instance = createWorkbenchInstance()
  const list: VariableNode = { name: 'legacy', type: 'OldList', value: '{...}', isStruct: true,
    members: Array.from({ length: 205 }, (_, index) => scalar(String(index), index)) }
  const snapshot = pause('legacy', 0, [list])
  instance.debugStore.getState().pushHistoryState(snapshot)
  const service = new DebugPresentationService({} as RuntimeSession, [])
  service.setSnapshot(snapshot, false)
  disposals.push(() => service.dispose(), () => instance.workspace.dispose())
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root!.render(<WorkbenchInstanceContext.Provider value={instance}><DebugPresentationContext.Provider value={service}>
      <VariablesPanel />
    </DebugPresentationContext.Provider></WorkbenchInstanceContext.Provider>)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await click(container, 'Expand legacy')
  expect(container.textContent).toContain('100 captured')
  await click(container, 'Load more values')
  expect(container.textContent).toContain('200 captured')
  await click(container, 'Load more values')
  expect(container.textContent).toContain('205 captured')
  expect(container.textContent).toContain('the total is unknown')
  expect(container.textContent).not.toContain('not captured')
  expect(container.textContent).not.toContain('Load more values')
})

it('does not present an unavailable scope as having no variables', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const instance = createWorkbenchInstance()
  const snapshot = pause('limited')
  snapshot.callStack[0].variablesMessage = 'Variables unavailable or inspection limit reached.'
  instance.debugStore.getState().pushHistoryState(snapshot)
  const service = new DebugPresentationService({} as RuntimeSession, [])
  service.setSnapshot(snapshot, false)
  disposals.push(() => service.dispose(), () => instance.workspace.dispose())
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => root!.render(<WorkbenchInstanceContext.Provider value={instance}>
    <DebugPresentationContext.Provider value={service}><VariablesPanel /></DebugPresentationContext.Provider>
  </WorkbenchInstanceContext.Provider>))
  expect(container.textContent).toContain('Variables unavailable or inspection limit reached.')
  expect(container.textContent).not.toContain('No variables in scope')
})

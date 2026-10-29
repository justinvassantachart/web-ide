// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { MemoryVisualizer } from '../../src/components/debug/MemoryVisualizer'
import { createWorkbenchInstance, WorkbenchInstanceContext } from '../../src/web-ide/react/workbench-instance-context'
import { DebugPresentationContext } from '../../src/web-ide/react/debug-presentation-state'
import { DebugPresentationService } from '../../src/web-ide/core/debug-presentation'
import type { DebugPauseState, RuntimeSession, VariableNode } from '../../src/web-ide/contracts/runtime'

// Inspect the graph passed to ReactFlow without relying on jsdom layout.
vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: ({ edges }: { edges: Edge[] }) => <output>{JSON.stringify(edges)}</output>,
}))

it.each(['pretty', 'raw'] as const)('links an expanded reference to its caller object in %s mode', async mode => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const member: VariableNode = { name: 'a', type: 'int', value: '7', address: 64 }
  const reference: VariableNode = { name: 'cref', type: 'Compound&', typeKind: 'reference', isPointer: false,
    value: '@0x40', address: 128, pointsTo: 64, isStruct: true, members: [member] }
  const compound: VariableNode = { name: 'c', type: 'Compound', value: '@0x40', address: 64 }
  const callStack = [
    { id: 'callee', funcName: 'callee', line: 2, isActive: true, variables: [reference] },
    { id: 'caller', funcName: 'caller', line: 8, isActive: false, variables: [compound] },
  ]
  const snapshot: DebugPauseState = { line: 2, func: 'callee', file: '/main.cpp', callStack,
    memorySnapshot: { frames: callStack, heapAllocations: [] } }
  const instance = createWorkbenchInstance()
  const service = new DebugPresentationService({} as RuntimeSession, [])
  service.setSnapshot(snapshot, false)
  const referenceRef = service.getRef(reference)
  await service.present(referenceRef, { start: 0, count: 100 }, mode)
  instance.debugStore.getState().pushHistoryState(snapshot)
  instance.debugStore.getState().setPresentationMode(mode)
  instance.debugStore.getState().setValueExpanded(`${referenceRef}:${mode}`, true)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<WorkbenchInstanceContext.Provider value={instance}>
      <DebugPresentationContext.Provider value={service}><MemoryVisualizer /></DebugPresentationContext.Provider>
    </WorkbenchInstanceContext.Provider>))
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toMatchObject([
      { source: 'callee', sourceHandle: referenceRef, target: 'caller', targetHandle: `${service.getRef(compound)}-target` },
    ])
  } finally {
    await act(async () => root.unmount())
    service.dispose()
    instance.workspace.dispose()
  }
})

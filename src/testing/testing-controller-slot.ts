import type { IDETestingControllerV2 } from './testing-controller-v2'

export interface TestingV2ControllerSlot {
  snapshot(): IDETestingControllerV2 | undefined
  subscribe(listener: () => void): () => void
  attach(controller: IDETestingControllerV2): () => void
  whenAvailable(): Promise<IDETestingControllerV2>
  dispose(): void
}

export function createTestingV2ControllerSlot(): TestingV2ControllerSlot {
  let current: IDETestingControllerV2 | undefined
  const listeners = new Set<() => void>()
  const waiters = new Set<{
    resolve(controller: IDETestingControllerV2): void
    reject(error: Error): void
  }>()
  let disposed = false
  const publish = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-ide] Testing V2 controller observer failed', error)
      }
    }
  }
  return {
    snapshot: () => current,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attach(controller) {
      if (disposed) throw new Error('Testing V2 controller slot is disposed')
      if (current && current !== controller) {
        throw new Error('A Testing V2 controller is already attached to this workbench')
      }
      current = controller
      for (const waiter of [...waiters]) waiter.resolve(controller)
      waiters.clear()
      publish()
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        if (current === controller) {
          current = undefined
          publish()
        }
      }
    },
    whenAvailable() {
      if (disposed) return Promise.reject(new Error('Testing V2 controller slot is disposed'))
      return current
        ? Promise.resolve(current)
        : new Promise((resolve, reject) => waiters.add({ resolve, reject }))
    },
    dispose() {
      if (disposed) return
      disposed = true
      current = undefined
      for (const waiter of [...waiters]) {
        waiter.reject(new Error('Testing V2 controller slot was disposed before attachment'))
      }
      waiters.clear()
      listeners.clear()
    },
  }
}

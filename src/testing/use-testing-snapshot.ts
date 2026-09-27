import { useSyncExternalStore } from 'react'
import { useWorkbenchInstance } from '@/web-ide/react/workbench-instance-context'
import type { IDETestingSnapshotV2 } from './testing-controller-v2'
const EMPTY: IDETestingSnapshotV2 = Object.freeze({ state: 'idle', tests: [], events: [] })
const noSubscribe = () => () => undefined
const emptySnapshot = () => EMPTY
export function useTestingSnapshot() {
  const instance = useWorkbenchInstance()
  const controller = useSyncExternalStore(instance.testingV2.subscribe, instance.testingV2.snapshot, instance.testingV2.snapshot)
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.snapshot ?? emptySnapshot, controller?.snapshot ?? emptySnapshot)
  return { controller, snapshot }
}

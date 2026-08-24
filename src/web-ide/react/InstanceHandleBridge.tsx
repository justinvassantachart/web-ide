import { useImperativeHandle, type Ref } from 'react'
import type { WebIDEInstanceHandle } from '../contracts/instance'

export function InstanceHandleBridge({
  instanceRef,
  handle,
}: {
  instanceRef: Ref<WebIDEInstanceHandle>
  handle: WebIDEInstanceHandle
}) {
  useImperativeHandle(instanceRef, () => handle, [handle])
  return null
}

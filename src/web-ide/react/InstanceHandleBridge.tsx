import { useImperativeHandle, type Ref } from 'react'
import type { WebIDEInstanceHandle } from '../contracts/instance'
import { webIDEInstanceHandle } from '../core/instance-handle'

export function InstanceHandleBridge({
  instanceRef,
}: {
  instanceRef: Ref<WebIDEInstanceHandle>
}) {
  useImperativeHandle(instanceRef, () => webIDEInstanceHandle, [])
  return null
}

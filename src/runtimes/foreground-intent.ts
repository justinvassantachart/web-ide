import type { RuntimeSession } from '../web-ide/contracts/runtime'

// Package-internal scheduling bookkeeping. It never starts or promotes an engine job.
// Course wrappers preserve the public session identity while specializing prepare/warmup.
const observers = new WeakMap<RuntimeSession, () => void>()
export function registerRuntimeForegroundIntent(session: RuntimeSession, observe: () => void): () => void {
  observers.set(session, observe)
  return () => { if (observers.get(session) === observe) observers.delete(session) }
}
export function notifyRuntimeForegroundIntent(session: RuntimeSession): void {
  observers.get(session)?.()
}

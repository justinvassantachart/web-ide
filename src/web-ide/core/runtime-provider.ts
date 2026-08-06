import type { RuntimeProvider, RuntimeSession } from '../contracts/runtime'

/** Preserves a method-style provider's receiver while adapting it for React. */
export function createRuntimeSessionFactory(
  provider: RuntimeProvider,
): () => RuntimeSession {
  return () => provider.createSession()
}

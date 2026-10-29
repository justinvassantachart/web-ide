import * as host from 'web-ide/host'
import * as languageTools from 'web-ide/language-tools'
import * as plugins from 'web-ide/plugins'
import * as root from 'web-ide'
import * as runtimes from 'web-ide/runtimes'
import * as testing from 'web-ide/testing'

// A strict NodeNext compile of all documented TypeScript entrypoints proves
// that the installed declaration graph resolves without bundler-only behavior.
void [root, host, plugins, runtimes, testing, languageTools]

function registerBytes(session: root.RuntimeSession, opener: root.RuntimeHostDeviceOpener) {
  if (!session.registerHostDevice) throw new Error('Host byte devices are unavailable')
  return session.registerHostDevice(opener)
}
const byteOpener: root.RuntimeHostDeviceOpener = (device: root.RuntimeHostDevice) => {
  const unsubscribe = device.onData((bytes) => { void bytes.byteLength })
  void device.write(new Uint8Array([1, 2, 3]))
  void device.signal.aborted
  return unsubscribe
}
void [registerBytes, byteOpener]

// The formatter/plugin/service contract must compile from the packed public
// entrypoint without reaching into a private store or native debugger handle.
function presentationConsumer(session: root.RuntimeSession) {
  const formatter: root.DebugValueFormatter = {
    id: 'consumer.formatter',
    matches: value => value.type === 'ConsumerValue',
    async format(value, context, page) {
      if (!value.debugRef) return undefined
      const captured = context.readValue(value.debugRef)
      const children = await context.readChildren(value.debugRef, page)
      return {
        kind: 'record', summary: String(captured?.value ?? ''),
        start: children.start, total: children.total, complete: children.complete,
        availability: children.availability,
        children: children.children.flatMap(child => child.debugRef
          ? [{ key: child.debugRef, label: child.name, value: child.debugRef }] : []),
      }
    },
  }
  const plugin: root.IDEPlugin = { id: 'consumer.formatter-plugin', contributes: { debugFormatters: [formatter] } }
  return new root.DebugPresentationService(session, plugin.contributes!.debugFormatters!)
}
void presentationConsumer

// Warmup and statistics are supported optional public contracts. This checks
// their packed declarations without running a compiler during type checking.
const scopedCppProvider = runtimes.createCppRuntimeProvider({
  cpp: {
    scope: { projectId: 'consumer-project', accountId: 'consumer-account' },
    objectCache: true,
    retainWorker: true,
    cacheCompilerModule: true,
    idleTimeoutMs: 30_000,
    compilerLifetime: 'project',
  },
  preserveCompilerOnCancel: true,
  eagerCompilerReseedAfterStop: true,
})
async function warmupConsumer(session: root.RuntimeSession, handle: root.WebIDEInstanceHandle) {
  const plan = runtimes.buildRuntimeExecutionPlan({
    files: { '/workspace/main.cpp': 'int main() { return 0; }' },
    mode: 'run',
  })
  const warmupOptions: root.RuntimeWarmupOptions = { foregroundIntent: new AbortController().signal }
  const result: root.RuntimeWarmupResult | undefined = await session.warmup?.(plan, warmupOptions)
  const mountedResult: root.RuntimeWarmupResult | undefined = await handle.warmup?.()
  await session.cancelWarmupAndWait?.()
  await handle.cancelWarmup?.()
  const statistics: unknown = session.compilationStatistics?.()
  const mountedStatistics: unknown = handle.compilationStatistics?.()
  return { result, mountedResult, statistics, mountedStatistics }
}
void [scopedCppProvider, warmupConsumer]

for (const provider of [runtimes.cppRuntimeProvider, runtimes.pythonRuntimeProvider]) {
  const session = provider.createSession()
  const registration = registerBytes(session, byteOpener)
  registration.dispose()
  session.dispose?.()
}

async function compilerLifetimeConsumer(session: root.RuntimeSession, handle: root.WebIDEInstanceHandle) {
  const options: root.RuntimeStopOptions = { reason: 'user' }
  session.stop(options)
  await session.stopAndWait?.({ reason: 'superseded' })
  const prepared: root.RuntimeWarmupResult | undefined = await session.prepareCompiler?.()
  const capability: 1 | undefined = session.capabilities.compilerPreparation
  const join: 1 | undefined = session.capabilities.compileOnlyJoin
  const controller = new AbortController()
  const released: 'released' | 'cancelled' = await handle.releaseCompilerResources({ signal: controller.signal })
  await handle.suspendRuntime()
  await handle.resumeRuntime()
  await handle.shutdownRuntime()
  return { prepared, capability, join, released }
}
void compilerLifetimeConsumer

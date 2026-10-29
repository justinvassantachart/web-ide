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

for (const provider of [runtimes.cppRuntimeProvider, runtimes.pythonRuntimeProvider]) {
  const session = provider.createSession()
  const registration = registerBytes(session, byteOpener)
  registration.dispose()
  session.dispose?.()
}

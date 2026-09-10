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
  void device.signal.aborted
  return unsubscribe
}
void [registerBytes, byteOpener]

import type { RuntimeExecutionMode, RuntimeHostDevice, RuntimeOutcome, RuntimeSession } from 'web-ide'
import { cppRuntimeProvider, pythonRuntimeProvider } from 'web-ide/runtimes'

const size = 131109
const payload = Uint8Array.from({ length: size }, (_, index) => index % 251)
const encode = new TextEncoder()
const decode = new TextDecoder()
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const pythonSource = `import os, sys
before = input("before> ")
fd = os.open("/dev/debugger-sh-host", os.O_RDWR)
payload = bytes(i % 251 for i in range(${size}))
position = 0
while position < len(payload):
    position += os.write(fd, payload[position:])
answer = bytearray()
while len(answer) < len(payload):
    answer.extend(os.read(fd, min(8191, len(payload) - len(answer))))
assert answer == payload
os.close(fd)
after = input("after> ")
print("RESULT:" + before + ":" + after)
sys.stderr.write("stderr-independent\\n")
`
const cppSource = `#include <fcntl.h>
#include <unistd.h>
#include <iostream>
#include <string>
#include <vector>
int main() {
  std::string before, after;
  std::cout << "before> "; std::getline(std::cin, before);
  int fd = open("/dev/debugger-sh-host", O_RDWR);
  if (fd < 0) return 20;
  std::vector<unsigned char> payload(${size});
  for (size_t i = 0; i < payload.size(); ++i) payload[i] = i % 251;
  size_t position = 0;
  while (position < payload.size()) { auto n = write(fd, payload.data() + position, payload.size() - position); if (n <= 0) return 21; position += n; }
  std::vector<unsigned char> answer(payload.size()); position = 0;
  while (position < answer.size()) { auto n = read(fd, answer.data() + position, std::min<size_t>(8191, answer.size() - position)); if (n <= 0) return 22; position += n; }
  if (answer != payload) return 23;
  close(fd);
  std::cout << "after> "; std::getline(std::cin, after);
  std::cout << "RESULT:" << before << ":" << after << "\\n";
  std::cerr << "stderr-independent\\n";
  return 0;
}`

async function prepare(session: RuntimeSession, source: string, mode: RuntimeExecutionMode) {
  const file = session.languageIds.includes('python') ? '/workspace/main.py' : '/workspace/main.cpp'
  const result = await session.prepare({ files: { [file]: source }, mode })
  assert(result.success, result.errors.join('\n'))
  return file
}

async function exchange(session: RuntimeSession, mode: RuntimeExecutionMode, label: string) {
  let device: RuntimeHostDevice | undefined
  let closes = 0
  let output = ''
  let failure: unknown
  const ready = deferred<void>()
  let paused = deferred<void>()
  const prompting = deferred<void>()
  const bytes: number[] = []
  const registration = session.registerHostDevice!((opened) => {
    device = opened
    const unsubscribe = opened.onData((chunk) => {
      bytes.push(...chunk)
      if (bytes.length === size) ready.resolve()
    })
    return () => { closes += 1; unsubscribe() }
  })
  const stdout = session.events.stdout.subscribe((chunk) => { output += chunk; if (output.includes('before>')) prompting.resolve() })
  const stderr = session.events.stderr.subscribe((chunk) => { output += chunk; if (output.includes('before>')) prompting.resolve() })
  const pause = session.events.debugPaused.subscribe(() => { paused.resolve() })
  const source = session.languageIds.includes('python') ? pythonSource : cppSource
  const file = await prepare(session, source, mode)
  if (mode === 'debug') await session.setBreakpoints(file, [session.languageIds.includes('python') ? 14 : 19])
  const running = session.start({ mode })
  const completed = session.waitForSettlement!()
  await Promise.race([prompting.promise, completed.then((outcome) => { throw new Error(`input missing: ${JSON.stringify(outcome)} ${output}`) })])
  // Both lines are submitted at the first prompt. The device
  // response must never consume, echo, or reorder this terminal type-ahead.
  session.writeStdin!(`${label}-first`)
  session.writeStdin!('\r')
  session.writeStdin!(`${label}-second`)
  session.writeStdin!('\r')
  const first = await Promise.race([ready.promise.then(() => 'device'), completed.then((outcome) => { throw new Error(`device missing: ${JSON.stringify(outcome)} ${output}`) })])
  assert(first === 'device' && device, 'missing device')
  assert(bytes.length === size && bytes.every((value, index) => value === payload[index]), 'guest bytes changed')
  try { await device.write(payload) } catch (error) { failure = error }
  assert(!failure, `host write failed: ${String(failure)}`)
  if (mode === 'debug') {
    await Promise.race([paused.promise, completed.then((outcome) => { throw new Error(`pause missing: ${JSON.stringify(outcome)} ${output}`) })])
    paused = deferred<void>()
    await session.stepOver()
    await Promise.race([paused.promise, completed.then((outcome) => { throw new Error(`step pause missing: ${JSON.stringify(outcome)}`) })])
    await session.continueExecution()
  }
  await running
  const outcome = await completed
  assert(outcome.type === 'completed' && outcome.exitCode === 0, JSON.stringify(outcome))
  assert(output.includes(`RESULT:${label}-first:${label}-second`), `terminal input changed: ${output}`)
  assert(output.includes('stderr-independent'), 'stderr missing')
  assert(!output.includes(decode.decode(payload.subarray(40, 70))), 'device leaked to terminal')
  assert(device.signal.aborted && closes === 1, 'device cleanup missing')
  await device.write(encode.encode('stale')).then(() => { throw new Error('stale device accepted write') }, () => {})
  registration.dispose(); stdout(); stderr(); pause()
  await session.setBreakpoints(file, [])
}

async function stopAndRestart(session: RuntimeSession) {
  const python = session.languageIds.includes('python')
  const source = python
    ? 'import os\nfd = os.open("/dev/debugger-sh-host", os.O_RDWR)\nos.write(fd, b"waiting")\nos.read(fd, 1)\n'
    : '#include <fcntl.h>\n#include <unistd.h>\nint main() { int fd = open("/dev/debugger-sh-host", O_RDWR); write(fd, "waiting", 7); char c; read(fd, &c, 1); }\n'
  let opened: RuntimeHostDevice | undefined
  let closed = 0
  let ready = deferred<void>()
  const registration = session.registerHostDevice!((device) => {
    opened = device
    const unsubscribe = device.onData(() => ready.resolve())
    return () => { closed += 1; unsubscribe() }
  })
  await prepare(session, source, 'run')
  const first = session.start({ mode: 'run' })
  await ready.promise
  assert((await session.stopAndWait!()).type === 'stopped', 'stop outcome')
  await first
  assert(opened?.signal.aborted && closed === 1, 'stop cleanup')
  ready = deferred<void>()
  const second = session.start({ mode: 'run' })
  await ready.promise
  assert(!opened?.signal.aborted, 'restart reused aborted device')
  await session.disposeAndWait!()
  await second
  assert(opened?.signal.aborted && Number(closed) === 2, 'dispose cleanup')
  registration.dispose()
}

async function plainSession(python: boolean) {
  const session = (python ? pythonRuntimeProvider : cppRuntimeProvider).createSession()
  try {
    let output = ''
    session.events.stdout.subscribe((chunk) => { output += chunk })
    await prepare(session, python
      ? 'import os\ntry:\n    os.open("/dev/debugger-sh-host", os.O_RDWR)\n    raise AssertionError("device present")\nexcept OSError:\n    print("absent")\n'
      : '#include <fcntl.h>\n#include <iostream>\nint main() { if (open("/dev/debugger-sh-host", O_RDWR) >= 0) return 5; std::cout << "absent"; }', 'run')
    await session.start({ mode: 'run' })
    const outcome: RuntimeOutcome = await session.waitForSettlement!()
    assert(outcome.type === 'completed' && outcome.exitCode === 0 && output.includes('absent'), 'omitted-device regression')
  } finally { await session.disposeAndWait!() }
}

export function mountHostDeviceConsumer() {
  const button = document.createElement('button')
  button.textContent = 'Verify host byte devices'
  const output = document.createElement('pre')
  output.setAttribute('role', 'status')
  document.getElementById('root')!.replaceChildren(button, output)
  button.onclick = () => {
    button.disabled = true
    const report = (text: string) => { output.textContent += `${text}\n` }
    void (async () => {
      assert(crossOriginIsolated, 'consumer requires isolation')
      const sessions = [cppRuntimeProvider, pythonRuntimeProvider].map((provider) => provider.createSession())
      try {
        for (const [index, session] of sessions.entries()) {
          for (const mode of ['run', 'debug'] as const) {
            await exchange(session, mode, `instance-${index}-${mode}`)
            report(`${session.id}: ${mode} exchange/input/cleanup passed`)
          }
        }
        // Same canonical filenames in independent active sessions.
        const other = pythonRuntimeProvider.createSession()
        try {
          await Promise.all([exchange(sessions[1], 'run', 'left'), exchange(other, 'run', 'right')])
        } finally { await other.disposeAndWait!() }
        report('Two simultaneous Python instances passed')
        for (const session of sessions) await stopAndRestart(session)
        report('Stop/restart/dispose passed for C/C++ and Python')
        await plainSession(true); await plainSession(false)
        report('Omitted-device sessions passed')
        report('PASS')
      } finally { await Promise.all(sessions.map((session) => session.disposeAndWait!())) }
    })().catch((error: unknown) => { report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`) })
  }
}

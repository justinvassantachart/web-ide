import { createCppRuntimeProvider, createPythonRuntimeProvider } from 'web-ide/runtimes'
import type { RuntimeExecutionPlan, RuntimeHostDevice, RuntimeSession } from '../../src/web-ide/contracts/runtime'

const sessions: RuntimeSession[] = []
const state = { stdout: '', stderr: '', pauses: [] as unknown[], events: [] as string[], hostRequests: [] as number[][] }
let device: RuntimeHostDevice | undefined
const oldDevices: RuntimeHostDevice[] = []

const fixture = {
  state,
  async create(language: 'python' | 'cpp', host = false) {
    const provider = language === 'cpp'
      ? createCppRuntimeProvider({ backend: 'upstream', preserveCompilerOnCancel: true })
      : createPythonRuntimeProvider({ backend: 'upstream' })
    const session = provider.createSession()
    sessions.push(session)
    session.events.stdout.subscribe(text => { state.stdout += text; state.events.push(`out:${text}`) })
    session.events.stderr.subscribe(text => { state.stderr += text; state.events.push(`err:${text}`) })
    session.events.exit.subscribe(code => state.events.push(`exit:${code}`))
    session.events.debugPaused.subscribe(pause => state.pauses.push(pause))
    if (host) session.registerHostDevice?.(next => {
      if (device) oldDevices.push(device)
      device = next
      return next.onData(bytes => state.hostRequests.push([...bytes]))
    })
  },
  async run(plan: RuntimeExecutionPlan, breakpoints: Record<string, number[]> = {}) {
    const session = sessions.at(-1)!
    const prepared = await session.prepare(plan)
    if (!prepared.success) throw new Error(prepared.errors.join('\n'))
    for (const [file, lines] of Object.entries(breakpoints)) await session.setBreakpoints(file, lines)
    void session.start({ mode: plan.mode })
  },
  input: (text: string) => sessions.at(-1)!.writeStdin?.(text),
  stop: () => sessions.at(-1)!.stopAndWait?.(),
  outcome: () => sessions.at(-1)!.waitForSettlement?.(),
  continue: () => sessions.at(-1)!.continueExecution(),
  stepOver: () => sessions.at(-1)!.stepOver(),
  respond: (bytes: number[]) => device!.write(new Uint8Array(bytes)),
  staleResponse: async () => {
    try { await oldDevices.at(-1)!.write(new Uint8Array([99])); return 'accepted' }
    catch { return 'rejected' }
  },
  async dispose() { await Promise.all(sessions.splice(0).map(session => session.disposeAndWait?.())) },
}
Object.assign(window, { upstreamFixture: fixture })
document.querySelector('#ready')!.textContent = 'Runtime fixture ready'
export type UpstreamFixture = typeof fixture

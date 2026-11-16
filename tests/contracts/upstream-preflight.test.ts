import { EventEmitter } from 'node:events'
import type { Engine, Process } from 'debugger-sh-upstream'
import { describe, expect, it, vi } from 'vitest'
import { preflightUpstreamRuntime } from '../../src/runtimes/upstream-preflight'

class Probe {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { write: vi.fn() }
  private settle!: (result: { exitCode: number; killed: boolean }) => void
  private readonly completion = new Promise<{ exitCode: number; killed: boolean }>(resolve => { this.settle = resolve })
  readonly then = this.completion.then.bind(this.completion)
  readonly kill = vi.fn(() => this.finish(137, true))
  finish(exitCode = 0, killed = false) { this.settle({ exitCode, killed }) }
}

function fixture() {
  const probes: Probe[] = []
  const fs = { readDir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), remove: vi.fn() }
  const run = vi.fn(() => { const probe = new Probe(); probes.push(probe); return probe })
  const engine = { run, fs } as unknown as Engine
  return { engine, probes, run, fs }
}

describe('owned upstream runtime preflight', () => {
  it('uses isolated host commands, touches no guest files, and does not forward stdio', async () => {
    const { engine, probes, run, fs } = fixture()
    const signal = new AbortController().signal
    const onProcess = vi.fn<(process: Process) => void>()
    const python = preflightUpstreamRuntime(engine, 'python', signal, onProcess)
    expect(run.mock.calls[0]).toEqual(['python', ['-I', '-S', '-c', 'pass']])
    expect(onProcess).toHaveBeenCalledWith(probes[0])
    expect(probes[0].stdout.eventNames()).toEqual([])
    expect(probes[0].stdin.write).not.toHaveBeenCalled()
    probes[0].stderr.emit('data', new TextEncoder().encode('runtime could not load: guest-like text is not a classifier'))
    probes[0].finish()
    await expect(python).resolves.toBeUndefined()
    expect(probes[0].stderr.listenerCount('data')).toBe(0)
    await expect(preflightUpstreamRuntime(engine, 'python', signal, onProcess)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
    expect(onProcess).toHaveBeenCalledOnce()

    const cpp = preflightUpstreamRuntime(engine, 'c', signal, onProcess)
    expect(run.mock.calls[1]).toEqual(['clang', ['--version'], { sysroot: 'cpp' }])
    probes[1].finish()
    await expect(cpp).resolves.toBeUndefined()
    for (const operation of Object.values(fs)) expect(operation).not.toHaveBeenCalled()
    const replacement = fixture()
    const next = preflightUpstreamRuntime(replacement.engine, 'python', signal, onProcess)
    expect(replacement.run).toHaveBeenCalledOnce()
    replacement.probes[0].finish()
    await next
  })

  it('classifies only failure of its known-zero probe and permits a later retry', async () => {
    const { engine, probes } = fixture()
    const signal = new AbortController().signal
    const failed = preflightUpstreamRuntime(engine, 'python', signal, () => {})
    probes[0].stderr.emit('data', new TextEncoder().encode('Download unavailable'))
    probes[0].finish(127)
    await expect(failed).resolves.toEqual({
      type: 'error', error: { type: 'EngineLoadError', message: 'Could not load the Python runtime: Download unavailable' },
    })
    const retry = preflightUpstreamRuntime(engine, 'python', signal, () => {})
    expect(probes).toHaveLength(2)
    probes[1].finish()
    await expect(retry).resolves.toBeUndefined()
    await expect(preflightUpstreamRuntime(engine, 'python', signal, () => {})).resolves.toBeUndefined()
    expect(probes).toHaveLength(2)
  })

  it('bounds captured stderr and cleans up listeners after a failed probe', async () => {
    const { engine, probes } = fixture()
    const result = preflightUpstreamRuntime(engine, 'c', new AbortController().signal, () => {})
    probes[0].stderr.emit('data', new TextEncoder().encode('x'.repeat(20_000)))
    probes[0].stderr.emit('data', new TextEncoder().encode('must not be retained'))
    probes[0].finish(126)
    await expect(result).resolves.toEqual({
      type: 'error', error: { type: 'EngineLoadError', message: `Could not load the C++ runtime: ${'x'.repeat(8192)}` },
    })
    expect(probes[0].stderr.listenerCount('data')).toBe(0)
  })

  it('does not start or reuse a cached probe for an already-stopped operation', async () => {
    const { engine, run, probes } = fixture()
    const controller = new AbortController()
    controller.abort()
    const onProcess = vi.fn()
    await expect(preflightUpstreamRuntime(engine, 'python', controller.signal, onProcess)).resolves.toEqual({ type: 'stopped' })
    expect(run).not.toHaveBeenCalled()
    expect(onProcess).not.toHaveBeenCalled()
    const ready = preflightUpstreamRuntime(engine, 'python', new AbortController().signal, onProcess)
    probes[0].finish()
    await ready
    await expect(preflightUpstreamRuntime(engine, 'python', controller.signal, onProcess)).resolves.toEqual({ type: 'stopped' })
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(['during', 'settlement', 'killed'] as const)('never caches a cancelled probe at %s', async boundary => {
    const { engine, probes } = fixture()
    const controller = new AbortController()
    const result = preflightUpstreamRuntime(engine, 'python', controller.signal, process => {
      controller.signal.addEventListener('abort', () => process.kill(), { once: true })
    })
    if (boundary === 'during') controller.abort()
    else if (boundary === 'settlement') { probes[0].finish(); controller.abort() }
    else probes[0].kill()
    await expect(result).resolves.toEqual({ type: 'stopped' })
    expect(probes[0].stderr.listenerCount('data')).toBe(0)
    const retry = preflightUpstreamRuntime(engine, 'python', new AbortController().signal, () => {})
    expect(probes).toHaveLength(2)
    probes[1].finish()
    await expect(retry).resolves.toBeUndefined()
  })

  it('turns a thrown load failure into the same host outcome without caching it', async () => {
    const { engine, run, probes } = fixture()
    const signal = new AbortController().signal
    run.mockImplementationOnce(() => { throw new Error('Worker failed to load') })
    await expect(preflightUpstreamRuntime(engine, 'c', signal, () => {})).resolves.toEqual({
      type: 'error', error: { type: 'EngineLoadError', message: 'Could not load the C++ runtime: Worker failed to load' },
    })
    const retry = preflightUpstreamRuntime(engine, 'c', signal, () => {})
    probes[0].finish()
    await expect(retry).resolves.toBeUndefined()
  })
})

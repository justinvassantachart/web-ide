import { spawn } from 'node:child_process'

const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 16 * 1024 * 1024
const TERMINATION_GRACE_MS = 2_000
const PROCESS_GROUP_POLL_MS = 20

function positiveBoundedInteger(value, fallback, location) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 64 * 1024 * 1024) {
    throw new TypeError(`${location} must be a positive bounded integer`)
  }
  return selected
}

function terminateProcessTree(child, signal) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function processGroupExists(child) {
  if (child.pid === undefined) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

async function waitForProcessGroupExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS))
  }
  return true
}

export function createProcessGroupController(child) {
  let terminationPromise
  const terminateAndSettle = () => {
    terminationPromise ??= (async () => {
      terminateProcessTree(child, 'SIGTERM')
      if (await waitForProcessGroupExit(child, TERMINATION_GRACE_MS)) return
      terminateProcessTree(child, 'SIGKILL')
      if (!await waitForProcessGroupExit(child, TERMINATION_GRACE_MS)) {
        throw new Error(`Process group ${String(child.pid)} remained alive after SIGKILL`)
      }
    })()
    return terminationPromise
  }
  return {
    terminateAndSettle,
    async ensureEmptyAfterClose() {
      if (terminationPromise) {
        await terminationPromise
        return false
      }
      if (!processGroupExists(child)) return false
      await terminateAndSettle()
      return true
    },
  }
}

export async function run(command, arguments_, options = {}) {
  return await new Promise((resolve, reject) => {
    const timeoutMs = positiveBoundedInteger(
      options.timeoutMs,
      DEFAULT_PROCESS_TIMEOUT_MS,
      'Process timeout',
    )
    const maximumStdoutBytes = positiveBoundedInteger(
      options.maxStdoutBytes,
      DEFAULT_MAXIMUM_OUTPUT_BYTES,
      'Maximum stdout bytes',
    )
    const maximumStderrBytes = positiveBoundedInteger(
      options.maxStderrBytes,
      DEFAULT_MAXIMUM_OUTPUT_BYTES,
      'Maximum stderr bytes',
    )
    const processGroupControllerFactory = options.processGroupControllerFactory
      ?? createProcessGroupController
    if (typeof processGroupControllerFactory !== 'function') {
      throw new TypeError('Process-group controller factory must be a function')
    }
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const processGroup = processGroupControllerFactory(child)
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminationError
    let spawnError
    let complete = false
    let terminationSettlement

    const terminate = (error) => {
      if (terminationError || complete) return
      terminationError = error
      terminationSettlement = processGroup.terminateAndSettle()
      terminationSettlement.catch((settlementError) => {
        if (complete) return
        clearTimeout(timer)
        reject(new AggregateError(
          [terminationError, settlementError],
          `Process termination settlement failed: ${settlementError.message}`,
        ))
      })
    }
    const timer = setTimeout(() => {
      terminate(new Error(`${command} exceeded the ${String(timeoutMs)}ms process timeout`))
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk)
      stdoutBytes += bytes.length
      if (stdoutBytes > maximumStdoutBytes) {
        terminate(new Error(`${command} exceeded the ${String(maximumStdoutBytes)}-byte stdout limit`))
        return
      }
      stdout.push(bytes)
      if (options.inherit) process.stdout.write(bytes)
    })
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk)
      stderrBytes += bytes.length
      if (stderrBytes > maximumStderrBytes) {
        terminate(new Error(`${command} exceeded the ${String(maximumStderrBytes)}-byte stderr limit`))
        return
      }
      stderr.push(bytes)
      if (options.inherit) process.stderr.write(bytes)
    })
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code, signal) => {
      complete = true
      clearTimeout(timer)
      void (async () => {
        let residualProcessGroup = false
        try {
          residualProcessGroup = await processGroup.ensureEmptyAfterClose()
        } catch (settlementError) {
          if (terminationError) {
            throw new AggregateError(
              [terminationError, settlementError],
              'Process failed and its process group could not be settled',
            )
          }
          throw settlementError
        }
        if (terminationSettlement) await terminationSettlement
        const stdoutText = Buffer.concat(stdout).toString('utf8')
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (terminationError) throw terminationError
        if (spawnError) throw spawnError
        if (residualProcessGroup) {
          throw new Error(`${command} left residual process-group members after exit`)
        }
        if (code !== 0) {
          throw new Error(
            `${command} ${arguments_.join(' ')} failed (${signal ?? code})\n${stderrText.trimEnd()}`,
          )
        }
        resolve({ stdout: stdoutText, stderr: stderrText })
      })().catch(reject)
    })
  })
}

export async function settleOperations(operations, label = 'Concurrent operations') {
  const results = await Promise.allSettled(operations)
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label} failed`,
    )
  }
  return results.map((result) => result.value)
}

export async function git(arguments_, options = {}) {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git'
  return await run(executable, arguments_, options)
}

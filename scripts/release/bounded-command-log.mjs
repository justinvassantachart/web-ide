import { spawn } from 'node:child_process'
import { open, rm } from 'node:fs/promises'

import { createProcessGroupController } from './process-utils.mjs'

function positiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${location} must be a positive safe integer`)
  }
  return value
}

export async function runBoundedCommandLog({
  command,
  arguments: arguments_,
  cwd,
  env,
  outputPath,
  maximumBytes,
  timeoutMs,
  footerForSuccessfulExit,
  processGroupControllerFactory = createProcessGroupController,
}) {
  positiveInteger(maximumBytes, 'Maximum command-log bytes')
  positiveInteger(timeoutMs, 'Command-log timeout')
  if (typeof processGroupControllerFactory !== 'function') {
    throw new TypeError('Command-log process-group controller factory must be a function')
  }
  const handle = await open(outputPath, 'wx', 0o600)
  let successful = false
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const processGroup = processGroupControllerFactory(child)
      let bytesWritten = 0
      let writeFailure
      let writeChain = Promise.resolve()
      let terminationFailure
      let spawnFailure
      let closed = false
      let terminationSettlement

      const terminate = (error) => {
        if (terminationFailure || closed) return
        terminationFailure = error
        terminationSettlement = processGroup.terminateAndSettle()
        terminationSettlement.catch((settlementError) => {
          if (closed) return
          clearTimeout(timer)
          void writeChain.then(() => {
            reject(new AggregateError(
              [terminationFailure, settlementError],
              `Command-log termination settlement failed: ${settlementError.message}`,
            ))
          }, (writeError) => {
            reject(new AggregateError(
              [terminationFailure, settlementError, writeError],
              `Command-log termination and write settlement failed: ${settlementError.message}`,
            ))
          })
        })
      }

      const writeChunk = (chunk) => {
        if (terminationFailure || writeFailure) return
        const bytes = Buffer.from(chunk)
        if (bytesWritten + bytes.length > maximumBytes) {
          terminate(new Error(`${command} exceeded the ${String(maximumBytes)}-byte command-log limit`))
          return
        }
        bytesWritten += bytes.length
        writeChain = writeChain.then(async () => {
          await handle.write(bytes)
        }).catch((error) => {
          writeFailure = error
          terminate(new Error(`${command} command-log write failed`, { cause: error }))
        })
      }

      child.stdout.on('data', writeChunk)
      child.stderr.on('data', writeChunk)
      child.on('error', (error) => { spawnFailure = error })
      const timer = setTimeout(() => {
        terminate(new Error(`${command} exceeded the ${String(timeoutMs)}ms command-log timeout`))
      }, timeoutMs)
      timer.unref()

      child.on('close', (code, signal) => {
        closed = true
        clearTimeout(timer)
        void (async () => {
          await writeChain
          let residualProcessGroup = false
          try {
            residualProcessGroup = await processGroup.ensureEmptyAfterClose()
          } catch (settlementError) {
            if (terminationFailure) {
              throw new AggregateError(
                [terminationFailure, settlementError],
                'Command-log process failed and its process group could not be settled',
              )
            }
            throw settlementError
          }
          if (terminationSettlement) await terminationSettlement
          if (terminationFailure) throw terminationFailure
          if (writeFailure) throw writeFailure
          if (spawnFailure) throw spawnFailure
          if (residualProcessGroup) {
            throw new Error(`${command} left residual process-group members after exit`)
          }
          if (signal || code === null) {
            throw new Error(`Command-log process terminated by ${signal ?? 'unknown signal'}`)
          }
          if (code !== 0) throw new Error(`${command} failed with exit code ${String(code)}`)
          if (footerForSuccessfulExit) {
            const footer = Buffer.from(await footerForSuccessfulExit(code))
            if (bytesWritten + footer.length > maximumBytes) {
              throw new Error(`${command} receipt exceeds the ${String(maximumBytes)}-byte command-log limit`)
            }
            await handle.write(footer)
            bytesWritten += footer.length
          }
          resolve({ exitCode: code, size: bytesWritten })
        })().catch(reject)
      })
    })
    await handle.sync()
    successful = true
    return result
  } finally {
    await handle.close()
    if (!successful) await rm(outputPath, { force: true })
  }
}

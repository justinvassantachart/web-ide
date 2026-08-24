// @vitest-environment jsdom

import { StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SourcePresentationController } from '../../src/web-ide/core/source-presentation'
import type { IDESourcePresentationOwner } from '../../src/web-ide/contracts/source-presentation'
import {
  SourcePresentationContext,
  useSourcePresentationOwner,
} from '../../src/web-ide/react/source-presentation-state'
import { SourcePresentationProvider } from '../../src/web-ide/react/source-presentation-context'
import { initVFS } from '../../src/vfs/volume'

const MAIN = '/workspace/main.py'
let root: Root | undefined

function OwnerProbe() {
  const source = useSourcePresentationOwner()

  useEffect(() => {
    source.replaceDecorations([{ path: MAIN, line: 1, kind: 'current' }])
  }, [source])

  return null
}

let capturedOwner: IDESourcePresentationOwner | undefined

function CaptureOwner() {
  const source = useSourcePresentationOwner()
  useEffect(() => {
    capturedOwner = source
    return () => {
      if (capturedOwner === source) capturedOwner = undefined
    }
  }, [source])
  return null
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = undefined
  }
  capturedOwner = undefined
})

describe('source presentation React ownership', () => {
  it('balances Strict Mode probes and sequential contribution mounts exactly', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    const controller = new SourcePresentationController({
      readVisibleSource: (path) => path === MAIN ? 'print("safe")' : undefined,
      onReveal: vi.fn(),
    })
    const createOwner = vi.spyOn(controller, 'createOwner')
    const container = document.createElement('div')

    const mount = async () => {
      root = createRoot(container)
      await act(async () => {
        root?.render(
          <StrictMode>
            <SourcePresentationContext.Provider
              value={{ controller, revealRequest: null }}
            >
              <OwnerProbe />
            </SourcePresentationContext.Provider>
          </StrictMode>,
        )
        await Promise.resolve()
      })
    }
    const unmount = async () => {
      await act(async () => {
        root?.unmount()
        await Promise.resolve()
      })
      root = undefined
    }

    await mount()
    expect(createOwner).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().decorations).toEqual([
      { path: MAIN, line: 1, kind: 'current' },
    ])

    await unmount()
    expect(controller.getSnapshot().decorations).toEqual([])

    await mount()
    expect(createOwner).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().decorations).toHaveLength(1)

    await unmount()
    expect(controller.getSnapshot().decorations).toEqual([])
    controller.dispose()
  })

  it('rejects directories and current-file positions past EOF or EOL', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    await initVFS({
      projectId: 'source-position-validation',
      ephemeral: true,
      initialFiles: {
        [MAIN]: 'print("safe")',
        '/workspace/folder/child.py': 'pass',
      },
    })
    const container = document.createElement('div')
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <StrictMode>
          <SourcePresentationProvider
            key="source-position-validation"
            workspaceKey="source-position-validation"
          >
            <CaptureOwner />
          </SourcePresentationProvider>
        </StrictMode>,
      )
      await Promise.resolve()
    })

    expect(capturedOwner).toBeDefined()
    expect(() => capturedOwner?.reveal({ path: '/workspace/folder', line: 1 }))
      .toThrow(/not a visible workspace resource/)
    expect(() => capturedOwner?.reveal({ path: MAIN, line: 2 }))
      .toThrow(/outside/)
    expect(() => capturedOwner?.reveal({ path: MAIN, line: 1, column: 15 }))
      .toThrow(/outside/)
    expect(() => capturedOwner?.replaceDecorations([
      { path: MAIN, line: 1, column: 14, kind: 'error' },
    ])).not.toThrow()

    const staleOwner = capturedOwner!
    await act(async () => {
      root?.render(
        <StrictMode>
          <SourcePresentationProvider
            key="replacement-workspace"
            workspaceKey="replacement-workspace"
          >
            <CaptureOwner />
          </SourcePresentationProvider>
        </StrictMode>,
      )
      await Promise.resolve()
    })
    expect(capturedOwner).not.toBe(staleOwner)
    expect(() => staleOwner.clearDecorations()).toThrow(/no longer active/)
  })
})

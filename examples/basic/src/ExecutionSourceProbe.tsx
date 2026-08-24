import { useState, type CSSProperties } from 'react'
import type {
  IDEPanelServices,
  IDESourceDecorationKind,
  IDESourceLocation,
} from 'web-ide'

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  height: '100%',
  padding: 12,
  color: 'var(--color-foreground)',
  background: 'var(--color-background)',
}

const buttonStyle: CSSProperties = {
  padding: '7px 9px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-chrome)',
  color: 'var(--color-foreground)',
  textAlign: 'left',
}

export function ExecutionSourceProbe({
  execution,
  source,
}: IDEPanelServices) {
  const [status, setStatus] = useState('Ready for contributed controls')
  const report = (message: string) => {
    setStatus((current) => `${current} → ${message}`)
  }

  const present = (
    kind: IDESourceDecorationKind,
    location: IDESourceLocation,
  ) => {
    source.replaceDecorations([{ ...location, kind }])
    source.reveal(location)
    report(`Presented ${kind}: ${location.path}:${location.line}`)
  }

  const run = async () => {
    report('Starting through contributed execution controller…')
    await execution.start('run')
    report('Contributed execution request settled')
  }

  const debug = async () => {
    report('Starting debug through contributed execution controller…')
    await execution.start('debug')
    report('Contributed debug request settled')
  }

  const stop = async () => {
    report('Stopping through contributed execution controller…')
    await execution.stop()
    report('Contributed stop request settled')
  }

  return (
    <section aria-label="Execution and source probe" style={panelStyle}>
      <strong>Execution + source</strong>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--color-muted-foreground)' }}>
        Public activity services only—no editor or store access.
      </p>
      <button type="button" style={buttonStyle} onClick={() => void run()}>
        Run from activity
      </button>
      <button type="button" style={buttonStyle} onClick={() => void debug()}>
        Debug from activity
      </button>
      <button type="button" style={buttonStyle} onClick={() => void stop()}>
        Stop from activity
      </button>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => present('current', { path: '/workspace/helpers.py', line: 2 })}
      >
        Present current helper line
      </button>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => present('historical', { path: '/workspace/main.py', line: 4 })}
      >
        Present historical main line
      </button>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => present('error', { path: '/workspace/main.py', line: 8 })}
      >
        Present error main line
      </button>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => {
          source.clearDecorations()
          report('Source decorations cleared')
        }}
      >
        Clear source presentation
      </button>
      <output aria-live="polite" style={{ fontSize: 12 }}>
        {status}
      </output>
    </section>
  )
}

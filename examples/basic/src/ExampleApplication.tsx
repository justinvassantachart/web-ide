import { useRef, useState } from 'react'
import {
  WebIDE,
  WebIDEHostProvider,
  type WebIDEConfiguration,
  type WebIDEHost,
  type WebIDEInstanceHandle,
} from 'web-ide'

export function ExampleApplication({
  configuration,
  host,
  lifecycleEvents,
  showLifecycleProbe,
}: {
  configuration: WebIDEConfiguration
  host: WebIDEHost
  lifecycleEvents: string[]
  showLifecycleProbe: boolean
}) {
  const instanceRef = useRef<WebIDEInstanceHandle>(null)
  const [lifecycleStatus, setLifecycleStatus] = useState('Ready for host inspection')

  const inspectPersistedFiles = () => {
    const files = instanceRef.current?.persistedFiles() ?? {}
    const paths = Object.keys(files).sort()
    const executionResourceAbsent = !paths.some((path) => path.includes('protected_support'))
    setLifecycleStatus(
      `Persisted: ${paths.join(', ') || '(empty)'}; execution-only absent: ${executionResourceAbsent}`,
    )
  }

  const closeWorkspace = async () => {
    setLifecycleStatus('Closing workspace…')
    try {
      await instanceRef.current?.close()
      setLifecycleStatus(`Closed: ${lifecycleEvents.join(' → ') || 'no persistence adapter'}`)
    } catch (error) {
      setLifecycleStatus(
        `Close failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return (
    <WebIDEHostProvider host={host}>
      <div style={{ width: '100vw', height: '100vh' }}>
        <WebIDE ref={instanceRef} configuration={configuration} />
      </div>
      {showLifecycleProbe && (
        <section
          aria-label="Host workspace lifecycle"
          style={{
            position: 'fixed',
            right: 12,
            top: 52,
            zIndex: 100,
            width: 360,
            padding: 12,
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            background: 'var(--color-background)',
            color: 'var(--color-foreground)',
            boxShadow: '0 8px 24px rgb(0 0 0 / 35%)',
          }}
        >
          <strong>Host lifecycle probe</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={inspectPersistedFiles}>
              Inspect persisted files
            </button>
            <button type="button" onClick={() => void closeWorkspace()}>
              Save and close workspace
            </button>
          </div>
          <output aria-live="polite" style={{ display: 'block', marginTop: 8 }}>
            {lifecycleStatus}
          </output>
        </section>
      )}
    </WebIDEHostProvider>
  )
}

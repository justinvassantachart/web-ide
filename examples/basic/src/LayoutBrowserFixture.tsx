import { Component, useState, type ReactNode } from 'react'
import {
  WebIDE,
  WebIDEHostProvider,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'

export type LayoutBrowserMode =
  | 'custom'
  | 'invalid'
  | 'multiple'
  | 'remount'
  | 'unavailable'

function workspaceHost(host: WebIDEHost, id: string): WebIDEHost {
  if (!host.workspace) return host
  return {
    ...host,
    workspace: {
      ...host.workspace,
      id,
      localCache: 'memory',
    },
  }
}

class LayoutErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.message) {
      return <p role="alert">Layout configuration rejected: {this.state.message}</p>
    }
    return this.props.children
  }
}

function WorkbenchFixture({
  label,
  configuration,
  host,
  mountKey,
}: {
  label: string
  configuration: WebIDEConfiguration
  host: WebIDEHost
  mountKey?: number
}) {
  return (
    <section
      aria-label={label}
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, position: 'relative' }}
    >
      <WebIDEHostProvider host={host}>
        <WebIDE key={mountKey} configuration={configuration} />
      </WebIDEHostProvider>
    </section>
  )
}

export function LayoutBrowserFixture({
  mode,
  configuration,
  host,
}: {
  mode: LayoutBrowserMode
  configuration: WebIDEConfiguration
  host: WebIDEHost
}) {
  const [mountKey, setMountKey] = useState(0)

  if (mode === 'invalid' || mode === 'unavailable') {
    const invalidConfiguration: WebIDEConfiguration = {
      ...configuration,
      initialLayout: {
        selectedPanelId: mode === 'invalid' ? 'fixture.unknown-panel' : 'graph',
      },
    }
    return (
      <LayoutErrorBoundary>
        <WorkbenchFixture
          label={mode === 'invalid' ? 'Invalid layout workbench' : 'Unavailable layout workbench'}
          configuration={invalidConfiguration}
          host={workspaceHost(host, 'layout-invalid')}
        />
      </LayoutErrorBoundary>
    )
  }

  if (mode === 'multiple') {
    const firstConfiguration: WebIDEConfiguration = {
      ...configuration,
      initialLayout: {
        selectedPanelId: 'variables',
        panelColumnPercent: 35,
        panelContentPercent: 60,
      },
    }
    const secondConfiguration: WebIDEConfiguration = {
      ...configuration,
      initialLayout: {
        selectedPanelId: 'canvas',
        panelColumnPercent: 50,
        panelContentPercent: 85,
      },
    }
    return (
      <main
        aria-label="Multiple layout workbenches"
        style={{ width: '100vw', height: '100vh', display: 'grid', gridTemplateColumns: '1fr 1fr' }}
      >
        <WorkbenchFixture
          label="First workbench"
          configuration={firstConfiguration}
          host={workspaceHost(host, 'layout-first')}
        />
        <WorkbenchFixture
          label="Second workbench"
          configuration={secondConfiguration}
          host={workspaceHost(host, 'layout-second')}
        />
      </main>
    )
  }

  const customConfiguration: WebIDEConfiguration = {
    ...configuration,
    initialLayout: {
      selectedPanelId: 'canvas',
      panelColumnPercent: 50,
      panelContentPercent: 85,
    },
  }

  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <WorkbenchFixture
        label={mode === 'remount' ? 'Remount workbench' : 'Custom layout workbench'}
        configuration={customConfiguration}
        host={workspaceHost(host, `layout-${mode}-${mountKey}`)}
        mountKey={mountKey}
      />
      {mode === 'remount' && (
        <button
          type="button"
          onClick={() => setMountKey((current) => current + 1)}
          style={{ position: 'fixed', zIndex: 100, left: 52, top: 52 }}
        >
          Remount workbench
        </button>
      )}
    </main>
  )
}

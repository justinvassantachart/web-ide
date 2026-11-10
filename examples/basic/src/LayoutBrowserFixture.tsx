import { Component, useState, type ReactNode } from 'react'
import {
  WebIDE,
  SourceEditor,
  WebIDEHostProvider,
  type IDEPlugin,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'

export type LayoutBrowserMode =
  | 'redesign'
  | 'source-editor'
  | 'custom'
  | 'invalid'
  | 'invalid-activity'
  | 'multiple'
  | 'remount'
  | 'unavailable'

function HostInstructionsActivity() {
  return (
    <section aria-labelledby="host-instructions-title" style={{ padding: 16 }}>
      <h2 id="host-instructions-title">Host instructions</h2>
      <p>This activity was selected by the embedding host.</p>
    </section>
  )
}

const hostInstructionsPlugin: IDEPlugin = {
  id: 'example.host-instructions',
  contributes: {
    activities: [{
      id: 'example.host-instructions.activity',
      title: 'Instructions',
      icon: 'book',
      component: HostInstructionsActivity,
      order: 10,
    }],
  },
}

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
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [source, setSource] = useState('print("Starter")')
  if (mode === 'source-editor') return <main>
    <h2>Host form title</h2><p>Host form guidance</p>
    <SourceEditor value={source} onChange={setSource} language="python" ariaLabel="Assignment starter code" theme={theme} />
    <output aria-label="Saved starter">{source}</output>
  </main>
  if (mode === 'redesign') return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ height: 64, flexShrink: 0 }}><h2 style={{ margin: 8 }}>Host dialog title</h2></header>
    <div style={{ flex: 1, minHeight: 0 }}><WorkbenchFixture label="Redesign workbench"
      configuration={{ ...configuration, theme, onThemeChange: setTheme, brand: false }}
      host={workspaceHost(host, 'ui-redesign')} /></div>
  </main>

  if (mode === 'invalid' || mode === 'invalid-activity' || mode === 'unavailable') {
    const invalidConfiguration: WebIDEConfiguration = {
      ...configuration,
      plugins: [hostInstructionsPlugin, ...configuration.plugins],
      initialLayout: {
        ...(mode === 'invalid-activity'
          ? { selectedActivityId: 'fixture.unknown-activity' }
          : { selectedPanelId: mode === 'invalid' ? 'fixture.unknown-panel' : 'graph' }),
      },
    }
    return (
      <LayoutErrorBoundary>
        <WorkbenchFixture
          label={mode === 'unavailable' ? 'Unavailable layout workbench' : 'Invalid layout workbench'}
          configuration={invalidConfiguration}
          host={workspaceHost(host, 'layout-invalid')}
        />
      </LayoutErrorBoundary>
    )
  }

  if (mode === 'multiple') {
    const firstConfiguration: WebIDEConfiguration = {
      ...configuration,
      responsive: false,
      initialLayout: {
        selectedPanelId: 'variables',
        panelColumnPercent: 35,
        panelContentPercent: 60,
      },
    }
    const secondConfiguration: WebIDEConfiguration = {
      ...configuration,
      responsive: false,
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
    plugins: [hostInstructionsPlugin, ...configuration.plugins],
    initialLayout: {
      selectedActivityId: 'example.host-instructions.activity',
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

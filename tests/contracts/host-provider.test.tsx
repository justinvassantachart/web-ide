import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  WebIDEHostProvider,
  useWebIDEHost,
  type WebIDEHost,
} from '../../src/web-ide'

function HostProbe() {
  const host = useWebIDEHost()
  return <output>{host?.workspace?.id ?? 'standalone'}</output>
}

function host(workspaceId: string): WebIDEHost {
  return { workspace: { id: workspaceId, localCache: 'memory' } }
}

describe('public Web IDE host provider', () => {
  it('supports standalone use and isolated host-owned embeds through public exports', () => {
    expect(renderToStaticMarkup(<HostProbe />)).toContain('standalone')

    const first = renderToStaticMarkup(
      <WebIDEHostProvider host={host('course/activity-a')}>
        <HostProbe />
      </WebIDEHostProvider>,
    )
    const second = renderToStaticMarkup(
      <WebIDEHostProvider host={host('custom-host/activity-b')}>
        <HostProbe />
      </WebIDEHostProvider>,
    )

    expect(first).toContain('course/activity-a')
    expect(first).not.toContain('custom-host/activity-b')
    expect(second).toContain('custom-host/activity-b')
    expect(second).not.toContain('course/activity-a')
  })
})

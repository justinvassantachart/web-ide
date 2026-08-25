import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PANEL_COLUMN_PERCENT,
  DEFAULT_PANEL_CONTENT_PERCENT,
  resolveWebIDEInitialLayout,
} from '../../src/web-ide/core/initial-layout'
import { createPanelLayoutController } from '../../src/web-ide/core/panel-layout'
import type { WebIDEInitialLayout } from '../../src/web-ide/contracts/configuration'

describe('initial workbench layout contract', () => {
  it('preserves established defaults when the host omits all fields', () => {
    expect(resolveWebIDEInitialLayout(undefined)).toEqual({
      panelColumnPercent: DEFAULT_PANEL_COLUMN_PERCENT,
      panelContentPercent: DEFAULT_PANEL_CONTENT_PERCENT,
    })
    expect(resolveWebIDEInitialLayout({})).toEqual({
      panelColumnPercent: 27,
      panelContentPercent: 70,
    })
  })

  it('accepts an exact initial panel and proportions within existing minimums', () => {
    expect(resolveWebIDEInitialLayout({
      selectedActivityId: 'example.instructions',
      selectedPanelId: 'example.preview',
      panelColumnPercent: 50,
      panelContentPercent: 85,
    })).toEqual({
      selectedActivityId: 'example.instructions',
      selectedPanelId: 'example.preview',
      panelColumnPercent: 50,
      panelContentPercent: 85,
    })
  })

  it.each([
    [{ panelColumnPercent: Number.NaN }, 'must be a finite number'],
    [{ panelColumnPercent: Number.POSITIVE_INFINITY }, 'must be a finite number'],
    [{ panelColumnPercent: 14.99 }, 'must be between 15 and 57'],
    [{ panelColumnPercent: 57.01 }, 'must be between 15 and 57'],
    [{ panelContentPercent: 24.99 }, 'must be between 25 and 90'],
    [{ panelContentPercent: 90.01 }, 'must be between 25 and 90'],
    [{ selectedActivityId: '' }, 'must be a non-empty string'],
    [{ selectedPanelId: '' }, 'must be a non-empty string'],
    [{ unexpected: true }, 'contains unsupported field "unexpected"'],
  ])('rejects invalid configuration %#', (value, message) => {
    expect(() => resolveWebIDEInitialLayout(value as WebIDEInitialLayout)).toThrow(message)
  })

  it('fails rather than replacing an unavailable requested panel', () => {
    const controller = createPanelLayoutController('example.preview')
    expect(() => controller.assertInitialPanelAvailable(['example.output'])).toThrow(
      'Initial panel "example.preview" is not visible',
    )
    expect(controller.getSnapshot()).toBe('example.preview')
  })

  it('keeps selection and subscriptions isolated per mount without persistence', () => {
    const first = createPanelLayoutController('example.first')
    const second = createPanelLayoutController('example.second')
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const unsubscribeFirst = first.subscribe(firstListener)
    second.subscribe(secondListener)

    first.assertInitialPanelAvailable(['example.first', 'example.third'])
    second.assertInitialPanelAvailable(['example.second'])
    first.selectPanel('example.third')

    expect(first.getSnapshot()).toBe('example.third')
    expect(second.getSnapshot()).toBe('example.second')
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()

    unsubscribeFirst()
    first.selectPanel('example.first')
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(createPanelLayoutController('example.first').getSnapshot()).toBe('example.first')
  })

  it('retains the legacy transient seed without treating it as a host request', () => {
    const controller = createPanelLayoutController()
    expect(() => controller.assertInitialPanelAvailable(['example.first'])).not.toThrow()
    expect(controller.getSnapshot()).toBe('variables')
  })
})

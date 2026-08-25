import type { WebIDEInitialLayout } from '../contracts/configuration'

export const DEFAULT_PANEL_COLUMN_PERCENT = 27
export const DEFAULT_PANEL_CONTENT_PERCENT = 70

const MIN_PANEL_COLUMN_PERCENT = 15
const MAX_PANEL_COLUMN_PERCENT = 57
const MIN_PANEL_CONTENT_PERCENT = 25
const MAX_PANEL_CONTENT_PERCENT = 90
const INITIAL_LAYOUT_KEYS = new Set([
  'selectedActivityId',
  'selectedPanelId',
  'panelColumnPercent',
  'panelContentPercent',
])

export interface ResolvedWebIDEInitialLayout {
  readonly selectedActivityId?: string
  readonly selectedPanelId?: string
  readonly panelColumnPercent: number
  readonly panelContentPercent: number
}

const DEFAULT_INITIAL_LAYOUT: ResolvedWebIDEInitialLayout = Object.freeze({
  panelColumnPercent: DEFAULT_PANEL_COLUMN_PERCENT,
  panelContentPercent: DEFAULT_PANEL_CONTENT_PERCENT,
})

function boundedPercent(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`initialLayout.${name} must be a finite number`)
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(
      `initialLayout.${name} must be between ${minimum} and ${maximum}`,
    )
  }
  return value
}

/** Validates host input before any usable workbench UI is mounted. */
export function resolveWebIDEInitialLayout(
  value: WebIDEInitialLayout | undefined,
): ResolvedWebIDEInitialLayout {
  if (value === undefined) return DEFAULT_INITIAL_LAYOUT
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('initialLayout must be an object')
  }

  for (const key of Object.keys(value)) {
    if (!INITIAL_LAYOUT_KEYS.has(key)) {
      throw new TypeError(`initialLayout contains unsupported field ${JSON.stringify(key)}`)
    }
  }

  const selectedActivityId = value.selectedActivityId
  if (
    selectedActivityId !== undefined
    && (typeof selectedActivityId !== 'string' || selectedActivityId.length === 0)
  ) {
    throw new TypeError('initialLayout.selectedActivityId must be a non-empty string')
  }

  const selectedPanelId = value.selectedPanelId
  if (
    selectedPanelId !== undefined
    && (typeof selectedPanelId !== 'string' || selectedPanelId.length === 0)
  ) {
    throw new TypeError('initialLayout.selectedPanelId must be a non-empty string')
  }

  const resolved = {
    panelColumnPercent: boundedPercent(
      'panelColumnPercent',
      value.panelColumnPercent,
      MIN_PANEL_COLUMN_PERCENT,
      MAX_PANEL_COLUMN_PERCENT,
      DEFAULT_PANEL_COLUMN_PERCENT,
    ),
    panelContentPercent: boundedPercent(
      'panelContentPercent',
      value.panelContentPercent,
      MIN_PANEL_CONTENT_PERCENT,
      MAX_PANEL_CONTENT_PERCENT,
      DEFAULT_PANEL_CONTENT_PERCENT,
    ),
    ...(selectedActivityId === undefined ? {} : { selectedActivityId }),
    ...(selectedPanelId === undefined ? {} : { selectedPanelId }),
  }
  return Object.freeze(resolved)
}

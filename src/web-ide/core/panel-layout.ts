let nextPanelLayoutId = 1

export interface PanelLayoutController {
  readonly domIdPrefix: string
  readonly initialSelectedPanelId: string | undefined
  readonly getSnapshot: () => string | undefined
  readonly subscribe: (listener: () => void) => () => void
  assertInitialPanelAvailable(availablePanelIds: readonly string[]): void
  selectPanel(panelId: string): void
}

/** Creates selection state owned only by one mounted workbench. */
export function createPanelLayoutController(
  initialSelectedPanelId?: string,
): PanelLayoutController {
  const domIdPrefix = `web-ide-panel-${nextPanelLayoutId}`
  nextPanelLayoutId += 1
  // Retain the previous transient selection seed. If it is unavailable, the
  // rendered workbench still chooses its first visible contribution exactly
  // as before; only an explicit host selection is fail-closed.
  let selectedPanelId = initialSelectedPanelId ?? 'variables'
  let initialSelectionPending = initialSelectedPanelId !== undefined
  const listeners = new Set<() => void>()

  return {
    domIdPrefix,
    initialSelectedPanelId,
    getSnapshot: () => selectedPanelId,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    assertInitialPanelAvailable(availablePanelIds) {
      if (!initialSelectionPending || initialSelectedPanelId === undefined) return
      if (!availablePanelIds.includes(initialSelectedPanelId)) {
        throw new Error(
          `Initial panel ${JSON.stringify(initialSelectedPanelId)} is not visible`,
        )
      }
      initialSelectionPending = false
    },
    selectPanel(panelId) {
      if (panelId === selectedPanelId) return
      selectedPanelId = panelId
      for (const listener of [...listeners]) listener()
    },
  }
}

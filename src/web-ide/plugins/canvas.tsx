import { CanvasView } from '@/components/canvas/CanvasView'
import type { IDEPlugin } from '../contracts/plugin'

/**
 * Optional graphics surface. The current C++ session exposes the typed draw
 * channel but does not yet produce commands; a future graphics runtime plugin
 * can do so without changing the workbench layout.
 */
export const canvasPlugin: IDEPlugin = {
  id: 'web-ide.canvas',
  contributes: {
    panels: [
      { id: 'canvas', title: 'Canvas', component: CanvasView, order: 30 },
    ],
  },
}

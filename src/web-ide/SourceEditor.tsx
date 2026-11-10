import MonacoEditor from '@monaco-editor/react'
import { defineMonacoThemes, monacoThemeName } from '@/components/editor/monaco-themes'

export interface SourceEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: string
  readOnly?: boolean
  ariaLabel?: string
  theme?: 'light' | 'dark'
  height?: number | string
}

/** A controlled source field for host authoring forms, without a runtime. */
export function SourceEditor({ value, onChange, language = 'python', readOnly = false,
  ariaLabel = 'Source code', theme = 'light', height = 240 }: SourceEditorProps) {
  return <div className="web-ide-root web-ide-source-editor" data-theme={theme} style={{ height, minWidth: 0 }}>
    <MonacoEditor value={value} language={language} height="100%"
      theme={monacoThemeName(theme)} beforeMount={defineMonacoThemes}
      onChange={(next) => onChange?.(next ?? '')}
      options={{ ariaLabel, readOnly, automaticLayout: true, editContext: false, minimap: { enabled: false },
        fontSize: 14, scrollBeyondLastLine: false, tabSize: 4, fixedOverflowWidgets: true,
        padding: { top: 12, bottom: 12 } }} />
  </div>
}

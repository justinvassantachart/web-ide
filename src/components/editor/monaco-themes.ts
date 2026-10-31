import type { Monaco } from '@monaco-editor/react'
import type { Theme } from '@/theme/theme-store'

// Workbench colors for the editor, taken from VS Code's Dark Modern and
// Light Modern themes (extensions/theme-defaults/themes/*_modern.json) and
// the registry defaults they inherit (editorColorRegistry.ts, colors/*.ts).
// Syntax token colors still come from Monaco's built-in `vs-dark` / `vs`
// bases; porting Dark+/Light+ token rules is deliberately out of scope here.
const DARK_MODERN: Record<string, string> = {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editorGutter.background': '#1f1f1f',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editor.lineHighlightBorder': '#282828',
    'editor.selectionBackground': '#264f78',
    'editorCursor.foreground': '#aeafad',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#313131',
    'editorHoverWidget.background': '#202020',
    'editorHoverWidget.border': '#313131',
    'editorSuggestWidget.background': '#202020',
    'editorSuggestWidget.border': '#313131',
    'editorSuggestWidget.selectedBackground': '#04395e',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#bfbfbf66',
    'focusBorder': '#0078d4',
    'widget.border': '#313131',
    'widget.shadow': '#0000005c',
    'input.background': '#313131',
    'input.border': '#3c3c3c',
    'input.foreground': '#cccccc',
}

const LIGHT_MODERN: Record<string, string> = {
    'editor.background': '#ffffff',
    'editor.foreground': '#3b3b3b',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#171184',
    'editor.lineHighlightBorder': '#eeeeee',
    'editor.selectionBackground': '#add6ff',
    'editorCursor.foreground': '#000000',
    'editorIndentGuide.background1': '#d3d3d3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorWidget.background': '#f8f8f8',
    'editorWidget.border': '#e5e5e5',
    'editorHoverWidget.background': '#f8f8f8',
    'editorHoverWidget.border': '#e5e5e5',
    'editorSuggestWidget.background': '#f8f8f8',
    'editorSuggestWidget.border': '#e5e5e5',
    'editorSuggestWidget.selectedBackground': '#e8e8e8',
    'scrollbarSlider.background': '#64646466',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#00000099',
    'focusBorder': '#005fb8',
    'widget.border': '#e5e5e5',
    'widget.shadow': '#00000029',
    'input.background': '#ffffff',
    'input.border': '#cecece',
    'input.foreground': '#3b3b3b',
}

const THEME_NAMES: Record<Theme, string> = {
    dark: 'web-ide-dark-modern',
    light: 'web-ide-light-modern',
}

/** Monaco theme name for a workbench theme; defined by {@link defineMonacoThemes}. */
export function monacoThemeName(theme: Theme): string {
    return THEME_NAMES[theme]
}

/**
 * Registers both workbench themes. Monaco's theme registry is global and
 * redefining a name is idempotent, so every editor can call this from
 * `beforeMount` without coordinating with other mounted workbenches.
 */
export function defineMonacoThemes(monaco: Pick<Monaco, 'editor'>): void {
    monaco.editor.defineTheme(THEME_NAMES.dark, {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: DARK_MODERN,
    })
    monaco.editor.defineTheme(THEME_NAMES.light, {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: LIGHT_MODERN,
    })
}

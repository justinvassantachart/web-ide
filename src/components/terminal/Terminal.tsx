import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useEngine } from '@/engine/engine-context'
import { useThemeStore, type Theme } from '@/theme/theme-store'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { normalizeTerminalNewlines } from './normalize-terminal-text'
import '@xterm/xterm/css/xterm.css'

const DARK_THEME: ITheme = {
    background: '#181818',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#181818',
    selectionBackground: '#264f78',
    selectionInactiveBackground: '#264f7880',
    black: '#000',
    brightBlack: '#666',
    red: '#cd3131',
    brightRed: '#f14c4c',
    green: '#0dbc79',
    brightGreen: '#23d18b',
    yellow: '#e5e510',
    brightYellow: '#f5f543',
    blue: '#2472c8',
    brightBlue: '#3b8eea',
    magenta: '#bc3fbc',
    brightMagenta: '#d670d6',
    cyan: '#11a8cd',
    brightCyan: '#29b8db',
    white: '#e5e5e5',
    brightWhite: '#fff',
}

// VS Code's default Light Modern panel and standard ANSI palette.
const LIGHT_THEME: ITheme = {
    background: '#f8f8f8',
    foreground: '#3b3b3b',
    cursor: '#005fb8',
    cursorAccent: '#f8f8f8',
    selectionBackground: '#add6ff',
    selectionInactiveBackground: '#e5ebf1',
    black: '#000000',
    brightBlack: '#666666',
    red: '#cd3131',
    brightRed: '#cd3131',
    green: '#00bc00',
    brightGreen: '#14ce14',
    yellow: '#949800',
    brightYellow: '#b5ba00',
    blue: '#0451a5',
    brightBlue: '#0451a5',
    magenta: '#bc05bc',
    brightMagenta: '#bc05bc',
    cyan: '#0598bc',
    brightCyan: '#0598bc',
    white: '#555555',
    brightWhite: '#a5a5a5',
}

const themeFor = (t: Theme): ITheme => (t === 'light' ? LIGHT_THEME : DARK_THEME)

export interface TerminalHandle {
    clear(): void
    focus(): void
}

export const Terminal = forwardRef<TerminalHandle>(function Terminal(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const engine = useEngine()
    const theme = useThemeStore((s) => s.theme)
    const configuration = useWebIDEConfiguration()
    const termRef = useRef<XTerm | null>(null)

    useImperativeHandle(ref, () => ({
        clear: () => termRef.current?.clear(),
        focus: () => termRef.current?.focus(),
    }), [])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        let disposed = false
        let frame: number | undefined
        const platform = navigator.platform
        const isMac = /Mac/i.test(platform)
        const isWindows = /Win/i.test(platform)
        // Match VS Code's platform defaults without a remote font-loading race.
        const term = new XTerm({
            fontFamily: isMac ? 'Menlo, Monaco, "Courier New", monospace'
                : isWindows ? 'Consolas, "Courier New", monospace'
                    : '"Droid Sans Mono", monospace',
            fontSize: isMac ? 12 : 14,
            lineHeight: 1,
            minimumContrastRatio: 4.5,
            cursorBlink: false,
            cursorStyle: 'block',
            screenReaderMode: true,
            theme: themeFor(useThemeStore.getState().theme),
        })
        termRef.current = term
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(container)
        term.textarea?.setAttribute('aria-label', 'Terminal input')
        term.attachCustomKeyEventHandler((event) => !(event.ctrlKey
            && !event.metaKey && !event.altKey && !event.shiftKey
            && (event.code === 'Backquote' || event.key === '`')))

        const scheduleFit = () => {
            if (disposed || frame !== undefined) return
            frame = requestAnimationFrame(() => {
                frame = undefined
                if (!disposed && container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
            })
        }
        scheduleFit()
        const resizeObserver = new ResizeObserver(scheduleFit)
        resizeObserver.observe(container)

        term.writeln(`\x1b[1;36m${configuration.terminalName ?? 'Web IDE Terminal'}\x1b[0m\r\n\x1b[90mReady\x1b[0m\r\n`)
        const onDataDisposable = term.onData((data) => engine.writeStdin?.(data))
        const unsubOut = engine.events.stdout.subscribe((text) => term.write(normalizeTerminalNewlines(text)))
        const unsubErr = engine.events.stderr.subscribe((text) => term.write(`\x1b[1;31m${normalizeTerminalNewlines(text)}\x1b[0m`))
        const unsubClr = engine.events.terminalClear.subscribe(() => term.clear())
        const unsubExt = engine.events.exit.subscribe((code) =>
            term.writeln(`\r\n\x1b[90m  Program exited with code ${code ?? 0}  \x1b[0m\r\n`),
        )

        return () => {
            disposed = true
            resizeObserver.disconnect()
            if (frame !== undefined) cancelAnimationFrame(frame)
            unsubOut(); unsubErr(); unsubClr(); unsubExt()
            onDataDisposable.dispose()
            term.dispose()
            if (termRef.current === term) termRef.current = null
        }
    }, [configuration.terminalName, engine])

    useEffect(() => {
        const term = termRef.current
        if (term) term.options.theme = themeFor(theme)
    }, [theme])

    return (
        <div
            ref={containerRef}
            className="w-full h-full"
            style={{ background: themeFor(theme).background }}
        />
    )
})

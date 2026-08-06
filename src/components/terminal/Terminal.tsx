import { useEffect, useRef } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useEngine } from '@/engine/engine-context'
import { useThemeStore, type Theme } from '@/theme/theme-store'
import { useWebIDEConfiguration } from '@/web-ide/react/configuration-context'
import { normalizeTerminalNewlines } from './normalize-terminal-text'
import '@xterm/xterm/css/xterm.css'

const DARK_THEME: ITheme = {
    background: '#0a0a0a',
    foreground: '#d4d4d4',
    cursor: '#5BC2EE',
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

// VS Code Light Modern terminal palette — matches the editor light theme so
// the terminal panel doesn't look like a hole punched into the IDE.
const LIGHT_THEME: ITheme = {
    background: '#ffffff',
    foreground: '#3b3b3b',
    cursor: '#005fb8',
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

export function Terminal() {
    const containerRef = useRef<HTMLDivElement>(null)
    const engine = useEngine()
    const theme = useThemeStore((s) => s.theme)
    const configuration = useWebIDEConfiguration()
    const termRef = useRef<XTerm | null>(null)

    useEffect(() => {
        if (!containerRef.current) return
        let disposed = false
        let cleanup = () => {}

        // xterm measures the cell width at construction time. If JetBrains Mono
        // (a Google web font) hasn't loaded yet, it measures against the fallback
        // and characters render at the wrong stride once the real font arrives —
        // that's the "squished glyphs" / "missing spaces" symptom. Force-load the
        // font before opening the terminal.
        const fontsReady =
            typeof document !== 'undefined' && 'fonts' in document
                ? document.fonts.load('13px "JetBrains Mono"').catch(() => undefined)
                : Promise.resolve()

        void fontsReady.then(() => {
            if (disposed || !containerRef.current) return

            const term = new XTerm({
                fontFamily:
                    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 13,
                lineHeight: 1.3,
                cursorBlink: true,
                cursorStyle: 'bar',
                theme: themeFor(useThemeStore.getState().theme),
            })
            termRef.current = term
            const fit = new FitAddon()
            term.loadAddon(fit)
            term.open(containerRef.current)
            fit.fit()

            term.writeln(`\x1b[1;36m${configuration.terminalName ?? 'Web IDE Terminal'}\x1b[0m\r\n\x1b[90mReady\x1b[0m\r\n`)

            const ro = new ResizeObserver(() => {
                requestAnimationFrame(() => fit.fit())
            })
            ro.observe(containerRef.current)

            const onDataDisposable = term.onData((data) => {
                engine.writeStdin?.(data)
            })

            const unsubOut = engine.events.stdout.subscribe((text) => term.write(normalizeTerminalNewlines(text)))
            const unsubErr = engine.events.stderr.subscribe((text) => term.write(`\x1b[1;31m${normalizeTerminalNewlines(text)}\x1b[0m`))
            const unsubClr = engine.events.terminalClear.subscribe(() => term.clear())
            const unsubExt = engine.events.exit.subscribe((code) =>
                term.writeln(`\r\n\x1b[90m  Program exited with code ${code ?? 0}  \x1b[0m\r\n`),
            )

            cleanup = () => {
                unsubOut(); unsubErr(); unsubClr(); unsubExt()
                onDataDisposable.dispose()
                ro.disconnect()
                term.dispose()
                if (termRef.current === term) termRef.current = null
            }
        })

        return () => {
            disposed = true
            cleanup()
        }
    }, [configuration.terminalName, engine])

    // Repaint xterm's palette whenever the IDE theme flips. The terminal is
    // constructed asynchronously (after the font loads), so termRef may be
    // null on the first run for a given theme — that's fine, construction
    // already reads the current theme via useThemeStore.getState().
    useEffect(() => {
        const term = termRef.current
        if (!term) return
        term.options.theme = themeFor(theme)
    }, [theme])

    return (
        <div
            ref={containerRef}
            className="w-full h-full"
            style={{ background: theme === 'light' ? '#ffffff' : '#0a0a0a' }}
        />
    )
}

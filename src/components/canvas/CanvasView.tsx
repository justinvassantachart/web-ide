import { useRef, useEffect } from 'react'
import { useEngine } from '@/engine/engine-context'

export function CanvasView() {
    const ref = useRef<HTMLCanvasElement>(null)
    const engine = useEngine()

    useEffect(() => {
        if (!ref.current) return
        const canvas = ref.current
        const ctx = canvas.getContext('2d')

        const resize = () => {
            const p = canvas.parentElement
            if (p) { canvas.width = p.clientWidth; canvas.height = p.clientHeight }
        }
        resize()
        const ro = new ResizeObserver(resize)
        if (canvas.parentElement) ro.observe(canvas.parentElement)

        // Event-driven rendering
        const unsub = engine.events.graphicsDraw.subscribe((queue) => {
            if (!ctx) return
            for (const cmd of queue) {
                switch (cmd.type) {
                    case 'CLEAR': ctx.clearRect(0, 0, canvas.width, canvas.height); break
                    case 'CIRCLE':
                        ctx.beginPath(); ctx.arc(cmd.x, cmd.y, cmd.r, 0, Math.PI * 2)
                        ctx.fillStyle = cmd.color; ctx.fill(); break
                    case 'RECT':
                        ctx.fillStyle = cmd.color; ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h); break
                }
            }
        })

        return () => { unsub(); ro.disconnect() }
    }, [engine])

    return <canvas ref={ref} className="w-full h-full block bg-black" />
}

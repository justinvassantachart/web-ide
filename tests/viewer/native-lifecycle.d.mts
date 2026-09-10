export function runNativeLifecycle(options: { url: string; executablePath: string }): Promise<{
    initial: string
    hidden: string
    frozen: boolean
    final: string
    before: ReturnType<Window['viewer']['measure']>
    after: ReturnType<Window['viewer']['measure']>
    lifecycle: Array<{ event: string; state: string }>
}>

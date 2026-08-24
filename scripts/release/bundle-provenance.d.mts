import type { Plugin } from 'vite'

export function createReleaseProvenancePlugin(outputPath: string): Promise<Plugin>

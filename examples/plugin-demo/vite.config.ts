import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'path', 'events'],
      globals: { Buffer: true, process: true },
    }),
  ],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  resolve: { dedupe: ['react', 'react-dom'] },
  worker: { format: 'es', plugins: () => [wasm(), topLevelAwait()] },
  optimizeDeps: { exclude: ['debugger-sh'] },
  build: { target: 'esnext' },
})

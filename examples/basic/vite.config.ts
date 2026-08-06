import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'

function crossOriginIsolation(): Plugin {
  const middleware = (
    _request: unknown,
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    next()
  }

  return {
    name: 'web-ide-example-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  plugins: [
    crossOriginIsolation(),
    react(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'path', 'events'],
      globals: { Buffer: true, process: true },
    }),
  ],
  resolve: { dedupe: ['react', 'react-dom'] },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: { exclude: ['debugger-sh'] },
  build: { target: 'esnext' },
})

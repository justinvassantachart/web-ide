import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
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
  ],
  resolve: {
    alias: {
      'node:buffer': 'buffer',
      'node:events': 'events',
      'node:path': 'path-browserify',
      'node:stream': 'stream-browserify',
    },
    dedupe: ['react', 'react-dom'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  optimizeDeps: { exclude: ['debugger-sh'] },
  build: { target: 'esnext' },
})

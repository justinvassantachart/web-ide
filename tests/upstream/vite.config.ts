import { defineConfig } from 'vite'
import path from 'node:path'
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
export default defineConfig({
  root: import.meta.dirname,
  plugins: [{
    name: 'isolation-including-conditional-responses',
    configurePreviewServer(server) {
      server.middlewares.use((_request, response, next) => {
        for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
        next()
      })
    },
  }],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, '../../src') } },
  optimizeDeps: { exclude: ['debugger-sh', 'debugger-sh-upstream'] },
  build: { target: 'esnext', outDir: '../../.artifacts/upstream-browser' },
  server: { headers }, preview: { headers },
})

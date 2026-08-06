import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'path', 'events'],
      globals: { Buffer: true, process: true },
    }),
    dts({
      tsconfigPath: './tsconfig.app.json',
      include: ['src'],
      exclude: ['tests'],
      insertTypesEntry: true,
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    dedupe: ['react', 'react-dom'],
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['debugger-sh'],
  },
  build: {
    target: 'esnext',
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, 'src/index.ts'),
        host: path.resolve(import.meta.dirname, 'src/host.ts'),
        plugins: path.resolve(import.meta.dirname, 'src/plugins.ts'),
        runtimes: path.resolve(import.meta.dirname, 'src/runtimes.ts'),
        testing: path.resolve(import.meta.dirname, 'src/testing.ts'),
        'language-tools': path.resolve(import.meta.dirname, 'src/language-tools.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'debugger-sh'],
    },
  },
})

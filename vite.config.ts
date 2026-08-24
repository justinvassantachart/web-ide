import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    dts({
      tsconfigPath: './tsconfig.app.json',
      include: ['src'],
      exclude: ['tests'],
      insertTypesEntry: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      'node:buffer': 'buffer',
      'node:events': 'events',
      'node:path': 'path-browserify',
      'node:stream': 'stream-browserify',
    },
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

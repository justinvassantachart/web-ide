import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'
import { createReleaseProvenancePlugin } from './scripts/release/bundle-provenance.mjs'
import { scopeWorkbenchCSS } from './scripts/build/scope-workbench-css.mjs'
import { rewriteDeclarationModuleSpecifiers } from './scripts/release/declaration-specifiers.mjs'

const releaseProvenancePath = process.env.WEB_IDE_RELEASE_PROVENANCE_PATH
const releaseProvenancePlugin = releaseProvenancePath
  ? await createReleaseProvenancePlugin(releaseProvenancePath)
  : null

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'scope-workbench-styles',
      enforce: 'post',
      generateBundle(_options, bundle) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue
          asset.source = scopeWorkbenchCSS(String(asset.source))
        }
      },
    },
    tailwindcss(),
    dts({
      tsconfigPath: './tsconfig.app.json',
      include: ['src'],
      exclude: ['tests'],
      insertTypesEntry: true,
      beforeWriteFile(filePath, content) {
        return {
          content: rewriteDeclarationModuleSpecifiers({
            filePath,
            content,
            sourceRoot: path.resolve(import.meta.dirname, 'src'),
            outputRoot: path.resolve(import.meta.dirname, 'dist'),
          }),
        }
      },
    }),
    ...(releaseProvenancePlugin ? [releaseProvenancePlugin] : []),
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
        assets: path.resolve(import.meta.dirname, 'src/assets.ts'),
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

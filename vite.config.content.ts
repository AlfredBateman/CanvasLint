import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  publicDir: false,
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'CanvasLintContent',
      formats: ['iife'],
      fileName: () => 'content/index.js'
    }
  }
});

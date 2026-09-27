import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Files in public/ are copied to dist/ as-is (no hashing)
  // We keep manifest.json and icons here so they land in dist/ verbatim.
  publicDir: 'public',

  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,

    rollupOptions: {
      /**
       * Extension entry points:
       *  - devtools/index.html  → DevTools bootstrap page
       *  - panel/index.html     → React DevTools panel
       *  - popup/index.html     → Browser action popup
       *  - background/index.ts  → MV3 service worker
       *  - content/index.ts     → Injected content script
       *  - inject/index.ts      → MAIN world proxy script
       */
      input: {
        devtools:   resolve(__dirname, 'devtools/index.html'),
        panel:      resolve(__dirname, 'panel/index.html'),
        popup:      resolve(__dirname, 'popup/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },

      output: {
        // Keep background, content, and inject scripts at predictable paths
        entryFileNames: (chunkInfo) => {
          const scriptEntries = ['background'];
          if (scriptEntries.includes(chunkInfo.name)) {
            return `${chunkInfo.name}/index.js`;
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});


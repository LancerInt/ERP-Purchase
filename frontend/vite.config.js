import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the heaviest libs into their own chunks so they load only on
        // the pages that need them and cache independently of app code.
        // Only pin what genuinely benefits from a shared, cacheable chunk.
        //
        // 'export-libs': ['xlsx', 'jspdf', 'html-to-image'] was removed. Naming
        // a package here makes Rollup emit it as a chunk ENTRY whether or not
        // anything imports it — and nothing imports jspdf or html-to-image at
        // all, so they were dead weight in a 280K chunk that index.html then
        // preloaded on every page. It also defeated code-splitting for xlsx:
        // the manual grouping overrode the dynamic import in exportExcel.js, so
        // the spreadsheet library stayed in the initial graph for all 117 list
        // pages regardless. Left to itself, Rollup puts xlsx in the lazy chunk
        // created by that dynamic import, and it loads when Export is pressed.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  server: {
    port: 5273,
    // The project lives in a OneDrive-synced folder, where the OS file-watch
    // events Vite relies on for HMR fire unreliably — so edits silently fail
    // to hot-reload and the browser shows stale UI. Polling watches the files
    // directly and makes HMR dependable here (small CPU cost, worth it).
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      // This standalone's Django dev server runs on :8200 (see run_server.bat).
      // The target is env-overridable so a dev whose Django is on another port
      // (e.g. the main ERP's :8000) can set VITE_API_TARGET without editing this
      // file — avoids the proxy port flip-flopping in git.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8200',
        changeOrigin: true,
      },
      // Uploaded media (e.g. staff photos) is served by Django in dev —
      // proxy it so file_url (/media/...) resolves through Vite.
      '/media': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8200',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
      '@sentry/react': '/src/stubs/sentry.js',
      '@simplewebauthn/browser': '/src/stubs/webauthn.js',
    },
  },
});

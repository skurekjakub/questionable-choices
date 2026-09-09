import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Origin the local API and WebSocket server listens on.
 */
const SERVER_ORIGIN = 'http://127.0.0.1:4400';

/**
 * Directory holding this config, used as the Vite root.
 *
 * `process.cwd()` is the repository root when the npm script runs, so the root
 * has to be pinned here rather than inferred.
 */
const here = new URL('.', import.meta.url).pathname;

/**
 * Vite configuration for the dashboard single-page app.
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: false },
      '/ws': { target: SERVER_ORIGIN, changeOrigin: false, ws: true },
    },
  },
});

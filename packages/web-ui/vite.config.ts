import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltePhosphorOptimize } from 'phosphor-svelte/vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parsePort } from './scripts/parse-port.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devPort = parsePort(process.env.IRONCURTAIN_WEB_UI_PORT, 5173);
const daemonPort = parsePort(process.env.IRONCURTAIN_WEB_UI_DAEMON_PORT, 7400);

export default defineConfig({
  plugins: [svelte(), sveltePhosphorOptimize()],
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
    },
  },
  build: {
    outDir: resolve(__dirname, '../../dist/web-ui-static'),
    emptyOutDir: true,
  },
  server: {
    port: devPort,
    proxy: {
      // Matches both GET /ws/auth (preflight) and the WS upgrade at /ws.
      // http-proxy with `ws: true` handles both HTTP and WS over the
      // same target; the http:// scheme works for both paths because
      // the proxy inspects the Upgrade header to decide which to use.
      '/ws': {
        target: `http://127.0.0.1:${daemonPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltePhosphorOptimize } from 'phosphor-svelte/vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    port: 5173,
    proxy: {
      // Matches both GET /ws/auth (preflight) and the WS upgrade at /ws.
      // http-proxy with `ws: true` handles both HTTP and WS over the
      // same target; the http:// scheme works for both paths because
      // the proxy inspects the Upgrade header to decide which to use.
      '/ws': {
        target: 'http://127.0.0.1:7400',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

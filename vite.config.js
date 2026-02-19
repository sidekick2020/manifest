import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0] || '';
          const isRoot = path === '/' || path === '';
          // Don't rewrite Vite internals (/@vite/client, /@react-refresh, /@id/...), source files, or API proxies
          const isViteInternal = path.startsWith('/@') || path.startsWith('/node_modules/') || path.startsWith('/src/');
          const isPathRoute =
            path.startsWith('/') &&
            !path.includes('.') &&
            path !== '/parse-api' &&
            path.indexOf('/parsefiles-proxy') !== 0 &&
            !isViteInternal;
          // Root path: serve index.html so the React app loads and can read the hash client-side
          // (e.g. /#point-cloud). Hash is never sent to the server, so we must serve React at /.
          if (isRoot) {
            req.url = '/index.html';
          } else if (isPathRoute) {
            req.url = '/test-point-cloud.html';
          }
          next();
        });
      },
    },
  ],
  root: __dirname,
  publicDir: 'public',
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  // test-point-cloud.html lives in public/ so it is served static (no transform). Avoids
  // Vite running import-analysis on it when it was a rollup input.
  optimizeDeps: {
    entries: ['./index.html'],
  },
  server: {
    port: 5174,
    proxy: {
      '/parse-api': {
        target: 'https://parseapi.back4app.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/parse-api/, ''),
        secure: true,
      },
      // Proxy Parse CDN so all images (profile + post) load on localhost without CORS.
      // See README "CORS and Parse CDN images (localhost)" — app uses getParseFilesProxyUrl() for every Parse CDN URL.
      '/parsefiles-proxy': {
        target: 'https://parsefiles.back4app.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/parsefiles-proxy/, ''),
        secure: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@lib': new URL('./lib', import.meta.url).pathname,
    },
  },
});

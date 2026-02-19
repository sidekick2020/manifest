import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Derive a branch-specific cache directory so different branches don't
// share stale pre-bundled deps or HMR state on the same port.
function branchCacheDir() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    // Sanitize branch name for use as directory component
    return 'node_modules/.vite-' + branch.replace(/[^a-zA-Z0-9_-]/g, '_');
  } catch {
    return 'node_modules/.vite';
  }
}

const cacheDir = branchCacheDir();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0] || '';
          const isRoot = path === '/' || path === '';
          const isPathRoute = path.startsWith('/') && !path.includes('.') && path !== '/parse-api' && path.indexOf('/parsefiles-proxy') !== 0;
          if (isRoot || isPathRoute) req.url = '/test-point-cloud.html';
          next();
        });
      },
    },
  ],
  root: __dirname,
  publicDir: 'public',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'test-point-cloud': resolve(__dirname, 'test-point-cloud.html'),
      },
    },
  },
  cacheDir,
  optimizeDeps: {
    entries: ['./index.html', './test-point-cloud.html'],
  },
  server: {
    port: 5173,
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

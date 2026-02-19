import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Derive a deterministic port from the git branch name so each branch
// gets its own dev server — no port collisions or stale-cache conflicts.
function branchPort() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    let hash = 0;
    for (let i = 0; i < branch.length; i++) {
      hash = ((hash << 5) - hash + branch.charCodeAt(i)) | 0;
    }
    // Map to port range 3100–3999 (900 slots, well above ephemeral range)
    return 3100 + (Math.abs(hash) % 900);
  } catch {
    return 5173; // fallback if not in a git repo
  }
}

const port = branchPort();

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
  optimizeDeps: {
    entries: ['./index.html', './test-point-cloud.html'],
  },
  server: {
    port,
    strictPort: true, // fail instead of silently picking another port
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

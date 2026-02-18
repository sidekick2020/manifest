import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'default-root',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '') {
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
    port: 5173,
    proxy: {
      '/parse-api': {
        target: 'https://parseapi.back4app.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/parse-api/, ''),
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

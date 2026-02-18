import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const isV2 = mode === 'v2';

  return {
    plugins: [react()],
    // Use the correct index file based on mode
    root: __dirname,
    publicDir: 'public',
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, isV2 ? 'index-v2.html' : 'index.html'),
        },
      },
    },
    // Configure dev server to use the right entry point
    optimizeDeps: {
      entries: [isV2 ? './index-v2.html' : './index.html'],
    },
    server: {
      port: 5173,
      proxy: {
        '/parse-api': {
          target: 'https://parseapi.back4app.com',
          changeOrigin: true,
          // Strip prefix: /parse-api/classes/X -> /classes/X
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
  };
});

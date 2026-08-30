import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import svgr from 'vite-plugin-svgr';

const API_PORT = process.env.PORT || '5055';
const API_HOST = process.env.HOST || '127.0.0.1';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const commitTag = env.COMMIT_TAG || process.env.COMMIT_TAG || 'local';

  return {
    plugins: [
      react(),
      svgr({
        include: '**/*.svg',
        svgrOptions: {
          exportType: 'default',
        },
      }),
    ],
    define: {
      'import.meta.env.COMMIT_TAG': JSON.stringify(commitTag),
    },
    resolve: {
      alias: {
        '@app': path.resolve(__dirname, 'src'),
        '@server': path.resolve(__dirname, 'server'),
      },
    },
    publicDir: 'public',
    build: {
      outDir: 'dist/public',
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://${API_HOST}:${API_PORT}`,
          changeOrigin: true,
        },
        '/imageproxy': {
          target: `http://${API_HOST}:${API_PORT}`,
          changeOrigin: true,
        },
        '/avatarproxy': {
          target: `http://${API_HOST}:${API_PORT}`,
          changeOrigin: true,
        },
        '/api-docs': {
          target: `http://${API_HOST}:${API_PORT}`,
          changeOrigin: true,
        },
      },
    },
  };
});

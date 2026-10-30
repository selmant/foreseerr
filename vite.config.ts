import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import svgr from 'vite-plugin-svgr';

const API_PORT = process.env.PORT || '5055';
const API_HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_BASE = process.env.FORESEERR_BASE_PATH ? './' : '/';
// Resolve through swagger-ui-express so the docs use its pinned distribution.
// These browser assets are packaged at build time; Rust needs no node_modules.
const swaggerRequire = createRequire(
  createRequire(import.meta.url).resolve('swagger-ui-express')
);
const swaggerDist: string = swaggerRequire('swagger-ui-dist/absolute-path')();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const commitTag = env.COMMIT_TAG || process.env.COMMIT_TAG || 'local';

  return {
    plugins: [
      {
        name: 'package-api-docs',
        generateBundle() {
          for (const name of [
            'swagger-ui-bundle.js',
            'swagger-ui-standalone-preset.js',
            'swagger-ui.css',
            'favicon-16x16.png',
            'favicon-32x32.png',
          ]) {
            this.emitFile({
              type: 'asset',
              fileName: `api-docs/${name}`,
              source: readFileSync(path.join(swaggerDist, name)),
            });
          }
        },
      },
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
        '@shared': path.resolve(__dirname, 'shared'),
        // The package "module" entry is ESM that still calls require() for
        // dayjs locales/plugins. Force the CJS build so Rollup rewrites them.
        '@seerr-team/react-tailwindcss-datepicker': path.resolve(
          __dirname,
          'node_modules/@seerr-team/react-tailwindcss-datepicker/dist/index.cjs.js'
        ),
      },
    },
    publicDir: 'public',
    base: PUBLIC_BASE,
    build: {
      outDir: 'dist/public',
      emptyOutDir: true,
      sourcemap: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    optimizeDeps: {
      include: ['@seerr-team/react-tailwindcss-datepicker', 'dayjs'],
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

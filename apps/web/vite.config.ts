/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

/* Storybook reuses this config but ships its own ~2MB manager runtime,
 * which the PWA plugin's `injectManifest` rejects.
 *
 * Detection: SB 9 doesn't set a STORYBOOK env var consistently, so we
 * sniff process.argv for the `storybook` binary or look for the npm
 * lifecycle script name. Either signal means the surrounding build is
 * for SB, and we drop the PWA plugin. The app's production build
 * still gets PWA + service worker as before. */
const isStorybookBuild =
  process.env.STORYBOOK === 'true' ||
  process.env.npm_lifecycle_event?.includes('storybook') === true ||
  process.argv.some((arg) => arg.includes('/storybook/') || arg.endsWith('storybook'));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(isStorybookBuild
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            srcDir: 'src',
            filename: 'sw.ts',
            strategies: 'injectManifest',
            manifest: false,
            injectManifest: {
              globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
            },
          }),
        ]),
  ],
  resolve: {
    alias: {
      '@': resolve(configDir, 'src'),
      /* monorepo 内 @chrono/* 通过 workspace node_modules 符号链接解析（指向 packages/*），
       * 不再 alias 到旧 vendored dist（融合后 vendored packages/ 已删除）。 */
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    onConsoleLog: (log) => {
      // Suppress sourcemap warnings from vendored @chrono/* dist files (sources not committed)
      if (log.includes('Sourcemap for') && log.includes('points to missing source files')) return false;
    },
  },
  build: {
    rollupOptions: {
      output: {
        /* Vite 8 ships rolldown by default, which only accepts the function
         * form of manualChunks. Mirror the previous static map by checking
         * id against well-known package roots. */
        /* Keep React + react-query in a stable vendor chunk; everything else
         * (including recharts and d3-sankey) follows the dynamic-import graph
         * so each lazy route only pays for the charts it renders. The earlier
         * `charts: ['recharts', 'd3-sankey']` rule was hoisting the entire
         * charts library into a preloaded chunk that loaded on every navigation. */
        manualChunks(id: string): string | undefined {
          if (id.includes('/node_modules/@tanstack/react-query/')) {
            return 'query';
          }
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router-dom/')
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});

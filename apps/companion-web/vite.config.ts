import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * ChronoCompanion web 构建配置（roadmap Phase 2.2）。
 * dev 期把 /api 代理到本地后端（chrono-synth-os 默认 3000 端口），避免跨域。
 */
export default defineConfig({
  plugins: [
    react(),
    /* PWA：injectManifest 策略（自写 src/sw.ts）；manifest:false 因已有 public/manifest.webmanifest。
     * autoUpdate：新版本可用时自动更新 SW。 */
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
  ],
  server: {
    proxy: {
      '/api': {
        target: process.env.COMPANION_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});

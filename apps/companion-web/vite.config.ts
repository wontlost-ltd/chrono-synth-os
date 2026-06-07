import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * ChronoCompanion web 构建配置（roadmap Phase 2.2）。
 * dev 期把 /api 代理到本地后端（chrono-synth-os 默认 3000 端口），避免跨域。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.COMPANION_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});

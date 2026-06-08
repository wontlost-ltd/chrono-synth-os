import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/* Test config lives in vitest.config.ts; this file is build-only. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /* Tauri's bundled WebView (wry on macOS / WebKitGTK on Linux / WebView2
   * on Windows) tracks modern ESM well. Vite 8's default build.target
   * narrowed to "baseline-widely-available" which strips some ES2022+
   * features (Promise.withResolvers etc.); pin to esnext so we don't
   * lose them silently. */
  build: {
    target: 'esnext',
  },
});

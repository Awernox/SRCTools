import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and does not tolerate the dev server wandering.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Mirrors the `@/*` path in tsconfig.json; without it the compiler and the
  // bundler would disagree about what `@/store/ui` means.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri v2 ships a modern WebView2 on Windows.
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});

import { defineConfig } from 'vite'

// Tauri expects a fixed dev port; TAURI_DEV_HOST is set for mobile/remote dev only.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WebView2 (Windows) is Chromium; WKWebView/WebKitGTK need a Safari baseline.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome120' : ['chrome120', 'safari16'],
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
})

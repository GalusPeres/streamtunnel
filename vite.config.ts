import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// The app version (package.json) shown in the settings, so you can see which build is installed.
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

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
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    // WebView2 (Windows) is Chromium; WKWebView/WebKitGTK need a Safari baseline.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome120' : ['chrome120', 'safari16'],
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
})

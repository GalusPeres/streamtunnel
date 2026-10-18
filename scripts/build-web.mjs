#!/usr/bin/env node
// Single-file web build: dist-web/StreamTunnel.html — the whole app (JS + CSS + assets) in one HTML file that
// works by double-click from disk (file://) in Chrome/Edge/Firefox. No server, no extra dependencies.
//
//   npm run build:web
//
// Steps: Vite build into dist-web/ (base './', no code splitting, one CSS file, all assets inlined as data URIs),
// then inline the JS as <script type="module">…</script> and the CSS as <style>…</style> into one HTML file.
// The Tauri-only modules (@tauri-apps/api) end up in the bundle but are only called behind isTauri().
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist-web')
const TARGET = join(OUT, 'StreamTunnel.html')

function fail(msg) {
  console.error(`[build:web] ${msg}`)
  process.exit(1)
}

function listFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

await build({
  root: ROOT,
  configFile: join(ROOT, 'vite.config.ts'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: OUT,
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: () => true,
    copyPublicDir: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
})

const indexPath = join(OUT, 'index.html')
if (!existsSync(indexPath)) fail('vite build produced no index.html')
let html = readFileSync(indexPath, 'utf8')

const files = listFiles(OUT).filter((p) => p !== indexPath)
const jsFiles = files.filter((p) => p.endsWith('.js'))
const cssFiles = files.filter((p) => p.endsWith('.css'))
const other = files.filter((p) => !p.endsWith('.js') && !p.endsWith('.css'))
if (jsFiles.length !== 1) fail(`expected exactly one JS chunk, got ${jsFiles.length}: ${jsFiles.map((p) => relative(OUT, p)).join(', ')}`)
if (cssFiles.length > 1) fail(`expected at most one CSS file, got ${cssFiles.length}`)
if (other.length) fail(`assets were not inlined: ${other.map((p) => relative(OUT, p)).join(', ')}`)

let js = readFileSync(jsFiles[0], 'utf8')
// Inside an inline <script>, the HTML parser ends the element at the first "</script". In valid JS that sequence
// can only appear inside string/template/regex literals or comments, where "<\/script" means the same thing.
js = js.replace(/<\/script/gi, '<\\/script')
// "<!--" followed by "<script" would switch the HTML tokenizer into the double-escaped state; refuse instead of
// silently shipping a broken page.
if (/<!--/.test(js) && /<script/i.test(js)) fail('bundle contains both "<!--" and "<script" — cannot inline safely')
const css = cssFiles.length ? readFileSync(cssFiles[0], 'utf8').replace(/<\/style/gi, '<\\/style') : ''

// Drop Vite's external tags (any attribute order), then insert the inline versions. Replacement functions are
// used so "$&" / "$1" sequences inside the bundle are never interpreted.
const scriptTag = /<script\b[^>]*\bsrc=["'][^"']*\.js["'][^>]*>\s*<\/script>\s*/gi
const cssTag = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>\s*/gi
const preloadTag = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>\s*/gi
const scripts = html.match(scriptTag) ?? []
if (scripts.length !== 1) fail(`expected one module <script src> in index.html, got ${scripts.length}`)
html = html.replace(scriptTag, () => '').replace(preloadTag, () => '').replace(cssTag, () => '')
if (css) html = html.replace(/<\/head>/i, () => `<style>\n${css}\n</style>\n</head>`)
// Module scripts are deferred even when inline; placing it at the end of <body> keeps that true for any engine.
html = html.replace(/<\/body>/i, () => `<script type="module">\n${js}\n</script>\n</body>`)

if (/\bsrc=["']\.?\/?assets\//i.test(html) || /\bhref=["']\.?\/?assets\//i.test(html)) {
  fail('index.html still references files in assets/')
}

writeFileSync(TARGET, html)
rmSync(indexPath)
rmSync(join(OUT, 'assets'), { recursive: true, force: true })

const kb = (statSync(TARGET).size / 1024).toFixed(1)
console.log(`[build:web] ${relative(ROOT, TARGET)} (${kb} KB)`)

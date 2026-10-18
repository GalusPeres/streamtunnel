#!/usr/bin/env node
// Headless end-to-end test of the LINUX Tauri app's native media path (CI job "Desktop (linux-tauri)"):
//   1. headless Chrome (Chromium = the WebView2 engine) opens the built UI (vite preview of dist/) with ?test,
//      creates a tunnel and shares the test picture over the real public MQTT brokers;
//   2. the Linux app binary starts (under Xvfb) with ST_E2E_JOIN=<code>; its injected driver
//      (tests/e2e/linux-app-driver.js) joins like a user, watches the sharer and checks that the GStreamer →
//      WebCodecs → <canvas> path shows a moving, non-black picture; it exits 0 (pass) / 1 (fail);
//   3. pass = app exit code 0 AND the sharer lists the Linux member as a connected watcher.
//
//   xvfb-run -a node tests/e2e/linux-tauri.mjs        (after `npm run tauri build`)
//   ST_E2E_APP=<binary>      default src-tauri/target/release/streamtunnel
//   ST_E2E_BROWSER=<chrome>  default google-chrome / chromium on PATH
// Prints a JSON summary; exit code 1 on failure. No npm dependencies (CDP over Node's WebSocket + fetch).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = process.env.ST_E2E_APP || join(ROOT, 'src-tauri', 'target', 'release', 'streamtunnel')
const APP_SECONDS = Number(process.env.ST_E2E_SECONDS || 150)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
const log = (...a) => console.error(`[linux-e2e ${elapsed()}s]`, ...a)

function findBrowser() {
  if (process.env.ST_E2E_BROWSER) return process.env.ST_E2E_BROWSER
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    if (spawnSync('which', [b], { stdio: 'ignore' }).status === 0) return b
  }
  throw new Error('no Chromium-based browser found (set ST_E2E_BROWSER)')
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function kill(proc) {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return
  try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* gone */ } }
}

// ───────────────────────── minimal CDP client ─────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
        else p.res(msg.result)
        return
      }
      for (const l of this.listeners) l(msg)
    }
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('CDP websocket failed'))
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    const id = ++this.nextId
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method}: CDP timeout`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        res: (v) => { clearTimeout(timer); res(v) },
        rej: (e) => { clearTimeout(timer); rej(e) },
      })
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }
}

async function openPage(cdp, url) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const logs = []
  cdp.listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`${elapsed()}s [${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`${elapsed()}s [exception] ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`)
    }
    if (logs.length > 300) logs.shift()
  })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  const page = {
    logs,
    async eval(fn, arg) {
      const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
      return r.result.value
    },
    async waitFor(label, fn, arg, timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs
      let last
      while (Date.now() < end) {
        try {
          last = await page.eval(fn, arg)
          if (last) return last
        } catch { /* not yet */ }
        await sleep(250)
      }
      throw new Error(`timeout (${Math.round(timeoutMs / 1000)} s) waiting for: ${label} — last ${JSON.stringify(last)}`)
    },
  }
  return page
}

// ───────────────────────── scenario ─────────────────────────

const summary = { ok: false, steps: [] }
const step = (name, data) => {
  summary.steps.push({ at: +elapsed(), step: name, ...(data ?? {}) })
  log(`✓ ${name}`, data ? JSON.stringify(data) : '')
}

let vite = null
let browser = null
let app = null
let profile = null

async function main() {
  if (!existsSync(APP)) throw new Error(`app binary not found: ${APP} (run npm run tauri build first)`)
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/ missing (npm run build)')

  // 1. the web UI for the sharer (same dist/ the app embeds)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}/`
  vite = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) break
    } catch { /* not yet */ }
    if (i === 119) throw new Error('vite preview did not come up')
  }
  step('web UI served', { base })

  // 2. headless Chrome as the sharer
  const cdpPort = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'st-linux-e2e-'))
  const exe = findBrowser()
  browser = spawn(exe, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // host candidates as IPs (like the Windows app); libnice cannot resolve mDNS names without avahi
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: true })
  let version = null
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(150)
    try {
      version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).json()
    } catch { /* not up yet */ }
  }
  if (!version) throw new Error('browser did not expose the DevTools endpoint')
  summary.browser = version.Browser
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const A = await openPage(cdp, `${base}?test`)
  summary.pageLogs = A.logs

  await A.waitFor('start view', () => !!document.querySelector('#create-btn') && window.__st && window.__st.view === 'start', null, 30_000)
  await A.eval(() => {
    const n = document.querySelector('#name')
    if (n) {
      n.value = 'Chrome-Sharer'
      n.dispatchEvent(new Event('input', { bubbles: true }))
      n.dispatchEvent(new Event('change', { bubbles: true }))
    }
    document.querySelector('#create-btn').click()
    return true
  })
  const code = await A.waitFor('tunnel code', () => (window.__st.view === 'tunnel' && document.querySelector('#room-code[data-code]')?.dataset.code) || null, null, 30_000)
  await A.waitFor('a broker', () => (window.__st.room?.status().connected ?? 0) > 0, null, 30_000)
  step('sharer in tunnel', { code, brokers: await A.eval(() => window.__st.room.status()) })
  await A.waitFor('test picture button', () => { const b = document.querySelector('#test-stream'); return !!b && !b.disabled && !b.closest('[hidden]') }, null, 10_000)
  await A.eval(() => { document.querySelector('#test-stream').click(); return true })
  await A.waitFor('sharing', () => window.__st.host !== null && window.__st.stream !== null, null, 15_000)
  step('sharer live (test picture)')

  // 3. the Linux app watches
  const appLines = []
  summary.app = { lines: appLines }
  app = spawn(APP, [], {
    env: {
      ...process.env,
      ST_E2E_JOIN: code,
      ST_E2E_NAME: 'Linux-Tauri',
      ST_E2E_SECONDS: String(APP_SECONDS - 10),
      ST_AUDIO_SINK: process.env.ST_AUDIO_SINK || 'fakesink sync=true',
      // software rendering under Xvfb
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const onLine = (prefix) => (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue
      appLines.push(`${elapsed()}s ${prefix}${line}`)
      if (appLines.length > 400) appLines.shift()
      console.error(`[app ${elapsed()}s] ${prefix}${line}`)
    }
  }
  app.stdout.on('data', onLine(''))
  app.stderr.on('data', onLine('! '))
  const exited = new Promise((res) => app.once('exit', (code, signal) => res({ code, signal })))

  // While the app runs: watch the sharer's view of its watchers (connected + sender stats: TWCC/bandwidth estimate).
  let watcher = null
  let watcherConnected = false
  const deadline = Date.now() + APP_SECONDS * 1000
  let exit = null
  while (!exit && Date.now() < deadline) {
    exit = await Promise.race([exited, sleep(2000).then(() => null)])
    try {
      const v = await A.eval(() => (window.__st.host ? window.__st.host.viewers().map((x) => ({ name: x.name, state: x.state, codec: x.codec, tx: x.tx, rx: x.rx })) : []))
      const lin = v.find((x) => x.name === 'Linux-Tauri') ?? v[0] ?? null
      if (lin) {
        watcher = lin
        if (lin.state === 'connected') watcherConnected = true
      }
    } catch { /* page busy */ }
  }
  if (!exit) {
    kill(app)
    throw new Error(`app did not finish within ${APP_SECONDS} s`)
  }
  summary.app.exit = exit
  summary.sharerSawWatcher = watcher
  step('app finished', { exit, watcherConnected, tx: watcher?.tx ?? null })
  if (exit.code !== 0) throw new Error(`app reported failure (exit ${exit.code ?? exit.signal})`)
  if (!watcherConnected) throw new Error('the sharer never listed the Linux member as a connected watcher')
  summary.ok = true
}

let code = 1
try {
  await main()
  code = 0
} catch (err) {
  summary.error = err?.message ?? String(err)
  log(`✗ FAILED: ${summary.error}`)
} finally {
  kill(app)
  kill(browser)
  kill(vite)
  if (profile) try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  summary.durationS = +((Date.now() - t0) / 1000).toFixed(1)
  if (summary.ok) delete summary.pageLogs
  else summary.pageLogs = summary.pageLogs?.slice(-80)
  if (summary.app) summary.app.lines = summary.app.lines.slice(-120)
  console.log(JSON.stringify(summary, null, 2))
  log(summary.ok ? 'PASS' : 'FAIL')
  process.exit(code)
}

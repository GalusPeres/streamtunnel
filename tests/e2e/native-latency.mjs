#!/usr/bin/env node
// End-to-end timing of the native path on this PC (docs/NATIVE-PATH.md §12), the sharer to the drawn picture, with no
// app window and no screen capture:
//   1. Rust (`st-media/tests/latency_win.rs`, release): TestPattern frames on the GPU → NVENC → stm/1 over 127.0.0.1 →
//      Receiver, 10 s at 2560x1440 / 60 fps per codec; every access unit is dumped as the raw Channel message the page
//      gets (§9.3) together with the moment the Receiver handed it over;
//   2. headless Edge: the dump is replayed at those moments into the page's own NvVideoRenderer (src/rtc/nativeplayer.ts,
//      WebCodecs + 2D canvas), and each frame's decode and draw are timed.
// Capture → drawn per frame = the Receiver's age (capture → handed over, Rust) + handed over → drawn (page). Not in it:
// the Tauri Channel hop (no Tauri here; the page's ipcMs measures it in the app) and the compositor / display scan-out.
//
//   node tests/e2e/native-latency.mjs              runs the Rust part first (Windows + NVIDIA), then the page part
//   node tests/e2e/native-latency.mjs <dumpDir>    replays an existing dump (ST_NV_DUMP of latency_win.rs)
//   ST_E2E_BROWSER=<path>                          other Chromium binary (default: Microsoft Edge)
// Prints a JSON summary; exit code 1 on any failure.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BROWSER = process.env.ST_E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const IS_WIN = process.platform === 'win32'
const CODECS = ['hevc', 'h264']
/** Frames before this many ms of the dump are the warm-up (as in latency_win.rs) and not measured. */
const WARMUP_MS = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.error(`[native-latency ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a)

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try { proc.kill('SIGKILL') } catch { /* gone */ }
  }
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

/** Minimal CDP client: one page, Runtime.evaluate with awaited promises. */
async function cdpPage(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP websocket failed'))
  })
  let nextId = 0
  const pending = new Map()
  const logs = []
  let sessionId = null
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
      else p.res(msg.result)
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`)
    }
  }
  const send = (method, params = {}, sid = sessionId, timeoutMs = 120_000) => {
    const id = ++nextId
    return new Promise((res, rej) => {
      const timer = setTimeout(() => pending.delete(id) && rej(new Error(`${method}: CDP timeout`)), timeoutMs)
      pending.set(id, { method, res: (v) => (clearTimeout(timer), res(v)), rej: (e) => (clearTimeout(timer), rej(e)) })
      ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }))
    })
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null)
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  return {
    logs,
    navigate: (url) => send('Page.navigate', { url }),
    async eval(fn, arg) {
      const r = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true, userGesture: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    },
    close: () => {
      send('Browser.close', {}, null, 3000).catch(() => {})
      try { ws.close() } catch { /* ignore */ }
    },
  }
}

function dist(v) {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  const at = (q) => s[Math.round((s.length - 1) * q)]
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length)
  const r = (x) => Math.round(x * 1000) / 1000
  return { p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[s.length - 1]), mean: r(mean), sd: r(sd) }
}

// ───────────────────────── in-page part (serialized into the page) ─────────────────────────

/**
 * Replays one dump into an NvVideoRenderer at the Receiver's hand-over moments. Every message gets a fresh wall-clock
 * stamp just before push (Rust stamps it when it hands the message to the Channel). Returns per-frame times:
 * [frameId, pushed, decoded (output callback = drawImage start), drawn (drawImage returned)] in ms of performance.now().
 */
async function replay(url) {
  const nl = await import('/src/rtc/nativelink.ts')
  const np = await import('/src/rtc/nativeplayer.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const buf = await (await fetch(url)).arrayBuffer()
  const dv = new DataView(buf)
  const msgs = []
  for (let off = 0; off + 12 <= buf.byteLength; ) {
    const len = dv.getUint32(off, true)
    const atUs = Number(dv.getBigUint64(off + 4, true))
    msgs.push({ atMs: atUs / 1000, buf: buf.slice(off + 12, off + 12 + len) })
    off += 12 + len
  }
  // frame id by WebCodecs timestamp (pts) for the draw hook
  const byPts = new Map()
  const times = new Map()
  const proto = CanvasRenderingContext2D.prototype
  const original = proto.drawImage
  proto.drawImage = function (img, ...rest) {
    const start = performance.now()
    const r = original.call(this, img, ...rest)
    const end = performance.now()
    const id = byPts.get(img?.timestamp)
    const t = id !== undefined ? times.get(id) : undefined
    if (t) {
      t[2] = start
      t[3] = end
    }
    return r
  }
  const r = new np.NvVideoRenderer()
  let fatal = null
  let keyRequests = 0
  r.onFatal = (reason) => (fatal = reason)
  r.onKeyframeNeeded = () => keyRequests++
  document.body.append(r.view)
  const samples = []
  const sampler = setInterval(() => samples.push(r.sample()), 1000)
  try {
    const start = performance.now() + 50
    for (const m of msgs) {
      const due = start + m.atMs
      const wait = due - performance.now()
      if (wait > 1) await sleep(wait - 1)
      new DataView(m.buf).setBigUint64(24, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)), true)
      const p = nl.parseNvMessage(m.buf)
      if (!p || !('video' in p)) throw new Error('parseNvMessage rejected a dumped message')
      byPts.set(p.video.ptsUs, p.video.frameId)
      const t = [p.video.frameId, performance.now(), 0, 0, p.video.ageUs / 1000, p.video.key ? 1 : 0, m.atMs, p.video.data.byteLength]
      times.set(p.video.frameId, t)
      r.push(p.video)
      if (fatal) break
    }
    await sleep(500)
  } finally {
    clearInterval(sampler)
    proto.drawImage = original
  }
  const last = r.sample()
  const out = { frames: msgs.length, fatal, keyRequests, final: last, samples, canvas: [r.view.width, r.view.height], per: [...times.values()] }
  r.close()
  return out
}

// ───────────────────────── main ─────────────────────────

const summary = { ok: false, browser: null, rust: null, codecs: {}, error: null, failures: [] }
let vite = null
let edge = null
let page = null
let profile = null
let files = null
let ownDump = null

function check(cond, message) {
  if (!cond) summary.failures.push(message)
}

try {
  let dumpDir = process.argv[2] || process.env.ST_NV_DUMP
  if (!dumpDir) {
    if (!IS_WIN) throw new Error('the Rust part needs Windows + NVIDIA; pass a dump directory instead')
    ownDump = mkdtempSync(join(tmpdir(), 'st-nv-dump-'))
    dumpDir = ownDump
    log('running st-media/tests/latency_win.rs (release) …')
    const args = ['test', '--release', '--manifest-path', 'st-media/Cargo.toml', '--target-dir', 'target', '--test', 'latency_win', '--', '--ignored', '--nocapture']
    const r = spawnSync('cargo', args, { cwd: join(ROOT, 'src-tauri'), env: { ...process.env, ST_NV_DUMP: dumpDir }, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
    process.stderr.write(r.stderr.split('\n').filter((l) => !/^\s*(Compiling|Finished|Running|running|test result)/.test(l) && l.trim()).join('\n') + '\n')
    // its numbers and dumps are written before its checks: a failed check (e.g. frames lost on a busy PC) is reported
    // and the page part still runs
    if (r.status !== 0) check(false, `latency_win.rs failed (exit ${r.status}), see its output above`)
  }
  summary.rust = {}
  for (const c of CODECS) {
    const f = join(dumpDir, `${c}.json`)
    if (existsSync(f)) summary.rust[c] = JSON.parse(readFileSync(f, 'utf8'))
  }
  check(Object.keys(summary.rust).length > 0, `no dump in ${dumpDir}`)

  // the dumps over HTTP (the page fetches them; CORS because Vite serves the page from another port)
  const filePort = await freePort()
  files = createHttpServer((req, res) => {
    const name = (req.url || '').replace(/^\//, '')
    const path = join(dumpDir, name)
    if (!/^(hevc|h264)\.nvdump$/.test(name) || !existsSync(path)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }).end(readFileSync(path))
  })
  await new Promise((r) => files.listen(filePort, '127.0.0.1', r))

  const vitePort = await freePort()
  const base = `http://localhost:${vitePort}/`
  vite = spawn(`npx vite --port ${vitePort} --strictPort`, { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true })
  for (let i = 0; ; i++) {
    await sleep(250)
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode}`)
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) break
    } catch { /* not up yet */ }
    if (i > 120) throw new Error('vite did not come up within 30 s')
  }
  log(`vite dev server at ${base}`)

  const cdpPort = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'st-native-latency-'))
  edge = spawn(
    BROWSER,
    ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore', windowsHide: true },
  )
  let version = null
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(150)
    try {
      version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).json()
    } catch { /* not up yet */ }
  }
  if (!version) throw new Error('browser did not expose the DevTools endpoint')
  summary.browser = version.Browser
  page = await cdpPage(version.webSocketDebuggerUrl)
  await page.navigate(`${base}?test`)
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (await page.eval(() => !!window.__st).catch(() => false)) break
  }

  for (const codec of CODECS) {
    const rust = summary.rust[codec]
    if (!rust) continue
    const r = await page.eval(replay, `http://127.0.0.1:${filePort}/${codec}.nvdump`)
    const c = { decoder: r.final.codec || r.samples.find((s) => s.codec)?.codec || null, hw: r.final.hw ?? r.samples.find((s) => s.hw !== null)?.hw ?? null, canvas: r.view, frame: [r.final.width, r.final.height], frames: r.frames, fatal: r.fatal, keyRequests: r.keyRequests }
    summary.codecs[codec] = c
    if (r.fatal && /no decoder/.test(r.fatal)) {
      c.skipped = `this browser has no ${codec} decoder (${r.fatal})`
      log(`${codec}: ${c.skipped}`)
      continue
    }
    const drawn = r.per.filter((t) => t[3] > 0)
    const win = drawn.filter((t) => t[6] >= WARMUP_MS)
    const totals = r.samples.concat([r.final]).reduce((a, s) => ({ drawn: Math.max(a.drawn, s.drawn), dropped: Math.max(a.dropped, s.dropped), errors: Math.max(a.errors, s.errors) }), { drawn: 0, dropped: 0, errors: 0 })
    c.drawn = totals.drawn
    c.dropped = totals.dropped
    c.errors = totals.errors
    c.decode = dist(win.map((t) => t[2] - t[1]))
    c.draw = dist(win.map((t) => t[3] - t[2]))
    c.decodeDraw = dist(win.map((t) => t[3] - t[1]))
    c.captureToDrawn = dist(win.filter((t) => t[4] > 0).map((t) => t[4] + (t[3] - t[1])))
    const iv = win.map((t) => t[3]).sort((a, b) => a - b)
    c.drawInterval = dist(iv.slice(1).map((x, i) => x - iv[i]))
    c.pageLatencyMs = r.samples.map((s) => s.latencyMs).filter((x) => typeof x === 'number').map((x) => Math.round(x * 10) / 10)
    check(!r.fatal, `${codec}: renderer gave up (${r.fatal})`)
    check(c.errors === 0, `${codec}: ${c.errors} decoder errors`)
    check(c.drawn >= r.frames - 2, `${codec}: drawn ${c.drawn} of ${r.frames} access units`)
    check(r.view[0] === rust.width && r.view[1] === rust.height, `${codec}: canvas ${r.view.join('x')}`)
    // a decoder that holds frames for reordering (an SPS without bitstream restriction: ~12 frames at level 5.1)
    check(c.decode && c.decode.p50 < 2 * (1000 / rust.fps), `${codec}: decode p50 ${c.decode?.p50} ms (frames held for reordering?)`)
    log(
      `${codec}: ${c.drawn}/${r.frames} drawn with ${c.decoder} (${c.hw ? 'prefer-hardware' : 'no-preference'}), ` +
        `decode p50 ${c.decode?.p50} / p95 ${c.decode?.p95} ms, draw p50 ${c.draw?.p50} ms, ` +
        `capture → drawn p50 ${c.captureToDrawn?.p50} / p95 ${c.captureToDrawn?.p95} ms`,
    )
  }
  summary.ok = summary.failures.length === 0 && Object.keys(summary.codecs).length > 0
} catch (err) {
  summary.error = err && err.message ? err.message : String(err)
} finally {
  if (page) {
    summary.pageErrors = page.logs.filter((l) => /\[(exception|error)\]/.test(l)).slice(-20)
    page.close()
  }
  await sleep(300)
  killTree(edge)
  killTree(vite)
  files?.close()
  for (const dir of [profile, ownDump]) {
    if (!dir) continue
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch { /* ignore */ }
  }
  console.log(JSON.stringify(summary, null, 2))
  log(summary.ok ? 'PASS' : `FAIL ${summary.error ?? summary.failures.join('; ')}`)
  process.exit(summary.ok ? 0 : 1)
}

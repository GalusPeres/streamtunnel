#!/usr/bin/env node
// Headless test of the native path's page side (docs/NATIVE-PATH.md §11.2): the decoder + renderer and the sound
// player of src/rtc/nativeplayer.ts, fed exactly the raw Channel messages Rust sends (32-byte video header + Annex B,
// 16-byte audio header + s16 PCM), parsed by parseNvMessage. No Tauri, no network, no screen capture: the access
// units are recorded in the page itself with WebCodecs VideoEncoder from a drawn test pattern.
//
//   node tests/e2e/native-decode.mjs
//   ST_E2E_BROWSER=<path>   other Chromium binary (default: Microsoft Edge)
//
// Checks, per codec the browser can encode (H.264 always, HEVC when headless Edge has an encoder):
//   1. a 3 s stream (90 frames, 640x360, key frames at 0 and 45) → every frame decoded and drawn on the canvas at
//      its size, the picture is the test pattern (pixel check), stats report decode time and latency
//   2. joining mid-stream: delta frames before the first key frame are dropped and a key frame is requested, the
//      picture starts with the next key frame
//   3. sound: 1.2 s of a 440 Hz tone in 20 ms blocks → the player's MediaStream is audible, the ring buffer stays
//      near its 40 ms target while fed at real time and underruns once the sound stops
// Starts its own Vite dev server on a free port (the page imports the TypeScript modules directly). Prints a JSON
// summary; exit code 1 on any failure.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BROWSER = process.env.ST_E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.error(`[native-decode ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a)

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
  const send = (method, params = {}, sid = sessionId, timeoutMs = 60_000) => {
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

// ───────────────────────── in-page parts (serialized into the page) ─────────────────────────

/**
 * Records a test-pattern stream with WebCodecs into window.__nvRec[codec] (stays in the page); returns the encoder's
 * codec string, or null if the browser cannot encode this codec.
 */
async function record(codec) {
  const W = 640
  const H = 360
  const N = 90
  const candidates =
    codec === 'hevc'
      ? [{ codec: 'hvc1.1.6.L93.B0', hevc: { format: 'annexb' } }]
      : [{ codec: 'avc1.640028', avc: { format: 'annexb' } }, { codec: 'avc1.42001f', avc: { format: 'annexb' } }]
  let cfg = null
  for (const c of candidates) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const full = { ...c, width: W, height: H, bitrate: 2_000_000, framerate: 30, latencyMode: 'realtime', hardwareAcceleration }
      try {
        if ((await VideoEncoder.isConfigSupported(full)).supported) {
          cfg = full
          break
        }
      } catch { /* next */ }
    }
    if (cfg) break
  }
  if (!cfg) return null
  const chunks = []
  let error = null
  const enc = new VideoEncoder({
    output: (c) => {
      const data = new Uint8Array(c.byteLength)
      c.copyTo(data)
      chunks.push({ key: c.type === 'key', ts: c.timestamp, data })
    },
    error: (e) => {
      error = String(e)
    },
  })
  enc.configure(cfg)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < N; i++) {
    // red background, a moving white bar: the pixel check expects red in the left half's top corner
    ctx.fillStyle = 'rgb(220, 30, 40)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#fff'
    ctx.fillRect(200 + ((i * 3) % 200), 100, 60, 160)
    const f = new VideoFrame(canvas, { timestamp: i * 33_333 })
    enc.encode(f, { keyFrame: i === 0 || i === 45 })
    f.close()
  }
  await enc.flush()
  enc.close()
  if (error) throw new Error(`encoder: ${error}`)
  window.__nvRec = { ...(window.__nvRec ?? {}), [codec]: chunks }
  return cfg.codec
}

/** Runs the decoder / renderer checks for the stream record() made. */
async function decodeChecks(codec) {
  const rec = { chunks: window.__nvRec[codec] }
  const nl = await import('/src/rtc/nativelink.ts')
  const np = await import('/src/rtc/nativeplayer.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const message = (c, id) => {
    const buf = new ArrayBuffer(32 + c.data.length)
    const d = new DataView(buf)
    d.setUint8(0, 1)
    d.setUint8(1, c.key ? 1 : 0)
    d.setUint8(2, codec === 'hevc' ? 2 : 1)
    d.setUint32(4, id, true)
    d.setBigUint64(8, BigInt(5_000_000 + c.ts), true)
    d.setUint32(16, 8_000, true) // age: 8 ms capture → handed over
    d.setUint32(20, 3_000, true)
    d.setBigUint64(24, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)), true)
    new Uint8Array(buf, 32).set(c.data)
    return buf
  }
  const play = async (r, chunks) => {
    let id = 0
    for (const c of chunks) {
      const m = nl.parseNvMessage(message(c, ++id))
      if (!m || !('video' in m)) throw new Error('parseNvMessage rejected a video message')
      r.push(m.video)
      await sleep(33)
    }
    await sleep(300)
  }

  // 1. the whole stream
  const r = new np.NvVideoRenderer()
  let first = 0
  let keyRequests = 0
  let fatal = null
  r.onFirstFrame = () => first++
  r.onKeyframeNeeded = () => keyRequests++
  r.onFatal = (reason) => (fatal = reason)
  document.body.append(r.canvas)
  await play(r, rec.chunks)
  const s = r.sample()
  const ctx = r.canvas.getContext('2d')
  const px = Array.from(ctx.getImageData(40, 40, 1, 1).data)
  const bar = Array.from(ctx.getImageData(r.canvas.width - 40, r.canvas.height - 40, 1, 1).data)
  const full = { frames: rec.chunks.length, keys: rec.chunks.filter((c) => c.key).length, ...s, firstFrame: first, keyRequests, fatal, canvas: [r.canvas.width, r.canvas.height], pixel: px, corner: bar }
  r.close()

  // 2. joining mid-stream: deltas first (dropped, key frame requested), then the second key frame
  const r2 = new np.NvVideoRenderer()
  let req2 = 0
  r2.onKeyframeNeeded = () => req2++
  const k2 = rec.chunks.findIndex((c, i) => i > 0 && c.key)
  await play(r2, rec.chunks.slice(10, 20).filter((c) => !c.key))
  const before = r2.sample()
  await play(r2, rec.chunks.slice(k2))
  const after = r2.sample()
  r2.close()
  return { full, midJoin: { droppedBeforeKey: before.dropped, drawnBeforeKey: before.drawn, keyRequests: req2, drawnAfterKey: after.drawn, framesAfterKey: rec.chunks.length - k2 } }
}

/** Plays 1.2 s of a 440 Hz tone through NvAudioPlayer and measures what comes out of its MediaStream. */
async function audioChecks() {
  const nl = await import('/src/rtc/nativelink.ts')
  const np = await import('/src/rtc/nativeplayer.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const player = new np.NvAudioPlayer()
  const stream = await player.ready
  if (!stream) return { error: 'player did not start' }
  const ctx = new AudioContext()
  await ctx.resume().catch(() => {})
  const an = ctx.createAnalyser()
  an.fftSize = 2048
  ctx.createMediaStreamSource(stream).connect(an)
  const buf = new Float32Array(an.fftSize)
  let peak = 0
  let phase = 0
  const blocks = 60
  const t0 = performance.now()
  for (let b = 0; b < blocks; b++) {
    const msg = new ArrayBuffer(16 + 960 * 4)
    const d = new DataView(msg)
    d.setUint8(0, 2)
    d.setUint8(1, 2)
    d.setUint32(4, b * 4, true)
    d.setBigUint64(8, BigInt(b * 20_000), true)
    const pcm = new Int16Array(msg, 16)
    for (let i = 0; i < 960; i++) {
      const v = Math.round(Math.sin(phase) * 0.5 * 32767)
      phase += (2 * Math.PI * 440) / 48_000
      pcm[2 * i] = v
      pcm[2 * i + 1] = v
    }
    const m = nl.parseNvMessage(msg)
    if (!m || !('audio' in m)) return { error: 'parseNvMessage rejected an audio message' }
    player.push(m.audio)
    // real time: the next block is due 20 ms after the previous one
    const due = t0 + (b + 1) * 20
    while (performance.now() < due) {
      an.getFloatTimeDomainData(buf)
      for (const x of buf) peak = Math.max(peak, Math.abs(x))
      await sleep(5)
    }
  }
  // the worklet reports once a second: this is its view after ~1 s of real-time feeding
  const during = player.stats()
  await sleep(1100)
  const after = player.stats()
  player.close()
  await ctx.close()
  return { peak: Math.round(peak * 1000) / 1000, during, after }
}

// ───────────────────────── main ─────────────────────────

const summary = { ok: false, browser: null, codecs: {}, audio: null, error: null, failures: [] }
let vite = null
let edge = null
let page = null
let profile = null

function check(cond, message) {
  if (!cond) summary.failures.push(message)
}

try {
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
  profile = mkdtempSync(join(tmpdir(), 'st-native-decode-'))
  edge = spawn(
    BROWSER,
    ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank'],
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

  for (const codec of ['h264', 'hevc']) {
    const encoder = await page.eval(record, codec)
    if (!encoder) {
      summary.codecs[codec] = { skipped: 'this browser cannot encode it' }
      check(codec !== 'h264', 'H.264 encoder missing in the browser')
      log(`${codec}: skipped (no encoder)`)
      continue
    }
    const r = await page.eval(decodeChecks, codec)
    summary.codecs[codec] = { encoder, ...r }
    const f = r.full
    if (f.fatal && /no decoder/.test(f.fatal) && codec === 'hevc') {
      summary.codecs[codec].skipped = 'no HEVC decoder in this browser'
      log(`${codec}: decoder missing — skipped`)
      continue
    }
    check(!f.fatal, `${codec}: renderer gave up (${f.fatal})`)
    check(f.firstFrame === 1, `${codec}: onFirstFrame called ${f.firstFrame}×`)
    check(f.drawn === f.frames, `${codec}: drawn ${f.drawn} of ${f.frames} frames`)
    check(f.errors === 0, `${codec}: ${f.errors} decoder errors`)
    check(f.canvas[0] === 640 && f.canvas[1] === 360 && f.width === 640, `${codec}: canvas ${f.canvas.join('x')}`)
    check(f.pixel[0] > 150 && f.pixel[1] < 90 && f.pixel[2] < 100, `${codec}: picture is not the red test pattern (${f.pixel})`)
    check(typeof f.decodeMs === 'number' && f.decodeMs >= 0, `${codec}: no decode time`)
    check(typeof f.latencyMs === 'number' && f.latencyMs >= 8, `${codec}: latency ${f.latencyMs} (must include the 8 ms age)`)
    const m = r.midJoin
    check(m.drawnBeforeKey === 0 && m.droppedBeforeKey > 0, `${codec}: deltas before the key frame were not dropped (${JSON.stringify(m)})`)
    check(m.keyRequests >= 1, `${codec}: no key frame requested while waiting`)
    check(m.drawnAfterKey === m.framesAfterKey, `${codec}: after the key frame ${m.drawnAfterKey} of ${m.framesAfterKey} drawn`)
    log(`${codec}: ${f.drawn}/${f.frames} drawn, decode ${f.decodeMs?.toFixed(2)} ms, latency ${f.latencyMs?.toFixed(1)} ms, ${f.codec} (${f.hw ? 'prefer-hardware' : 'software'})`)
  }

  const a = await page.eval(audioChecks)
  summary.audio = a
  check(!a.error, `audio: ${a.error}`)
  check(a.peak > 0.2, `audio: not audible (peak ${a.peak})`)
  check(a.after?.blocks === 60, `audio: ${a.after?.blocks} blocks pushed`)
  check(a.during?.underruns <= 1, `audio: ${a.during?.underruns} underruns while fed at real time`)
  check(a.during?.bufferedMs > 5 && a.during?.bufferedMs <= 130, `audio: ring buffer at ${a.during?.bufferedMs} ms while fed (target 40)`)
  check(a.after?.underruns >= 1 && !a.after?.playing, 'audio: the player did not notice the end of the sound')
  log(`audio: peak ${a.peak}, buffered ${a.during?.bufferedMs?.toFixed(1)} ms while fed, underruns ${a.during?.underruns}`)
  summary.ok = summary.failures.length === 0
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
  if (profile) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch { /* ignore */ }
  }
  console.log(JSON.stringify(summary, null, 2))
  log(summary.ok ? 'PASS' : `FAIL ${summary.error ?? summary.failures.join('; ')}`)
  process.exit(summary.ok ? 0 : 1)
}

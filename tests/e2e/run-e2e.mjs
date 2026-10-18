#!/usr/bin/env node
// Headless end-to-end test of the TUNNEL model: the real UI on the Vite dev server, the real public MQTT
// brokers and real WebRTC inside headless Microsoft Edge (Chromium = the WebView2 engine). No dependencies:
// CDP over Node's global WebSocket + fetch.
//
//   npm run e2e                     (dev server is reused if it already answers on :1420, else spawned)
//   npm run e2e -- --prod           vite build + vite preview on a free port (tests the shipped bundle)
//   ST_E2E_BROWSER=<path> npm run e2e   other Chromium binary
//   ST_E2E_KEEP=1                   keep the temp profile (debugging)
//
// Scenario (each page lives in its own browser context = separate member with its own storage):
//   A : creates a tunnel, maxDirect = 1, shares the test picture ("Testbild")
//   B : joins with the code from A's DOM, watches A → connected, video + audio, fps > 20, A lists 1 watcher
//   B : back to the tunnel, shares its own test picture; A watches B; B re-watches A → both directions at once
//   C : joins, watches A → A is full (maxDirect 1) → redirected to B (hops 2), A.relayedCount() ≥ 1
//   B : stops watching A → C reconnects (direct or another path) and gets video again within 20 s
//   A : stops sharing → C shows 'ended'; A leaves the tunnel → A disappears from B's member list
// Prints a JSON summary; exit code 1 on any failure. Edge, the temp profile and a spawned dev server are
// always cleaned up.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROD = process.argv.includes('--prod')
let BASE = process.env.ST_E2E_BASE || 'http://localhost:1420/'
const BROWSER = process.env.ST_E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const KEEP_PROFILE = process.env.ST_E2E_KEEP === '1'
const IS_WIN = process.platform === 'win32'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
const log = (...a) => console.error(`[e2e ${elapsed()}s]`, ...a)

// ───────────────────────── process helpers ─────────────────────────

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try { proc.kill('SIGKILL') } catch { /* gone */ }
  }
}

function waitExit(proc, ms) {
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise((r) => {
    const timer = setTimeout(r, ms)
    proc.once('exit', () => {
      clearTimeout(timer)
      r()
    })
  })
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

async function serverUp() {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
}

let viteProc = null
async function ensureDevServer() {
  if (PROD) {
    log('building (vite build)…')
    const build = spawnSync('npx vite build', { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true })
    if (build.status !== 0) throw new Error(`vite build failed (exit ${build.status})`)
    const port = await freePort()
    BASE = `http://localhost:${port}/`
    log(`serving dist with vite preview at ${BASE}`)
    viteProc = spawn(`npx vite preview --port ${port} --strictPort`, { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 120; i++) {
      await sleep(250)
      if (viteProc.exitCode !== null) throw new Error(`vite preview exited with code ${viteProc.exitCode}`)
      if (await serverUp()) return
    }
    throw new Error('vite preview did not come up within 30 s')
  }
  if (await serverUp()) {
    log(`dev server already running at ${BASE}`)
    return
  }
  log('starting vite dev server on :1420')
  viteProc = spawn('npx vite --port 1420 --strictPort', { cwd: ROOT, shell: true, stdio: 'ignore', windowsHide: true })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    if (viteProc.exitCode !== null) throw new Error(`vite exited with code ${viteProc.exitCode}`)
    if (await serverUp()) return
  }
  throw new Error('vite dev server did not come up within 30 s')
}

// ───────────────────────── minimal CDP client (flattened sessions) ─────────────────────────

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
    ws.onclose = () => {
      for (const p of this.pending.values()) p.rej(new Error('CDP connection closed'))
      this.pending.clear()
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
        res: (v) => {
          clearTimeout(timer)
          res(v)
        },
        rej: (e) => {
          clearTimeout(timer)
          rej(e)
        },
      })
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }

  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

/** One page in its own browser context. */
async function openPage(cdp, name, url) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const logs = []
  const push = (line) => {
    logs.push(`${elapsed()}s ${line}`)
    if (logs.length > 300) logs.shift()
  }
  cdp.listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.consoleAPICalled') {
      push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      push(`[exception] ${d.exception?.description || d.text}`)
    } else if (msg.method === 'Log.entryAdded') {
      push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`)
    }
  })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  // Headless pages must behave like a focused, visible window (no timer throttling, autoplay allowed).
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)

  const page = {
    name,
    sessionId,
    targetId,
    browserContextId,
    logs,
    /** Runs fn(arg) in the page (user gesture, promises awaited) and returns the JSON result. */
    async eval(fn, arg) {
      const expression = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : fn
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)
      if (r.exceptionDetails) {
        const d = r.exceptionDetails
        throw new Error(`[${name}] eval failed: ${d.exception?.description || d.text}`)
      }
      return r.result.value
    },
    /** Polls fn(arg) until it returns something truthy. */
    async waitFor(label, fn, arg, timeoutMs = 15_000, intervalMs = 200) {
      const end = Date.now() + timeoutMs
      let last
      let lastErr = null
      while (Date.now() < end) {
        try {
          last = await page.eval(fn, arg)
          lastErr = null
          if (last) return last
        } catch (err) {
          lastErr = err
        }
        await sleep(intervalMs)
      }
      throw new Error(`[${name}] timeout (${Math.round(timeoutMs / 1000)} s) waiting for: ${label}` + (lastErr ? ` — ${lastErr.message}` : ` — last value ${JSON.stringify(last)}`))
    },
    click(selector) {
      return page.eval((sel) => {
        const el = document.querySelector(sel)
        if (!el) throw new Error(`no element ${sel}`)
        if (el.disabled) throw new Error(`element ${sel} is disabled`)
        el.click()
        return true
      }, selector)
    },
    /** Sets an input/select value the way a user would (fires input + change). */
    setValue(selector, value) {
      return page.eval(
        ({ sel, v }) => {
          const el = document.querySelector(sel)
          if (!el) throw new Error(`no element ${sel}`)
          el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return el.value
        },
        { sel: selector, v: value },
      )
    },
  }
  return page
}


// ───────────────────────── in-page probes (serialized into the page) ─────────────────────────

function viewerSnap() {
  const st = window.__st
  const v = document.querySelector('#viewer-video')
  const a = document.querySelector('#viewer-audio')
  const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null
  const tracks = a && a.srcObject ? a.srcObject.getAudioTracks() : []
  const ov = document.querySelector('#viewer-state')
  return {
    view: st.view,
    watching: st.watching,
    state: st.viewer ? st.viewer.state() : null,
    viewerState: st.viewerState,
    uiState: ov ? ov.dataset.state : null,
    detail: ov && ov.dataset.detail ? ov.dataset.detail : null,
    videoWidth: v ? v.videoWidth : 0,
    videoHeight: v ? v.videoHeight : 0,
    currentTime: v ? v.currentTime : 0,
    frames: q ? q.totalVideoFrames : 0,
    droppedFrames: q ? q.droppedVideoFrames : 0,
    audioTracks: tracks.length,
    audioLive: tracks.some((t) => t.readyState === 'live'),
    audioPlaying: !!a && !a.paused,
    stats: st.stats,
    statsAgeMs: st.statsAt ? Date.now() - st.statsAt : null,
    hostInfo: st.hostInfo,
    relayChildren: st.viewer ? st.viewer.relayChildren() : 0,
    selfId: st.room ? st.room.selfId : null,
    brokers: st.room ? st.room.status() : null,
    visibility: document.visibilityState,
  }
}

function hostSnap() {
  const st = window.__st
  const h = st.host
  return {
    view: st.view,
    code: st.code,
    selfId: st.room ? st.room.selfId : null,
    brokers: st.room ? st.room.status() : null,
    sharing: !!h,
    streamId: st.stream ? st.stream.id : null,
    viewers: h ? h.viewers().map((v) => ({ id: v.id, name: v.name, state: v.state, codec: v.codec, tx: v.tx, rx: v.rx })) : [],
    relayed: h ? h.relayedCount() : 0,
    countText: document.querySelector('#viewer-count')?.textContent ?? null,
    connectedRows: document.querySelectorAll('[data-viewer-id][data-state="connected"]').length,
    rows: [...document.querySelectorAll('[data-viewer-id]')].map((r) => ({ id: r.dataset.viewerId, state: r.dataset.state, text: r.innerText.replace(/\s+/g, ' ').trim() })),
    members: [...document.querySelectorAll('[data-member-id]')].map((r) => ({ id: r.dataset.memberId, live: r.dataset.live, text: r.innerText.replace(/\s+/g, ' ').trim() })),
    visibility: document.visibilityState,
  }
}

/** Member rows as the UI shows them (id → live flag). */
function memberRows() {
  return [...document.querySelectorAll('[data-member-id]')].map((r) => ({ id: r.dataset.memberId, live: r.dataset.live === 'true', watchBtn: !!r.querySelector('.watch-btn') }))
}

// ───────────────────────── assertions helpers ─────────────────────────

/** Video advancing = currentTime and decoded frame count both grow over `ms`. */
async function videoAdvancing(page, ms = 1500) {
  const a = await page.eval(viewerSnap)
  await sleep(ms)
  const b = await page.eval(viewerSnap)
  const dt = b.currentTime - a.currentTime
  const df = b.frames - a.frames
  return { ok: b.videoWidth > 0 && dt > (ms / 1000) * 0.4 && df > (ms / 1000) * 10, dt: +dt.toFixed(2), frames: df, fpsDom: +((df * 1000) / ms).toFixed(1), size: `${b.videoWidth}x${b.videoHeight}`, snap: b }
}

async function waitVideoAdvancing(page, label, timeoutMs) {
  const end = Date.now() + timeoutMs
  let last = null
  while (Date.now() < end) {
    last = await videoAdvancing(page, 1200)
    if (last.ok) return last
  }
  throw new Error(`[${page.name}] video not advancing (${label}): ${JSON.stringify({ dt: last?.dt, frames: last?.frames, size: last?.size, state: last?.snap?.state, uiState: last?.snap?.uiState, detail: last?.snap?.detail })}`)
}

/**
 * Peak level of the audio the viewer actually receives (WebAudio analyser on the <audio> element's stream).
 * The test stream beeps 440 Hz at gain 0.08 for 100 ms every second, so a peak well above the noise floor
 * proves the sound arrives end to end, not just RTP packets.
 */
async function audioPeak(ms) {
  const a = document.querySelector('#viewer-audio')
  const stream = a && a.srcObject
  if (!stream || stream.getAudioTracks().length === 0) return { peak: 0, reason: 'no audio track' }
  const ctx = new AudioContext()
  try {
    await ctx.resume().catch(() => {})
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    src.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let peak = 0
    const end = performance.now() + ms
    while (performance.now() < end) {
      analyser.getFloatTimeDomainData(buf)
      for (let i = 0; i < buf.length; i++) {
        const x = Math.abs(buf[i])
        if (x > peak) peak = x
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    return { peak: Math.round(peak * 10000) / 10000, playing: !a.paused, muted: a.muted, ctx: ctx.state }
  } finally {
    void ctx.close().catch(() => {})
  }
}

async function assertAudible(page, label) {
  let last = null
  for (let i = 0; i < 3; i++) {
    last = await page.eval(audioPeak, 2500)
    if (last.peak > 0.02 && last.playing) return last
  }
  throw new Error(`[${page.name}] no audible sound (${label}): ${JSON.stringify(last)}`)
}

/** Waits for a stats sample taken after `since` (page clock = node clock, same machine) with bitrate data. */
function freshStats(page, since, timeoutMs = 8000) {
  return page.waitFor(
    'fresh inbound stats',
    (t) => {
      const st = window.__st
      return st.statsAt > t && st.stats && st.stats.bitrateKbps > 0 ? st.stats : null
    },
    since,
    timeoutMs,
  )
}

function hostSummary(hs) {
  return {
    brokers: hs.brokers,
    relayedCount: hs.relayed,
    viewerCountText: hs.countText,
    viewers: hs.viewers.map((v) => ({
      name: v.name,
      state: v.state,
      codec: v.codec,
      sent: v.tx ? `${v.tx.width}x${v.tx.height}@${v.tx.fps}` : null,
      mbps: v.tx ? +(v.tx.bitrateKbps / 1000).toFixed(2) : null,
      availableMbps: v.tx && v.tx.availableKbps != null ? +(v.tx.availableKbps / 1000).toFixed(1) : null,
      audioKbps: v.tx ? v.tx.audioKbps : null,
      encoder: v.tx ? v.tx.encoder : null,
      encoderHw: v.tx ? v.tx.hw : null,
      encodeMs: v.tx ? v.tx.encodeMs : null,
      rttMs: v.tx ? v.tx.rttMs : null,
      qualityLimitation: v.tx ? v.tx.qualityLimitation : null,
      connType: v.tx ? v.tx.connType : null,
      viewerReported: v.rx ? { fps: v.rx.fps, latencyMs: v.rx.latencyMs, children: v.rx.children, descendants: v.rx.descendants, canRelay: v.rx.canRelay } : null,
    })),
    pageVisibility: hs.visibility,
  }
}

function viewerSummary(snap) {
  const s = snap.stats
  return {
    watching: snap.watching,
    state: snap.state,
    statsAgeMs: snap.statsAgeMs,
    hops: snap.hostInfo ? snap.hostInfo.hops : null,
    hostName: snap.hostInfo ? snap.hostInfo.hostName : null,
    resolution: `${snap.videoWidth}x${snap.videoHeight}`,
    fps: s ? s.fps : null,
    codec: s ? s.codec : null,
    decoderHw: s ? s.hw : null,
    bitrateMbps: s ? +(s.bitrateKbps / 1000).toFixed(2) : null,
    audioKbps: s ? s.audioKbps : null,
    latencyMs: s ? s.latencyMs : null,
    rttMs: s ? s.rttMs : null,
    jitterBufferMs: s ? s.jitterBufferMs : null,
    decodeMs: s ? s.decodeMs : null,
    lossPct: s ? s.lossPct : null,
    framesDropped: s ? s.framesDropped : null,
    freezeCount: s ? s.freezeCount : null,
    connType: s ? s.connType : null,
    relayChildren: snap.relayChildren,
    brokers: snap.brokers,
  }
}

// ───────────────────────── scenario ─────────────────────────

const summary = { ok: false, mode: PROD ? 'prod (vite build + preview)' : 'dev server', startedAt: new Date(t0).toISOString(), browser: null, base: null, code: null, steps: [], timings: {}, viewers: {}, host: {}, error: null }
function step(name, data) {
  summary.steps.push(data === undefined ? { at: +elapsed(), step: name } : { at: +elapsed(), step: name, ...data })
  log(`✓ ${name}`, data === undefined ? '' : JSON.stringify(data))
}
function check(cond, message) {
  if (!cond) throw new Error(message)
}

/** Start screen → enter the tunnel (create = new code, else join `code`). Returns our member id. */
async function enter(page, name, code) {
  await page.waitFor('start view', () => !!document.querySelector('#join-code') && !!document.querySelector('#create-btn') && window.__st && window.__st.view === 'start', null, 20_000)
  await page.setValue('#name', name)
  if (code) {
    await page.setValue('#join-code', code)
    await page.waitFor('join button enabled', () => document.querySelector('#join-btn')?.disabled === false, null, 3000)
    await page.click('#join-btn')
  } else {
    await page.click('#create-btn')
  }
  await page.waitFor('tunnel view', () => window.__st.view === 'tunnel' && !!window.__st.tunnel && !!document.querySelector('#room-code[data-code]'), null, 20_000)
  await page.waitFor('≥1 broker connected', () => (window.__st.room?.status().connected ?? 0) > 0, null, 15_000)
  return page.eval(() => window.__st.room.selfId)
}

/** Clicks "Testbild" in the tunnel view and waits until our own member row is live. */
async function shareTest(page) {
  await page.waitFor(
    '"Testbild" button visible',
    () => {
      const b = document.querySelector('#test-stream')
      return !!b && !b.disabled && !b.closest('[hidden]') && !document.querySelector('#watch')
    },
    null,
    5000,
  )
  await page.click('#test-stream')
  const selfId = await page.eval(() => window.__st.room.selfId)
  await page.waitFor('sharing session', () => window.__st.host !== null && window.__st.stream !== null, null, 10_000)
  await page.waitFor('own member row live', (id) => document.querySelector(`[data-member-id="${id}"]`)?.dataset.live === 'true', selfId, 10_000)
  await page.waitFor('dock visible', () => !document.querySelector('#my-stream')?.hidden, null, 5000)
}

/** Waits until member `id` shows up live in our list, then clicks its "Ansehen" button. */
async function watchMember(page, id, timeoutMs = 20_000) {
  await page.waitFor(
    `member ${id} live with watch button`,
    (mid) => {
      const row = document.querySelector(`[data-member-id="${mid}"][data-live="true"]`)
      const btn = row && row.querySelector('.watch-btn')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    },
    id,
    timeoutMs,
  )
  await page.waitFor('watch overlay open', (mid) => window.__st.watching === mid && !!window.__st.viewer && !!document.querySelector('#viewer-video'), id, 5000)
  return Date.now()
}

/** Full "watching works" check: connected, frames advancing, fps > 20, audio track live. */
async function assertWatching(page, label, since, budgetMs) {
  const deadline = since + budgetMs
  const left = () => Math.max(1000, deadline - Date.now())
  await page.waitFor(`${label}: connected`, () => window.__st.viewerState === 'connected' && document.querySelector('#viewer-state')?.dataset.state === 'connected', null, left())
  const connectMs = Date.now() - since
  await page.waitFor(`${label}: video frames`, () => (document.querySelector('#viewer-video')?.videoWidth ?? 0) > 0, null, left())
  const adv = await waitVideoAdvancing(page, label, left())
  await page.waitFor(`${label}: inbound fps > 20`, () => (window.__st.stats?.fps ?? 0) > 20, null, left())
  await page.waitFor(
    `${label}: audio track live`,
    () => {
      const a = document.querySelector('#viewer-audio')
      const tracks = a && a.srcObject ? a.srcObject.getAudioTracks() : []
      return tracks.some((t) => t.readyState === 'live') && (window.__st.stats?.audioKbps ?? 0) > 0
    },
    null,
    left(),
  )
  return { connectMs, readyMs: Date.now() - since, adv }
}

/** Leaves the watch overlay through its back button. */
async function backToTunnel(page) {
  await page.click('#back-btn')
  await page.waitFor('back in the tunnel view', () => !document.querySelector('#watch') && window.__st.viewer === null && window.__st.view === 'tunnel', null, 5000)
}

async function scenario(cdp) {
  // ── A: create a tunnel, maxDirect 1, share the test picture ──
  const A = await openPage(cdp, 'A', `${BASE}?test`)
  pages.push(A)
  await A.waitFor('app booted', () => !!window.__st && window.__st.view === 'start', null, 20_000)
  // no UI for "max. direct watchers" in the tunnel model → set the persisted setting the share reads
  await A.eval(() => { window.__st.settings.maxDirect = 1 })
  const aCreate = Date.now()
  const aId = await enter(A, 'Anna', null)
  const code = await A.eval(() => document.querySelector('#room-code').dataset.code)
  const prettyCode = await A.eval(() => document.querySelector('#room-code').textContent.replace(/kopier\w*/g, '').trim())
  summary.code = prettyCode
  check(/^[0-9A-Z]{10}$/.test(code), `room code (data-code) looks wrong: ${code}`)
  summary.timings.aTunnelMs = Date.now() - aCreate
  const aShare = Date.now()
  await shareTest(A)
  summary.timings.aLiveMs = Date.now() - aShare
  const maxDirect = await A.eval(() => window.__st.settings.maxDirect)
  check(maxDirect === 1, `maxDirect not 1 (got ${maxDirect})`)
  step('A created the tunnel and is live (Testbild, maxDirect=1)', { code: prettyCode, aId, tunnelMs: summary.timings.aTunnelMs, liveMs: summary.timings.aLiveMs })

  // ── B: join with the code, watch A ──
  const B = await openPage(cdp, 'B', `${BASE}?test`)
  pages.push(B)
  await B.waitFor('app booted', () => !!window.__st && window.__st.view === 'start', null, 20_000)
  const bJoin = Date.now()
  const bId = await enter(B, 'Ben', code)
  summary.timings.bJoinMs = Date.now() - bJoin
  await A.waitFor('A sees B in the member list', (id) => !!document.querySelector(`[data-member-id="${id}"]`), bId, 15_000)
  const bWatch = await watchMember(B, aId)
  summary.timings.bSeesALiveMs = bWatch - bJoin
  const bRes = await assertWatching(B, 'B→A', bWatch, 30_000)
  summary.timings.bConnectMs = bRes.connectMs
  const aOne = await A.waitFor(
    'A lists exactly 1 connected watcher',
    () => {
      const rows = document.querySelectorAll('[data-viewer-id][data-state="connected"]').length
      const n = window.__st.host.viewers().filter((v) => v.state === 'connected').length
      return rows === 1 && n === 1 && document.querySelector('#viewer-count')?.textContent === '1' ? { rows, n } : null
    },
    null,
    10_000,
  )
  summary.timings.bAllAssertionsMs = Date.now() - bWatch
  const bAudio = await assertAudible(B, 'B→A direct')
  // stats HUD (best effort — the presentation belongs to the design)
  let hud = null
  try {
    await B.click('#stats-btn')
    hud = await B.waitFor(
      'stats HUD filled',
      () => {
        const p = document.querySelector('#stats-panel')
        if (!p || p.hidden) return null
        const cells = {}
        for (const dt of p.querySelectorAll('dt')) cells[dt.textContent] = dt.nextElementSibling ? dt.nextElementSibling.textContent : ''
        const filled = Object.values(cells).filter((v) => v && v !== '–').length
        return filled >= 4 ? cells : null
      },
      null,
      6000,
    )
    await B.click('#stats-btn')
  } catch (err) {
    hud = { error: err.message }
  }
  await freshStats(B, Date.now())
  const bSnap1 = await B.eval(viewerSnap)
  check(bSnap1.hostInfo && bSnap1.hostInfo.hops === 1, `B→A should be direct (hops ${bSnap1.hostInfo?.hops})`)
  summary.viewers.B_watchingA_direct = viewerSummary(bSnap1)
  summary.viewers.B_statsHud = hud
  step('B joined and watches A (video + audio)', { connectMs: bRes.connectMs, readyMs: summary.timings.bAllAssertionsMs, size: bRes.adv.size, domFps: bRes.adv.fpsDom, statsFps: bSnap1.stats?.fps, audioKbps: bSnap1.stats?.audioKbps, audioPeak: bAudio.peak, aRows: aOne.rows })

  // ── multi-share: B shares too, A watches B, B re-watches A ──
  await backToTunnel(B)
  await A.waitFor('A: watcher list empty after B went back', () => window.__st.host.viewers().filter((v) => v.state === 'connected').length === 0, null, 10_000)
  const bShare = Date.now()
  await shareTest(B)
  summary.timings.bLiveMs = Date.now() - bShare
  const aWatch = await watchMember(A, bId)
  const aRes = await assertWatching(A, 'A→B', aWatch, 30_000)
  summary.timings.aWatchBConnectMs = aRes.connectMs
  const bRewatch = await watchMember(B, aId)
  const bRes2 = await assertWatching(B, 'B→A again', bRewatch, 30_000)
  summary.timings.bRewatchConnectMs = bRes2.connectMs
  // both directions at the same time
  const [aAdv, bAdv] = await Promise.all([waitVideoAdvancing(A, 'A→B while B→A', 8000), waitVideoAdvancing(B, 'B→A while A→B', 8000)])
  await B.waitFor('B lists A as connected watcher', (id) => window.__st.host.viewers().some((v) => v.id === id && v.state === 'connected'), aId, 10_000)
  await A.waitFor('A lists B as connected watcher', (id) => window.__st.host.viewers().some((v) => v.id === id && v.state === 'connected'), bId, 10_000)
  const bothLive = await B.waitFor('B sees both members live', () => document.querySelectorAll('[data-member-id][data-live="true"]').length === 2, null, 10_000)
  await freshStats(A, Date.now())
  summary.viewers.A_watchingB = viewerSummary(await A.eval(viewerSnap))
  summary.viewers.B_watchingA_again = viewerSummary(await B.eval(viewerSnap))
  step('two sharers, watching each other', { aWatchBConnectMs: aRes.connectMs, bRewatchConnectMs: bRes2.connectMs, aDomFps: aAdv.fpsDom, bDomFps: bAdv.fpsDom, bothLive })

  // ── relay: C watches A → A full (maxDirect 1) → redirected to B ──
  await A.waitFor(
    'A sees B as relay-capable (rx.canRelay)',
    (id) => window.__st.host.viewers().some((v) => v.id === id && v.state === 'connected' && v.rx && v.rx.canRelay),
    bId,
    15_000,
  )
  const C = await openPage(cdp, 'C', `${BASE}?test`)
  pages.push(C)
  await C.waitFor('app booted', () => !!window.__st && window.__st.view === 'start', null, 20_000)
  const cId = await enter(C, 'Cleo', code)
  const cWatch = await watchMember(C, aId)
  await C.waitFor('C connected', () => window.__st.viewerState === 'connected', null, 30_000)
  summary.timings.cConnectMs = Date.now() - cWatch
  const cHops = await C.waitFor('C via relay (hops === 2)', () => window.__st.hostInfo?.hops === 2 && window.__st.hostInfo.hops, null, 10_000)
  const cAdv = await waitVideoAdvancing(C, 'C via relay', 15_000)
  const bChildren = await B.waitFor('B relays to ≥1 child', () => window.__st.viewer && window.__st.viewer.relayChildren(), null, 10_000)
  const relayed = await A.waitFor('A relayedCount() ≥ 1', () => window.__st.host.relayedCount(), null, 15_000)
  await C.waitFor('C inbound fps > 20', () => (window.__st.stats?.fps ?? 0) > 20, null, 15_000)
  const cAudio = await assertAudible(C, 'C via relay')
  await freshStats(C, Date.now())
  const cRelaySnap = await C.eval(viewerSnap)
  check(cRelaySnap.hostInfo && cRelaySnap.hostInfo.hops === 2, `C is no longer on the relay (hops ${cRelaySnap.hostInfo?.hops})`)
  check(cRelaySnap.hostInfo.hostName === 'Anna', `C via relay should still show the sharer's name, got ${cRelaySnap.hostInfo.hostName}`)
  summary.viewers.C_viaRelayB = viewerSummary(cRelaySnap)
  summary.viewers.B_relaying = viewerSummary(await B.eval(viewerSnap))
  await A.waitFor('A has sender stats for B', (id) => window.__st.host.viewers().some((v) => v.id === id && v.tx), bId, 6000).catch(() => null)
  summary.host.A_withRelay = hostSummary(await A.eval(hostSnap))
  step('C redirected to relay B', { connectMs: summary.timings.cConnectMs, hops: cHops, domFps: cAdv.fpsDom, audioPeak: cAudio.peak, bChildren, aRelayedCount: relayed })

  // ── B stops watching A → C reconnects ──
  const cFramesBefore = cRelaySnap.frames
  await backToTunnel(B)
  const bLeft = Date.now()
  await C.waitFor('C notices the loss (not connected via B)', () => window.__st.viewerState !== 'connected' || (window.__st.hostInfo?.hops ?? 2) === 1, null, 15_000)
  await C.waitFor('C connected again', () => window.__st.viewerState === 'connected', null, Math.max(1000, bLeft + 20_000 - Date.now()))
  const cAgainAt = Date.now()
  const cAdv2 = await waitVideoAdvancing(C, 'C after B stopped watching', Math.max(2000, bLeft + 20_000 - Date.now()))
  summary.timings.cReconnectMs = Date.now() - bLeft
  check(summary.timings.cReconnectMs <= 20_000, `C took ${summary.timings.cReconnectMs} ms to get video again`)
  const cAudio2 = await assertAudible(C, 'C after reconnect')
  await freshStats(C, cAgainAt)
  const cSnap2 = await C.eval(viewerSnap)
  summary.viewers.C_afterReconnect = viewerSummary(cSnap2)
  const aAfter = await A.waitFor(
    'A lists C as connected (B gone)',
    ({ c, b }) => {
      const v = window.__st.host.viewers()
      return v.some((x) => x.id === c && x.state === 'connected') && !v.some((x) => x.id === b) ? v.length : 0
    },
    { c: cId, b: bId },
    10_000,
  ).catch(() => null)
  // C may legitimately be on another path; only require A to have dropped B
  if (aAfter === null) {
    const stillB = await A.eval((b) => window.__st.host.viewers().some((x) => x.id === b), bId)
    check(!stillB, 'A still lists B as a watcher after B stopped watching')
  }
  step('C reconnected after B stopped watching', { ms: summary.timings.cReconnectMs, hops: cSnap2.hostInfo?.hops, domFps: cAdv2.fpsDom, audioPeak: cAudio2.peak, framesBefore: cFramesBefore, aListsC: aAfter !== null })

  await A.waitFor('A has sender stats for C', (id) => window.__st.host.viewers().some((v) => v.id === id && v.tx && v.tx.bitrateKbps > 0), cId, 8000).catch(() => null)
  summary.host.A_final = hostSummary(await A.eval(hostSnap))

  // ── A stops sharing → C 'ended' ──
  await backToTunnel(A) // A was still watching B
  const cBeforeStop = await C.eval(() => ({ s: window.__st.viewerState, ui: document.querySelector('#viewer-state')?.dataset.state }))
  check(cBeforeStop.s === 'connected' && cBeforeStop.ui === 'connected', `C not connected right before A stops: ${JSON.stringify(cBeforeStop)}`)
  await A.click('#stop-btn')
  const stopAt = Date.now()
  await C.waitFor("C shows 'ended'", () => window.__st.viewerState === 'ended' && document.querySelector('#viewer-state')?.dataset.state === 'ended', null, 15_000)
  summary.timings.endedMs = Date.now() - stopAt
  await A.waitFor('A no longer live', (id) => window.__st.host === null && document.querySelector(`[data-member-id="${id}"]`)?.dataset.live === 'false' && document.querySelector('#my-stream')?.hidden === true, aId, 5000)
  await B.waitFor('B sees A not live', (id) => document.querySelector(`[data-member-id="${id}"]`)?.dataset.live === 'false', aId, 15_000)
  step("A stopped → C 'ended'", { ms: summary.timings.endedMs })

  // ── A leaves the tunnel → gone from B's list ──
  await A.click('#leave-btn')
  const leaveAt = Date.now()
  await A.waitFor('A back on the start screen', () => window.__st.view === 'start' && window.__st.tunnel === null && !!document.querySelector('#join-code'), null, 5000)
  await B.waitFor('A gone from B\'s member list', (id) => !document.querySelector(`[data-member-id="${id}"]`), aId, 15_000)
  summary.timings.leaveGoneMs = Date.now() - leaveAt
  await C.waitFor('A gone from C\'s member list', (id) => !document.querySelector(`[data-member-id="${id}"]`), aId, 15_000).catch(() => null)
  summary.members = { B: await B.eval(memberRows), C: await C.eval(memberRows) }
  step('A left → gone from B\'s list', { ms: summary.timings.leaveGoneMs })
  summary.ok = true
}
// ───────────────────────── main ─────────────────────────

const pages = []
let edge = null
let profile = null
let cdp = null
let cleanedUp = false

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (cdp) {
    await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {})
    cdp.close()
  }
  await waitExit(edge, 3000)
  killTree(edge)
  await waitExit(edge, 3000)
  if (profile && !KEEP_PROFILE) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (err) {
      log(`could not remove temp profile ${profile}: ${err.message}`)
    }
  }
  if (viteProc) {
    killTree(viteProc)
    await waitExit(viteProc, 3000)
  }
}

process.on('SIGINT', () => {
  void cleanup().then(() => process.exit(130))
})

async function main() {
  await ensureDevServer()
  const port = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'st-e2e-'))
  const args = [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=WebRtcAV1HWEncode',
    '--disable-features=WebRTCColorAccuracy,WebRtcHideLocalIpsWithMdns',
    // same as the Tauri window: keep timers / rendering alive for pages that are not in front
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  edge = spawn(BROWSER, args, { stdio: 'ignore', windowsHide: true })
  edge.on('error', (err) => log(`browser spawn error: ${err.message}`))
  let version = null
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(150)
    if (edge.exitCode !== null) throw new Error(`browser exited early (code ${edge.exitCode})`)
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json()
    } catch { /* not up yet */ }
  }
  if (!version) throw new Error('browser did not expose the DevTools endpoint')
  summary.browser = version.Browser
  summary.base = BASE
  log(`browser ${version.Browser} on port ${port}`)
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  await scenario(cdp)
}

let exitCode = 1
try {
  await main()
  exitCode = summary.ok ? 0 : 1
} catch (err) {
  summary.ok = false
  summary.error = err && err.message ? err.message : String(err)
  log(`✗ FAILED: ${summary.error}`)
  // diagnostics: last state + console of every page
  summary.diagnostics = {}
  for (const p of pages) {
    const d = { logs: p.logs.slice(-60) }
    try {
      d.host = await p.eval(hostSnap)
      d.viewer = await p.eval(viewerSnap)
    } catch (e) {
      d.snapError = e.message
    }
    try {
      d.roomDiagnostics = await p.eval(() => (window.__st.room && typeof window.__st.room.diagnostics === 'function' ? window.__st.room.diagnostics() : null))
    } catch { /* ignore */ }
    summary.diagnostics[p.name] = d
  }
} finally {
  summary.durationS = +((Date.now() - t0) / 1000).toFixed(1)
  await cleanup()
  console.log(JSON.stringify(summary, null, 2))
  log(summary.ok ? 'PASS' : 'FAIL')
  process.exit(exitCode)
}

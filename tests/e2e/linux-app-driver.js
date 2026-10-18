// Injected by the Linux app (src-tauri/src/media.rs) after page load, ONLY when ST_E2E_JOIN is set — never in normal
// use. Drives the real UI like a user: join the tunnel, watch the first live member, then checks that the native
// media path (GStreamer → WebCodecs → <canvas>) shows a moving, non-black picture and reports through test_report
// (a final report exits the app with 0 = pass / 1 = fail). Plain JS on purpose (eval'd as is).
;(async () => {
  if (window.__stE2E) return
  window.__stE2E = true
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  let cfg = null
  try {
    cfg = await invoke('test_config')
  } catch {
    return
  }
  if (!cfg) return
  const report = (line, done = false, ok = false) => invoke('test_report', { line: String(line).slice(0, 6000), done, ok }).catch(() => {})
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const deadline = Date.now() + cfg.seconds * 1000
  const waitFor = async (label, fn, ms) => {
    const end = Math.min(deadline, Date.now() + ms)
    while (Date.now() < end) {
      try {
        const v = fn()
        if (v) return v
      } catch { /* not yet */ }
      await sleep(250)
    }
    throw new Error('timeout waiting for: ' + label)
  }
  const native = () => (window.__stNative && window.__stNative.debug ? window.__stNative.debug() : null)
  window.addEventListener('error', (e) => report('page error: ' + e.message))
  window.addEventListener('unhandledrejection', (e) => report('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)))
  for (const k of ['warn', 'error', 'info']) {
    const orig = console[k].bind(console)
    console[k] = (...a) => {
      orig(...a)
      report(`console.${k}: ` + a.map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' '))
    }
  }
  const setValue = (sel, v) => {
    const el = document.querySelector(sel)
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  let progress = null
  try {
    report(`ua=${navigator.userAgent} VideoDecoder=${typeof VideoDecoder} RTCPeerConnection=${typeof RTCPeerConnection}`)
    report('probe ' + JSON.stringify(await invoke('media_probe')))
    if (typeof VideoDecoder !== 'undefined') {
      for (const codec of ['avc1.42e01f', 'avc1.640028']) {
        const r = await VideoDecoder.isConfigSupported({ codec }).catch((e) => ({ error: String(e) }))
        report(`isConfigSupported ${codec}: ${JSON.stringify(r.supported !== undefined ? r.supported : r)}`)
      }
    }
    await waitFor('start view', () => document.querySelector('#join-code') && window.__st && window.__st.view === 'start', 30000)
    if (document.querySelector('#name')) setValue('#name', cfg.name)
    setValue('#join-code', cfg.code)
    await waitFor('join button enabled', () => document.querySelector('#join-btn') && document.querySelector('#join-btn').disabled === false, 5000)
    document.querySelector('#join-btn').click()
    await waitFor('tunnel view', () => window.__st.view === 'tunnel' && window.__st.tunnel, 30000)
    report('in tunnel as ' + window.__st.room.selfId)
    await waitFor('a broker', () => window.__st.room.status().connected > 0, 30000)
    report('brokers ' + JSON.stringify(window.__st.room.status()))
    await waitFor(
      'live member + watch button',
      () => {
        const b = document.querySelector('[data-member-id][data-live="true"] .watch-btn')
        if (!b || b.disabled) return false
        b.click()
        return true
      },
      60000,
    )
    report('watching ' + window.__st.watching)
    progress = setInterval(() => report(`state=${window.__st.viewerState} stats=${JSON.stringify(window.__st.stats)} native=${JSON.stringify(native())}`), 3000)
    await waitFor('connected', () => window.__st.viewerState === 'connected', 60000)
    report('connected')
    await waitFor('60 decoded frames', () => (native() ? native().framesDecoded : 0) >= 60, 40000)
    const canvas = document.querySelector('#viewer-canvas')
    if (!canvas) throw new Error('no #viewer-canvas in the watch view')
    const sample = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 36
      const x = c.getContext('2d')
      x.drawImage(canvas, 0, 0, 64, 36)
      const d = x.getImageData(0, 0, 64, 36).data
      let sum = 0
      let bright = 0
      let hash = 0
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] + d[i + 1] + d[i + 2]
        sum += v
        if (v > 60) bright++
        hash = (hash * 31 + v) >>> 0
      }
      return { avg: Math.round(sum / (d.length / 4) / 3), bright, hash }
    }
    const s1 = sample()
    await sleep(1500)
    const s2 = sample()
    await waitFor('inbound fps > 10', () => window.__st.stats && window.__st.stats.fps > 10, 15000)
    await sleep(2500) // one more stats round (audio bitrate)
    clearInterval(progress)
    const stats = window.__st.stats
    const result = { s1, s2, canvas: [canvas.width, canvas.height], stats, native: native() }
    const ok = s1.bright > 100 && s1.hash !== s2.hash && stats.width > 0
    report('RESULT ' + JSON.stringify(result), true, ok)
  } catch (e) {
    if (progress) clearInterval(progress)
    report(`FAILED: ${(e && e.message) || e} state=${window.__st && window.__st.viewerState} native=${JSON.stringify(native())}`, true, false)
  }
})()

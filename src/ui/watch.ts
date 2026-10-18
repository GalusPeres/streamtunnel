// Watch view: full-window video (no chrome when idle), separate <audio>, auto-hiding top/bottom strips,
// HUD stats (S), keyboard (F/Esc/S/M/L), fullscreen, mini player, wake lock.
// Rule: nothing animated, filtered, transformed or rounded on/over the playing video.
import type { AppSettings } from '../settings.ts'
import type { CtlMessage, HostInfo, InboundStats, IViewerSession, LatencyMode, ViewerState } from '../types.ts'
import { isDesktop, isFullscreen, keepAwake, setFullscreen, setMiniPlayer } from '../platform.ts'
import { isSettingsOpen } from './settingsheet.ts'
import { windowButtons } from './titlebar.ts'
import { button, clear, h, icon, iconButton, setHidden, setText } from './dom.ts'
import type { View } from './dom.ts'
import { codecLabel, connLabel, dec, mbit } from './format.ts'
import { toast } from './toast.ts'

const IDLE_MS = 2500
type HostTx = Extract<CtlMessage, { t: 'tx' }>

export interface WatchActions {
  /** back to the tunnel (stops watching) */
  back(): void
  /** watch the same member again with a fresh session */
  retry(): void
  openSettings(): void
  /** volume / mute / latency mode changed → persist */
  settingsChanged(): void
}

export interface WatchView extends View {
  attach(session: IViewerSession): void
}

const LATENCY_LABEL: Record<LatencyMode, string> = { lowest: 'Niedrigste Latenz', smooth: 'Flüssig' }

export function mountWatch(ctx: { name: string; title: string; settings: AppSettings; actions: WatchActions }): WatchView {
  const { settings, actions } = ctx

  let session: IViewerSession | null = null
  let state: ViewerState = 'waiting'
  let detail: string | undefined
  let info: HostInfo | null = null
  let stats: InboundStats | null = null
  let tx: HostTx | null = null
  let destroyed = false

  const video = h('video', { id: 'viewer-video', autoplay: true, playsinline: true, muted: true, disableremoteplayback: true })
  video.muted = true // sound comes from the separate <audio> (no A/V sync delay on the picture)
  const audio = h('audio', { id: 'viewer-audio', autoplay: true })
  audio.volume = settings.volume
  audio.muted = settings.muted

  // ── top strip (also the window's drag area) ──
  const backBtn = h('button', { type: 'button', class: 'back-label', id: 'back-btn', title: 'Zurück zum Tunnel (Esc)', onclick: () => actions.back() }, icon('back'), h('span', null, 'Zurück'))
  const liveTag = h('span', { class: 'live-tag', hidden: true }, 'LIVE')
  const lat = h('span', { class: 'lat', id: 'latency-badge', title: 'Geschätzte Verzögerung bis zu dir' })
  const via = h('span', { class: 'via' })
  const win = windowButtons()
  const top = h(
    'div',
    { class: 'w-top' },
    backBtn,
    h('div', { class: 'drag', 'data-tauri-drag-region': true }, h('span', { class: 'who' }, ctx.name), h('span', { class: 'via' }, ctx.title), liveTag, lat, via),
    win.el,
  )

  // ── bottom strip ──
  const muteBtn = iconButton('volume', 'Stumm (M)', { id: 'mute-btn', onclick: () => toggleMute() })
  const volume = h('input', { id: 'volume', type: 'range', class: 'range volume', min: 0, max: 100, step: 1, value: Math.round(settings.volume * 100), 'aria-label': 'Lautstärke' })
  const modeBtn = h('button', { type: 'button', class: 'mode', id: 'latency-btn', title: 'Latenzmodus (L)', onclick: () => toggleLatency() }, LATENCY_LABEL[settings.latencyMode])
  const statsBtn = iconButton('chart', 'Statistik (S)', { id: 'stats-btn', onclick: () => toggleHud() })
  const miniBtn = iconButton('pip', 'Mini-Player', { id: 'pin-btn', onclick: () => void toggleMini() })
  setHidden(miniBtn, !isDesktop() && !document.pictureInPictureEnabled)
  const fsBtn = iconButton('maximize', 'Vollbild (F)', { id: 'fs-btn', onclick: () => void toggleFs() })
  const bottom = h('div', { class: 'w-bottom' }, muteBtn, volume, h('span', { class: 'spacer' }), modeBtn, statsBtn, miniBtn, fsBtn)

  // ── HUD ──
  const hud = h('dl', { class: 'hud', id: 'stats-panel', hidden: true, 'aria-label': 'Statistik' })
  const hudRows = new Map<string, HTMLElement>()
  const HUD_ROWS: ReadonlyArray<readonly [string, string]> = [
    ['res', 'Bild'],
    ['rate', 'Daten'],
    ['lat', 'Latenz'],
    ['net', 'Netz'],
    ['loss', 'Verlust'],
    ['dec', 'Dekodierung'],
    ['enc', 'Kodierung'],
    ['path', 'Weg'],
  ]
  for (const [k, label] of HUD_ROWS) {
    const dd = h('dd', { class: k === 'lat' ? 'acc' : null }, '–')
    hudRows.set(k, dd)
    hud.append(h('dt', null, label), dd)
  }

  // ── state overlay ──
  const progress = h('div', { class: 'progress', 'aria-hidden': 'true' })
  const stTitle = h('h2', null)
  const stText = h('p', null)
  const stActs = h('div', { class: 'acts' })
  const overlay = h('div', { class: 'wstate', id: 'viewer-state', 'data-state': 'waiting', role: 'status', 'aria-live': 'polite' }, progress, stTitle, stText, stActs)
  const unmuteBtn = button('Klicken für Ton', { id: 'unmute-btn', cls: 'primary unmute', onclick: () => tryPlayAudio(true) })
  unmuteBtn.hidden = true

  const root = h('div', { class: 'watch', id: 'watch' }, video, audio, overlay, hud, top, bottom, unmuteBtn)

  // ───────────────────────── overlay ─────────────────────────

  function content(): { title: string; text: string; spin: boolean; acts: HTMLElement[] } | null {
    const back = () => button('Zurück zum Tunnel', { id: 'back-home-btn', onclick: () => actions.back() })
    const retry = (label: string) => button(label, { id: 'retry-btn', cls: 'primary', onclick: () => actions.retry() })
    switch (state) {
      case 'waiting':
        return { title: `Verbinde mit ${ctx.name}…`, text: '', spin: true, acts: [] }
      case 'connecting':
        return { title: `Verbinde mit ${ctx.name}…`, text: 'Direkte Verbindung wird aufgebaut.', spin: true, acts: [] }
      case 'connected':
        return info?.paused ? { title: 'Pausiert', text: `${ctx.name} wählt gerade eine neue Quelle.`, spin: false, acts: [] } : null
      case 'reconnecting':
        return { title: 'Verbindung unterbrochen', text: 'Verbinde neu…', spin: true, acts: [] }
      case 'ended':
        return { title: 'Stream beendet', text: `${ctx.name} teilt nicht mehr.`, spin: false, acts: [back()] }
      case 'kicked':
        return { title: 'Entfernt', text: `${ctx.name} hat dich aus dem Stream entfernt.`, spin: false, acts: [back()] }
      case 'rejected':
        if (detail === 'denied') return { title: 'Abgelehnt', text: `${ctx.name} hat deine Anfrage abgelehnt.`, spin: false, acts: [back()] }
        if (detail === 'locked') return { title: 'Gesperrt', text: `${ctx.name} lässt gerade keine neuen Zuschauer zu.`, spin: false, acts: [retry('Erneut versuchen'), back()] }
        return { title: 'Gerade voll', text: 'Keine freien Plätze. Versuch es gleich noch einmal.', spin: false, acts: [retry('Erneut versuchen'), back()] }
      case 'failed':
        return {
          title: 'Keine direkte Verbindung',
          text: 'Eine Firewall oder ein strenges NAT (Mobilfunk, CGNAT, VPN) blockiert die Verbindung. Anderes Netz probieren oder in den Einstellungen einen TURN-Server eintragen.',
          spin: false,
          acts: [retry('Erneut versuchen'), button('Einstellungen', { onclick: () => actions.openSettings() }), back()],
        }
    }
  }

  let overlayKey = ''
  function renderOverlay(): void {
    overlay.dataset.state = state
    const key = `${state}|${detail ?? ''}|${info?.paused === true}`
    if (key !== overlayKey) {
      overlayKey = key
      const c = content()
      setHidden(overlay, c === null)
      if (c) {
        setHidden(progress, !c.spin)
        setText(stTitle, c.title)
        setText(stText, c.text)
        setHidden(stText, !c.text)
        clear(stActs)
        stActs.append(...c.acts)
      }
    }
    const live = state === 'connected' && info?.paused !== true
    setHidden(liveTag, !live)
    if (!live) setIdle(false)
    else poke()
  }

  function setState(s: ViewerState, d?: string): void {
    state = s
    detail = d
    if (s === 'connected') keepAwake(true)
    if (s === 'ended' || s === 'kicked' || s === 'rejected' || s === 'failed') {
      video.srcObject = null
      audio.srcObject = null
      setHidden(unmuteBtn, true)
      stats = null
      setText(lat, '')
    }
    renderOverlay()
  }

  // ───────────────────────── audio ─────────────────────────

  function tryPlayAudio(fromClick = false): void {
    if (!audio.srcObject) {
      setHidden(unmuteBtn, true)
      return
    }
    audio.play().then(
      () => setHidden(unmuteBtn, true),
      () => {
        setHidden(unmuteBtn, false)
        if (fromClick) toast('Ton konnte nicht gestartet werden.', 'warn')
      },
    )
  }

  function renderVolume(): void {
    const silent = audio.muted || audio.volume === 0
    muteBtn.replaceChildren(icon(silent ? 'mute' : 'volume'))
    muteBtn.setAttribute('aria-pressed', String(audio.muted))
  }

  function toggleMute(): void {
    audio.muted = !audio.muted
    if (!audio.muted && audio.volume === 0) {
      audio.volume = 0.5
      volume.value = '50'
    }
    settings.muted = audio.muted
    settings.volume = audio.volume
    actions.settingsChanged()
    renderVolume()
    if (!audio.muted) tryPlayAudio()
  }

  volume.addEventListener('input', () => {
    audio.volume = Math.min(1, Math.max(0, Number(volume.value) / 100))
    if (audio.volume > 0 && audio.muted) audio.muted = false
    settings.volume = audio.volume
    settings.muted = audio.muted
    actions.settingsChanged()
    renderVolume()
  })

  // ───────────────────────── HUD ─────────────────────────

  function renderHud(): void {
    const s = stats
    const set = (k: string, v: string) => {
      const el = hudRows.get(k)
      if (el) setText(el, v)
    }
    const hw = (v: boolean | null | undefined) => (v === true ? 'GPU' : v === false ? 'CPU' : '?')
    set('enc', tx ? `${hw(tx.hw)}${tx.encodeMs !== null ? `  ${dec(tx.encodeMs)} ms` : ''}` : '–')
    set('path', info ? (info.hops <= 1 ? 'direkt' : `${info.hops - 1}× weitergereicht`) : '–')
    if (!s) return
    set('res', s.height > 0 ? `${s.height}p  ${Math.round(s.fps)} FPS` : '–')
    set('rate', `${mbit(s.bitrateKbps)}  ${codecLabel(s.codec || info?.codec)}`)
    set('lat', s.latencyMs !== null ? `~${Math.round(s.latencyMs)} ms` : '–')
    set('net', `${connLabel(s.connType)}  Ping ${s.rttMs !== null ? Math.round(s.rttMs) : '–'}  Puffer ${s.jitterBufferMs !== null ? Math.round(s.jitterBufferMs) : '–'}`)
    set('loss', `${dec(s.lossPct)} %  ${s.framesDropped} verworfen`)
    set('dec', `${hw(s.hw)}${s.decodeMs !== null ? `  ${dec(s.decodeMs)} ms` : ''}`)
  }

  function toggleHud(): void {
    const show = hud.hidden
    setHidden(hud, !show)
    statsBtn.setAttribute('aria-pressed', String(show))
    if (show) renderHud()
  }

  function toggleLatency(): void {
    settings.latencyMode = settings.latencyMode === 'lowest' ? 'smooth' : 'lowest'
    session?.setLatencyMode(settings.latencyMode)
    actions.settingsChanged()
    setText(modeBtn, LATENCY_LABEL[settings.latencyMode])
  }

  // ───────────────────────── fullscreen / mini ─────────────────────────

  let fs = false
  let mini = false

  function renderFs(): void {
    root.classList.toggle('fs', fs)
    fsBtn.replaceChildren(icon(fs ? 'minimize' : 'maximize'))
    fsBtn.setAttribute('aria-pressed', String(fs))
  }

  async function toggleMini(): Promise<void> {
    if (isDesktop()) {
      const want = !mini
      if (await setMiniPlayer(want)) mini = want
    } else {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture()
        else await video.requestPictureInPicture()
      } catch {
        toast('Mini-Player ist gerade nicht möglich.', 'warn')
      }
      mini = document.pictureInPictureElement === video
    }
    if (destroyed) return
    root.classList.toggle('mini', mini)
    miniBtn.setAttribute('aria-pressed', String(mini))
  }

  async function toggleFs(force?: boolean): Promise<void> {
    if (mini) await toggleMini()
    await setFullscreen(force ?? !fs)
    if (destroyed) return
    fs = await isFullscreen()
    renderFs()
  }

  const onFsChange = () => {
    void isFullscreen().then((v) => {
      if (destroyed) return
      fs = v
      renderFs()
    })
  }

  // ───────────────────────── idle / auto-hide ─────────────────────────

  let idle = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lastMove = 0
  let inBars = 0

  function setIdle(v: boolean): void {
    if (idle === v) return
    idle = v
    root.classList.toggle('idle', v)
  }
  function check(): void {
    idleTimer = null
    const dt = performance.now() - lastMove
    if (dt < IDLE_MS) {
      idleTimer = setTimeout(check, IDLE_MS - dt)
      return
    }
    // Only hide while the picture is live and nothing is hovered.
    if (state === 'connected' && info?.paused !== true && inBars === 0) setIdle(true)
  }
  function poke(): void {
    lastMove = performance.now()
    setIdle(false)
    if (!idleTimer && !destroyed) idleTimer = setTimeout(check, IDLE_MS)
  }
  root.addEventListener('pointermove', poke, { passive: true })
  root.addEventListener('pointerdown', poke, { passive: true })
  for (const bar of [top, bottom]) {
    bar.addEventListener('pointerenter', () => inBars++)
    bar.addEventListener('pointerleave', () => {
      inBars = Math.max(0, inBars - 1)
      poke()
    })
    // A clicked control must not keep the strips pinned: drop focus after mouse clicks (keyboard focus stays).
    bar.addEventListener('pointerup', () => {
      const a = document.activeElement
      if (a instanceof HTMLElement && a !== volume && bar.contains(a)) a.blur()
    })
  }
  video.addEventListener('dblclick', () => void toggleFs())
  video.addEventListener('click', () => {
    if (!unmuteBtn.hidden) tryPlayAudio(true)
  })

  const onKey = (e: KeyboardEvent) => {
    if (destroyed || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isSettingsOpen()) return
    const t = e.target as HTMLElement | null
    if (t && ((t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement || t.isContentEditable)) return
    switch (e.key.toLowerCase()) {
      case 'f':
        void toggleFs()
        break
      case 'escape':
        if (fs) void toggleFs(false)
        else if (mini) void toggleMini()
        else actions.back()
        break
      case 's':
        toggleHud()
        break
      case 'm':
        toggleMute()
        break
      case 'l':
        toggleLatency()
        break
      default:
        return
    }
    e.preventDefault()
    poke()
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFsChange)

  renderVolume()
  renderFs()
  renderOverlay()

  return {
    el: root,
    attach(s) {
      session = s
      s.onState = (st, d) => {
        if (!destroyed) setState(st, d)
      }
      s.onVideo = (stream) => {
        if (destroyed) return
        video.srcObject = stream
        void video.play().catch(() => {})
      }
      s.onAudio = (stream) => {
        if (destroyed) return
        audio.srcObject = stream
        tryPlayAudio()
      }
      s.onHostInfo = (i) => {
        if (destroyed) return
        info = i
        setText(via, i.hops > 1 ? 'weitergereicht' : '')
        renderOverlay()
        if (!hud.hidden) renderHud()
      }
      s.onHostTx = (t) => {
        if (destroyed) return
        tx = t
        if (!hud.hidden) renderHud()
      }
      s.onStats = (st) => {
        if (destroyed) return
        stats = st
        setText(lat, state === 'connected' && st.latencyMs !== null ? `${Math.round(st.latencyMs)} ms` : '')
        if (!hud.hidden) renderHud()
      }
      setState(s.state())
    },
    destroy() {
      destroyed = true
      if (session) {
        session.onState = () => {}
        session.onVideo = () => {}
        session.onAudio = () => {}
        session.onHostInfo = () => {}
        session.onHostTx = () => {}
        session.onStats = () => {}
      }
      session = null
      if (idleTimer) clearTimeout(idleTimer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFsChange)
      win.destroy()
      if (fs) void setFullscreen(false)
      if (mini) void (isDesktop() ? setMiniPlayer(false) : document.exitPictureInPicture().catch(() => {}))
      audio.pause()
      video.pause()
      video.srcObject = null
      audio.srcObject = null
    },
  }
}

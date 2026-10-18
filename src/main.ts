// UI entry: frameless window shell + tunnel flow (start → tunnel → share / watch). Views live in src/ui/*.
import './styles.css'
import type { HostInfo, IHostSession, InboundStats, IViewerSession, StreamSettings, TunnelMember, ViewerState } from './types.ts'
import type { AppSettings } from './settings.ts'
import { displayName, flushSettings, loadSettings, saveSettingsSoon } from './settings.ts'
import { ensureMinWindowHeight, isTauri, keepAwake } from './platform.ts'
import { generateCode } from './core/code.ts'
import { randomId } from './core/crypto.ts'
import { SignalingRoom } from './signaling/room.ts'
import { CaptureError, captureScreen, describeCapture, makeTestStream } from './rtc/capture.ts'
import { TunnelSession } from './rtc/tunnel.ts'
import { clear, h } from './ui/dom.ts'
import type { View } from './ui/dom.ts'
import { titleBar } from './ui/titlebar.ts'
import { mountStart } from './ui/start.ts'
import type { StartView } from './ui/start.ts'
import { mountTunnel } from './ui/tunnelview.ts'
import type { MyShare, TunnelView } from './ui/tunnelview.ts'
import { mountWatch } from './ui/watch.ts'
import type { WatchView } from './ui/watch.ts'
import { openSettings } from './ui/settingsheet.ts'
import { prettyCode } from './ui/format.ts'
import { toast } from './ui/toast.ts'
import { mountDemo } from './ui/demo.ts'

type ViewName = 'start' | 'tunnel'

/** Live app state; also exposed as window.__st for debugging / E2E tests. */
interface AppState {
  settings: AppSettings
  view: ViewName
  room: SignalingRoom | null
  tunnel: TunnelSession | null
  code: string | null
  members: TunnelMember[]
  /** our capture while sharing */
  stream: MediaStream | null
  share: MyShare | null
  host: IHostSession | null
  /** member id we watch, or null */
  watching: string | null
  viewer: IViewerSession | null
  viewerState: ViewerState | null
  stats: InboundStats | null
  statsAt: number
  hostInfo: HostInfo | null
  /** ?test only: replace our live source with a fresh test stream */
  switchToTestStream?: () => Promise<void>
}

declare global {
  interface Window {
    __st: AppState
  }
}

const params = new URLSearchParams(location.search)
const TEST_MODE = params.has('test')
const ROOM_CLOSE_DELAY_MS = 300
const PICKER_MIN_HEIGHT = 680

const state: AppState = {
  settings: loadSettings(),
  view: 'start',
  room: null,
  tunnel: null,
  code: null,
  members: [],
  stream: null,
  share: null,
  host: null,
  watching: null,
  viewer: null,
  viewerState: null,
  stats: null,
  statsAt: 0,
  hostInfo: null,
}
window.__st = state

// ───────────────────────── shell ─────────────────────────

const bar = titleBar({ onSettings: () => openSettings(state.settings, () => saveSettingsSoon(state.settings)) })
const content = h('div', { class: 'content', style: 'min-height:0;display:grid' })
const appRoot = document.getElementById('app') ?? document.body
clear(appRoot)
appRoot.append(h('div', { class: 'frame' }, bar.el, content))

let current: View | null = null
function show<T extends View>(name: ViewName, view: T): T {
  if (current) {
    try { current.destroy() } catch { /* ignore */ }
  }
  clear(content)
  current = view
  state.view = name
  content.append(view.el)
  return view
}

let busy = false
async function exclusive(fn: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  try {
    await fn()
  } catch (err) {
    toast(`Unerwarteter Fehler: ${errText(err)}`, 'error')
  } finally {
    busy = false
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err)
}

function stopTracks(stream: MediaStream | null): void {
  for (const t of stream?.getTracks() ?? []) {
    try { t.stop() } catch { /* ignore */ }
  }
}

function saveSoon(): void {
  saveSettingsSoon(state.settings)
}

// ───────────────────────── start ─────────────────────────

function goStart(prefill?: string): StartView {
  bar.setExtra('')
  return show(
    'start',
    mountStart({
      settings: state.settings,
      prefill,
      actions: {
        join: (code) => void exclusive(() => enterTunnel(code)),
        create: () => void exclusive(() => enterTunnel(generateCode())),
        nameChanged: saveSoon,
      },
    }),
  )
}

// ───────────────────────── tunnel ─────────────────────────

let tunnelView: TunnelView | null = null

async function enterTunnel(code: string): Promise<void> {
  if (state.tunnel) return
  const start = current as StartView
  start.setBusy(true)
  let room: SignalingRoom
  try {
    room = await SignalingRoom.open({ code, selfId: randomId(8), brokers: state.settings.net.brokers })
  } catch (err) {
    start.setBusy(false)
    start.showError(`Tunnel konnte nicht geöffnet werden: ${errText(err)}`)
    return
  }
  const s = state.settings
  const tunnel = new TunnelSession({ room, name: displayName(s), net: s.net, allowRelay: s.allowRelay, latencyMode: s.latencyMode })
  state.room = room
  state.tunnel = tunnel
  state.code = room.code || code
  tunnelView = show(
    'tunnel',
    mountTunnel({
      code: state.code,
      showTest: TEST_MODE || s.showTestStream,
      actions: {
        share: () => void exclusive(() => startShare(false)),
        shareTest: () => void exclusive(() => startShare(true)),
        stopShare,
        switchSource: () => void switchSource(false),
        watch,
        leave: leaveTunnel,
        kick: (id) => state.host?.kick(id),
        decide: (id, ok) => decide(id, ok),
        updateSettings,
        setLocked: (on) => state.host?.setLocked(on),
      },
    }),
  )
  bar.setExtra(prettyCode(state.code))
  tunnel.onMembers = (m) => {
    state.members = m
    tunnelView?.setMembers(m)
  }
  tunnel.onNotice = (msg) => toast(msg, 'warn')
  tunnel.start()
  tunnelView.setMembers(tunnel.members())
}

function leaveTunnel(): void {
  closeWatch()
  const { tunnel, room, stream } = state
  try { tunnel?.leave() } catch { /* ignore */ }
  stopTracks(stream)
  keepAwake(false)
  state.tunnel = null
  state.room = null
  state.code = null
  state.members = []
  state.stream = null
  state.share = null
  state.host = null
  tunnelView = null
  if (room) setTimeout(() => { try { room.close() } catch { /* ignore */ } }, ROOM_CLOSE_DELAY_MS)
  goStart()
}

// ───────────────────────── sharing ─────────────────────────

const pending = new Map<string, (ok: boolean) => void>()
let trackWatch: AbortController | null = null
let switching = false

function bounded(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])
}

function reportCaptureError(err: unknown): void {
  if (err instanceof CaptureError) {
    if (err.kind !== 'cancelled') toast(err.message, 'error')
  } else toast(`Teilen fehlgeschlagen: ${errText(err)}`, 'error')
}

async function capture(test: boolean): Promise<{ stream: MediaStream; title: string; audio: boolean }> {
  const stream = test ? makeTestStream(state.settings.stream.fps) : (await bounded(ensureMinWindowHeight(PICKER_MIN_HEIGHT), 500), await captureScreen(state.settings.stream))
  const info = describeCapture(stream)
  let title = test ? 'Testbild' : info.label
  if (!test && info.surface === 'window') title = (await nativeWindowTitle(stream)) ?? title
  return { stream, title, audio: info.hasAudio }
}

/** Real window title (e.g. the game's name) via the Rust side; the browser only exposes "window:<hwnd>:0". */
async function nativeWindowTitle(stream: MediaStream): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const id = stream.getVideoTracks()[0]?.getSettings().deviceId ?? ''
    const m = /^window:(\d+):/.exec(id)
    if (!m) return null
    const { invoke } = await import('@tauri-apps/api/core')
    const t = await invoke<string | null>('window_title', { hwnd: Number(m[1]) })
    return t && t.trim() ? t.trim().slice(0, 60) : null
  } catch {
    return null
  }
}

function audioWarning(hasAudio: boolean): string | null {
  if (hasAudio || !state.settings.stream.audio) return null
  return 'Kein Ton: Quelle wechseln und im Dialog „App-Audio ebenfalls teilen“ (bzw. „Systemaudio“) einschalten.'
}

async function startShare(test: boolean): Promise<void> {
  const tunnel = state.tunnel
  if (!tunnel || state.host) return
  tunnelView?.setBusy(test ? 'Testbild startet…' : 'Wähle im Dialog dein Fenster oder deinen Bildschirm…')
  let cap: Awaited<ReturnType<typeof capture>>
  try {
    cap = await capture(test)
  } catch (err) {
    tunnelView?.setBusy(null)
    reportCaptureError(err)
    return
  }
  tunnelView?.setBusy(null)
  if (state.tunnel !== tunnel) {
    stopTracks(cap.stream)
    return
  }
  const s = state.settings
  tunnel.setPrefs({ net: s.net, allowRelay: s.allowRelay, latencyMode: s.latencyMode })
  let host: IHostSession
  try {
    host = tunnel.share(cap.stream, { ...s.stream }, cap.title, { maxDirect: s.maxDirect, uploadLimitKbps: s.uploadLimitKbps, requireApproval: s.requireApproval })
  } catch (err) {
    stopTracks(cap.stream)
    toast(`Teilen konnte nicht gestartet werden: ${errText(err)}`, 'error')
    return
  }
  state.host = host
  state.stream = cap.stream
  state.share = { title: cap.title, audio: cap.audio, since: Date.now(), test }
  host.onViewersChanged = (v) => tunnelView?.setViewers(v, host.relayedCount())
  host.onJoinRequest = (viewer, allow) => {
    pending.set(viewer.id, allow)
    tunnelView?.setViewers(host.viewers(), host.relayedCount())
    toast(`${viewer.name} möchte zuschauen – unter „Du teilst“ zulassen oder ablehnen.`, 'info', 8000)
  }
  tunnelView?.setShare(state.share, s.stream)
  tunnelView?.setViewers(host.viewers(), host.relayedCount())
  tunnelView?.setWarning(audioWarning(cap.audio))
  watchTrack(cap.stream)
  keepAwake(true)
}

function decide(id: string, ok: boolean): void {
  const allow = pending.get(id)
  pending.delete(id)
  allow?.(ok)
}

/** Capture ended from outside (window closed, "Freigabe beenden") → pause watchers, ask for a new source. */
function watchTrack(stream: MediaStream): void {
  trackWatch?.abort()
  trackWatch = new AbortController()
  const track = stream.getVideoTracks()[0]
  const onEnded = () => {
    if (state.stream !== stream || !state.host) return
    state.host.setPaused(true)
    tunnelView?.setWarning('Aufnahme beendet – Quelle wechseln oder Beenden.')
    if (watchView) toast('Deine Aufnahme wurde beendet – Quelle wechseln oder Beenden.', 'warn')
  }
  track?.addEventListener('ended', onEnded, { signal: trackWatch.signal })
  if (track?.readyState === 'ended') onEnded()
}

async function switchSource(test: boolean): Promise<void> {
  if (switching || !state.host || !state.tunnel) return
  switching = true
  try {
    const cap = await capture(test)
    const host = state.host
    if (!host) {
      stopTracks(cap.stream)
      return
    }
    const old = state.stream
    await host.replaceStream(cap.stream)
    if (state.host !== host) {
      stopTracks(cap.stream)
      return
    }
    state.stream = cap.stream
    state.share = { ...(state.share as MyShare), title: cap.title, audio: cap.audio, test }
    state.tunnel?.setLiveTitle(cap.title)
    tunnelView?.setShare(state.share, state.settings.stream)
    tunnelView?.setWarning(audioWarning(cap.audio))
    watchTrack(cap.stream)
    if (old && old !== cap.stream) stopTracks(old)
  } catch (err) {
    reportCaptureError(err)
  } finally {
    switching = false
  }
}
if (TEST_MODE) state.switchToTestStream = () => switchSource(true)

function updateSettings(next: StreamSettings): void {
  // The dock only edits fps / content / bitrate — keep everything else from the (possibly newer) saved settings.
  const merged: StreamSettings = { ...state.settings.stream, fps: next.fps, content: next.content, bitrateKbps: next.bitrateKbps }
  state.settings.stream = merged
  saveSoon()
  void state.host?.updateSettings({ ...merged })
}

function stopShare(): void {
  if (!state.host) return
  trackWatch?.abort()
  trackWatch = null
  pending.clear()
  try { state.tunnel?.stopSharing() } catch { /* ignore */ }
  stopTracks(state.stream)
  state.stream = null
  state.share = null
  state.host = null
  if (!state.viewer) keepAwake(false)
  tunnelView?.setShare(null, state.settings.stream)
  tunnelView?.setWarning(null)
}

// ───────────────────────── watching ─────────────────────────

let watchView: WatchView | null = null

function watch(memberId: string): void {
  const tunnel = state.tunnel
  const room = state.room
  if (!tunnel || !room) return
  const member = state.members.find((m) => m.id === memberId)
  if (!member || !member.live || member.self) {
    if (watchView) {
      closeWatch()
      toast(member ? `${member.name} teilt gerade nicht mehr.` : 'Dieses Mitglied ist nicht mehr im Tunnel.', 'info')
    }
    return
  }
  closeWatch()
  const s = state.settings
  tunnel.setPrefs({ net: s.net, allowRelay: s.allowRelay, latencyMode: s.latencyMode })
  let viewer: IViewerSession
  try {
    viewer = tunnel.watch(memberId)
  } catch (err) {
    toast(`Ansehen nicht möglich: ${errText(err)}`, 'error')
    return
  }
  state.watching = memberId
  state.viewer = viewer
  state.stats = null
  state.statsAt = 0
  state.hostInfo = null
  state.viewerState = viewer.state()
  watchView = mountWatch({
    name: member.name,
    title: member.live.title,
    settings: state.settings,
    actions: {
      back: closeWatch,
      retry: () => watch(memberId),
      openSettings: () => openSettings(state.settings, saveSoon),
      settingsChanged: saveSoon,
    },
  })
  document.body.append(watchView.el)
  watchView.attach(viewer)
  tap(viewer)
}

/** Mirrors the session's latest stats / info / state into window.__st (after the view wired its callbacks). */
function tap(viewer: IViewerSession): void {
  const ui = { stats: viewer.onStats, info: viewer.onHostInfo, state: viewer.onState }
  viewer.onStats = (s) => {
    if (state.viewer === viewer) {
      state.stats = s
      state.statsAt = Date.now()
    }
    ui.stats(s)
  }
  viewer.onHostInfo = (i) => {
    if (state.viewer === viewer) state.hostInfo = i
    ui.info(i)
  }
  viewer.onState = (s, d) => {
    if (state.viewer === viewer) state.viewerState = s
    ui.state(s, d)
  }
}

function closeWatch(): void {
  if (state.viewer) {
    try { state.tunnel?.stopWatching() } catch { /* ignore */ }
  }
  state.viewer = null
  state.watching = null
  state.viewerState = null
  if (watchView) {
    try { watchView.destroy() } catch { /* ignore */ }
    watchView.el.remove()
    watchView = null
  }
  keepAwake(state.host !== null)
}

// ───────────────────────── lifecycle ─────────────────────────

let shutDown = false
function shutdown(): void {
  if (shutDown) return
  shutDown = true
  flushSettings()
  try { state.tunnel?.leave() } catch { /* ignore */ }
  stopTracks(state.stream)
  keepAwake(false)
}
window.addEventListener('pagehide', shutdown)
window.addEventListener('beforeunload', shutdown)

const demo = params.get('demo')
if (demo) {
  bar.setExtra('K7F3Q-X9MZD')
  mountDemo(demo, content, state.settings)
} else {
  goStart(params.get('join') ?? undefined)
}

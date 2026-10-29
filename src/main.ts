// UI entry: frameless window shell + tunnel flow (start → tunnel → share / watch). Views live in src/ui/*.
import './styles.css'
import './theme-b.css'
import type { HostInfo, IHostSession, InboundStats, IViewerSession, StreamSettings, TunnelMember, ViewerState } from './types.ts'
import type { AppSettings } from './settings.ts'
import { displayName, flushSettings, loadSettings, saveSettingsSoon } from './settings.ts'
import { electron, ensureMinWindowHeight, hideShareBar, isElectron, isMacApp, isTauri, keepAwake } from './platform.ts'
import { generateCode } from './core/code.ts'
import { randomId } from './core/crypto.ts'
import { SignalingRoom } from './signaling/room.ts'
import { CaptureError, captureScreen, describeCapture, makeTestStream } from './rtc/capture.ts'
import { hwndOf, nativeShareAudioSupported, probeNativeShareAudio, startNativeShareAudio } from './rtc/sysaudio.ts'
import { TunnelSession } from './rtc/tunnel.ts'
import { clear, h } from './ui/dom.ts'
import type { View } from './ui/dom.ts'
import { titleBar } from './ui/titlebar.ts'
import { mountStart, rememberTunnel } from './ui/start.ts'
import { NAME_EVENT, userPanel } from './ui/userpanel.ts'
import type { StartView } from './ui/start.ts'
import { mountTunnel } from './ui/tunnelview.ts'
import type { MyShare, TunnelView } from './ui/tunnelview.ts'
import { mountWatch } from './ui/watch.ts'
import type { WatchView } from './ui/watch.ts'
import { openSettings } from './ui/settingsheet.ts'
import { prettyCode } from './ui/format.ts'
import { toast } from './ui/toast.ts'
import { watchForUpdates } from './update.ts'
import { getLang, resolveLang, t } from './i18n.ts'
import { mountDemo } from './ui/demo.ts'
import { installSourcePicker } from './ui/picker.ts'

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
  /** Windows app self-test of the native share sound (DevTools) */
  probeShareAudio?: typeof probeNativeShareAudio
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
if (isMacApp()) document.documentElement.classList.add('mac-app')
state.probeShareAudio = probeNativeShareAudio

// ───────────────────────── shell ─────────────────────────

const bar = titleBar()
watchForUpdates((offer) => bar.setUpdate(offer))
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
    toast(t('main.unexpected', { err: errText(err) }), 'error')
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

/** Settings sheet; a changed language reloads the UI (or, mid-tunnel, applies on the next start). */
function openSettingsSheet(): void {
  const before = state.settings.lang
  openSettings(state.settings, () => {
    saveSoon()
    state.tunnel?.setName(displayName(state.settings))
    document.dispatchEvent(new Event(NAME_EVENT))
    if (state.settings.lang === before || resolveLang(state.settings.lang) === getLang()) return
    if (state.tunnel || state.host || state.viewer) {
      toast(t('set.langNextStart'), 'info')
      return
    }
    flushSettings()
    const u = new URL(location.href)
    u.searchParams.delete('lang')
    location.replace(u.href)
  })
}

function makeUserPanel(): HTMLElement {
  return userPanel(state.settings, {
    onName: (name) => {
      saveSoon()
      state.tunnel?.setName(name)
    },
    onSettings: () => openSettingsSheet(),
  })
}

// ───────────────────────── start ─────────────────────────

function goStart(prefill?: string): StartView {
  bar.setExtra('')
  return show(
    'start',
    mountStart({
      settings: state.settings,
      prefill,
      user: makeUserPanel(),
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
    start.showError(t('main.openFailed', { err: errText(err) }))
    return
  }
  const s = state.settings
  const tunnel = new TunnelSession({ room, name: displayName(s), net: s.net, allowRelay: s.allowRelay, latencyMode: s.latencyMode })
  state.room = room
  state.tunnel = tunnel
  state.code = room.code || code
  rememberTunnel(state.code)
  tunnelView = show(
    'tunnel',
    mountTunnel({
      code: state.code,
      showTest: TEST_MODE || s.showTestStream,
      user: makeUserPanel(),
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
        openSettings: openSettingsSheet,
      },
    }),
  )
  bar.setExtra(prettyCode(state.code))
  tunnel.onMembers = (m) => {
    state.members = m
    if (state.code) rememberTunnel(state.code, m.filter((x) => !x.self).map((x) => x.name))
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
  } else toast(t('main.shareFailed', { err: errText(err) }), 'error')
}

/** The last capture used the app's own sound capture (no picker checkbox to point the user to). */
let lastCaptureNativeAudio = false

async function capture(test: boolean): Promise<{ stream: MediaStream; title: string; audio: boolean }> {
  // Windows app: the sound is captured natively (system sound without StreamTunnel, or just the shared program)
  const nativeAudio = !test && state.settings.stream.audio && (await nativeShareAudioSupported())
  const stream = test
    ? makeTestStream(state.settings.stream.fps)
    : (await bounded(ensureMinWindowHeight(PICKER_MIN_HEIGHT), 500), await captureScreen(state.settings.stream, { pickerAudio: !nativeAudio }))
  lastCaptureNativeAudio = nativeAudio
  if (!test) hideShareBar(true)
  if (nativeAudio) {
    const surface = describeCapture(stream).surface
    const hwnd = hwndOf(stream.getVideoTracks()[0])
    const track = surface === 'window' && hwnd === null ? null : await startNativeShareAudio(surface === 'window' ? hwnd : null).catch(() => null)
    if (track) stream.addTrack(track)
  }
  const info = describeCapture(stream)
  let title = test ? t('main.testTitle') : info.label
  if (!test && info.surface === 'window') title = (await nativeWindowTitle(stream)) ?? title
  return { stream, title, audio: info.hasAudio }
}

/** Real window title (e.g. the game's name) via the Rust side; the browser only exposes "window:<hwnd>:0". */
async function nativeWindowTitle(stream: MediaStream): Promise<string | null> {
  const el = electron()
  if (el) {
    try {
      const t = await el.windowTitle()
      return t && t.trim() ? t.trim().slice(0, 60) : null
    } catch {
      return null
    }
  }
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
  return t(lastCaptureNativeAudio ? 'main.noAudioNative' : 'main.noAudio')
}

async function startShare(test: boolean): Promise<void> {
  const tunnel = state.tunnel
  if (!tunnel || state.host) return
  tunnelView?.setBusy(test ? t('main.testStarting') : t('main.pickSource'))
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
    hideShareBar(false)
    return
  }
  const s = state.settings
  tunnel.setPrefs({ net: s.net, allowRelay: s.allowRelay, latencyMode: s.latencyMode })
  let host: IHostSession
  try {
    host = tunnel.share(cap.stream, { ...s.stream }, cap.title, { maxDirect: s.maxDirect, uploadLimitKbps: s.uploadLimitKbps, requireApproval: s.requireApproval })
  } catch (err) {
    stopTracks(cap.stream)
    hideShareBar(false)
    toast(t('main.startFailed', { err: errText(err) }), 'error')
    return
  }
  state.host = host
  state.stream = cap.stream
  state.share = { title: cap.title, audio: cap.audio, since: Date.now(), test }
  host.onViewersChanged = (v) => tunnelView?.setViewers(v, host.relayedCount())
  host.onJoinRequest = (viewer, allow) => {
    pending.set(viewer.id, allow)
    tunnelView?.setViewers(host.viewers(), host.relayedCount())
    toast(t('main.wantsToWatch', { name: viewer.name }), 'info', 8000)
  }
  tunnelView?.setShare(state.share, s.stream)
  tunnelView?.setPreview(state.stream)
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
    tunnelView?.setWarning(t('main.captureEnded'))
    if (watchView) toast(t('main.captureEndedToast'), 'warn')
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
    tunnelView?.setPreview(state.stream)
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
  // The dock edits resolution / fps / content / bitrate — keep everything else from the (possibly newer) saved settings.
  const merged: StreamSettings = { ...state.settings.stream, resolution: next.resolution, fps: next.fps, content: next.content, bitrateKbps: next.bitrateKbps }
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
  hideShareBar(false)
  state.stream = null
  state.share = null
  state.host = null
  if (!state.viewer) keepAwake(false)
  tunnelView?.setShare(null, state.settings.stream)
  tunnelView?.setPreview(null)
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
      toast(member ? t('main.memberStopped', { name: member.name }) : t('main.memberGone'), 'info')
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
    toast(t('main.watchFailed', { err: errText(err) }), 'error')
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
      openSettings: openSettingsSheet,
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
// Behave like an app, not a web page: no browser context menu (except in text fields) and no browser shortcuts
// (reload, print, save, find, zoom) that would break a running stream.
const isTextField = (el: EventTarget | null): boolean =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button'].includes(el.type))
document.addEventListener('contextmenu', (e) => {
  if (!isTextField(e.target)) e.preventDefault()
})
document.addEventListener(
  'keydown',
  (e) => {
    const k = e.key.toLowerCase()
    const ctrl = e.ctrlKey || e.metaKey
    if (k === 'f5' || k === 'f3' || k === 'f7' || (ctrl && ['r', 'p', 's', 'f', 'g', 'u', 'j', 'o', 'n', '+', '-', '=', '0'].includes(k)) || (ctrl && e.shiftKey && ['i', 'c', 'r'].includes(k))) {
      e.preventDefault()
    }
  },
  true,
)
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault() }, { passive: false })

window.addEventListener('pagehide', shutdown)
window.addEventListener('beforeunload', shutdown)

// Electron (Linux): our own source picker for getDisplayMedia (X11; Wayland uses the portal dialog).
if (isElectron()) installSourcePicker()

const demo = params.get('demo')
if (demo) {
  bar.setExtra('K7F3Q-X9MZD')
  mountDemo(demo, content, state.settings)
} else {
  goStart(params.get('join') ?? undefined)
}

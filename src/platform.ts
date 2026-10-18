// Thin platform layer: Tauri window/command APIs with browser fallbacks. Every function is safe to call in a
// plain browser (vite dev server) and never throws; Tauri modules are loaded lazily only inside Tauri.

type WindowModule = typeof import('@tauri-apps/api/window')
type TauriWindow = ReturnType<WindowModule['getCurrentWindow']>

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Screen/window offered by the Electron picker (X11; Wayland uses the system portal dialog). */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** PNG data URL, may be empty */
  thumbnail: string
}

/** window.__ELECTRON__ from electron/preload.cjs (Linux desktop build). */
export interface ElectronApi {
  platform: string
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximize(cb: (maximized: boolean) => void): () => void
  setFullscreen(on: boolean): Promise<boolean>
  isFullscreen(): Promise<boolean>
  setAlwaysOnTop(on: boolean): Promise<boolean>
  setMiniPlayer(on: boolean): Promise<boolean>
  keepAwake(on: boolean): void
  windowTitle(): Promise<string | null>
  pickSource(fn: ((list: CaptureSource[]) => Promise<string | null>) | null): void
}

function electronApi(): ElectronApi | null {
  if (typeof window === 'undefined') return null
  const api = (window as Window & { __ELECTRON__?: ElectronApi }).__ELECTRON__
  return api && typeof api === 'object' ? api : null
}

export function isElectron(): boolean {
  return electronApi() !== null
}

/** Electron bridge (null outside Electron). */
export function electron(): ElectronApi | null {
  return electronApi()
}

/** Desktop shell with our own window chrome (Tauri or Electron). */
export function isDesktop(): boolean {
  return isTauri() || isElectron()
}

let windowModule: Promise<WindowModule> | null = null
function tauriModule(): Promise<WindowModule> {
  windowModule ??= import('@tauri-apps/api/window')
  return windowModule
}
async function tauriWindow(): Promise<TauriWindow> {
  return (await tauriModule()).getCurrentWindow()
}

// ───────────────────────── fullscreen ─────────────────────────

/** Tauri tracks fullscreen per window; remember our own requests for cheap synchronous reads. */
let tauriFullscreen = false

export async function setFullscreen(on: boolean): Promise<boolean> {
  const el = electronApi()
  if (el) {
    try {
      await el.setFullscreen(on)
      tauriFullscreen = on
      return true
    } catch {
      /* fall back to the DOM Fullscreen API */
    }
  }
  if (isTauri()) {
    try {
      const w = await tauriWindow()
      await w.setFullscreen(on)
      tauriFullscreen = on
      return true
    } catch {
      /* fall back to the DOM Fullscreen API */
    }
  }
  try {
    if (on) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    }
    return true
  } catch {
    return false
  }
}

export async function isFullscreen(): Promise<boolean> {
  if (document.fullscreenElement) return true
  const el = electronApi()
  if (el) {
    try {
      tauriFullscreen = await el.isFullscreen()
    } catch {
      /* keep last known */
    }
    return tauriFullscreen
  }
  if (isTauri()) {
    try {
      tauriFullscreen = await (await tauriWindow()).isFullscreen()
      return tauriFullscreen
    } catch {
      return tauriFullscreen
    }
  }
  return false
}

/** Last known fullscreen state without an IPC round trip. */
export function isFullscreenSync(): boolean {
  return !!document.fullscreenElement || (isDesktop() && tauriFullscreen)
}

// ───────────────────────── window ─────────────────────────

/** Desktop only. Returns false when unsupported or refused. */
export async function setAlwaysOnTop(on: boolean): Promise<boolean> {
  const el = electronApi()
  if (el) {
    try {
      return await el.setAlwaysOnTop(on)
    } catch {
      return false
    }
  }
  if (!isTauri()) return false
  try {
    await (await tauriWindow()).setAlwaysOnTop(on)
    return true
  } catch {
    return false
  }
}

/**
 * Grows the window to at least `px` logical pixels of inner height (the screen picker breaks in short
 * windows). No-op in the browser, in fullscreen, when maximized, or when already tall enough.
 */
export async function ensureMinWindowHeight(px: number): Promise<void> {
  if (!isTauri()) return
  try {
    const mod = await tauriModule()
    const w = mod.getCurrentWindow()
    const [size, scale, fs, max] = await Promise.all([w.innerSize(), w.scaleFactor(), w.isFullscreen(), w.isMaximized()])
    if (fs || max || !(scale > 0)) return
    const logical = size.toLogical(scale)
    if (logical.height >= px) return
    let target = px
    try {
      const mon = await mod.currentMonitor()
      if (mon) {
        const monH = mon.size.toLogical(mon.scaleFactor).height
        if (monH > 0) target = Math.min(target, monH - 48)
      }
    } catch {
      /* unknown monitor size — use px */
    }
    if (target <= logical.height) return
    await w.setSize(new mod.LogicalSize(Math.max(760, Math.round(logical.width)), Math.round(target)))
  } catch {
    /* best effort */
  }
}

/** Frameless window controls (Tauri only; no-ops in the browser). */
export function minimizeWindow(): void {
  const el = electronApi()
  if (el) return el.minimize()
  if (isTauri()) void tauriWindow().then((w) => w.minimize()).catch(() => {})
}
export function toggleMaximizeWindow(): void {
  const el = electronApi()
  if (el) return el.toggleMaximize()
  if (isTauri()) void tauriWindow().then((w) => w.toggleMaximize()).catch(() => {})
}
export function closeWindow(): void {
  const el = electronApi()
  if (el) return el.close()
  if (isTauri()) void tauriWindow().then((w) => w.close()).catch(() => {})
}
/** Calls `cb(maximized)` now and on every resize; returns an unsubscribe function. */
export function watchMaximized(cb: (maximized: boolean) => void): () => void {
  const el = electronApi()
  if (el) {
    void el.isMaximized().then(cb, () => {})
    try {
      return el.onMaximize(cb)
    } catch {
      return () => {}
    }
  }
  if (!isTauri()) return () => {}
  let off: (() => void) | null = null
  let dead = false
  void tauriWindow()
    .then(async (w) => {
      cb(await w.isMaximized())
      const un = await w.onResized(() => void w.isMaximized().then(cb, () => {}))
      if (dead) un()
      else off = un
    })
    .catch(() => {})
  return () => {
    dead = true
    off?.()
  }
}

let miniRestore: { w: number; h: number } | null = null
/**
 * Mini player: small, always-on-top window (min size lifted). `false` restores the previous size.
 * Returns false when unsupported.
 */
export async function setMiniPlayer(on: boolean): Promise<boolean> {
  const el = electronApi()
  if (el) {
    try {
      return await el.setMiniPlayer(on)
    } catch {
      return false
    }
  }
  if (!isTauri()) return false
  try {
    const mod = await tauriModule()
    const w = mod.getCurrentWindow()
    if (on) {
      if (await w.isFullscreen()) await w.setFullscreen(false)
      const size = (await w.innerSize()).toLogical(await w.scaleFactor())
      miniRestore = { w: Math.round(size.width), h: Math.round(size.height) }
      await w.setMinSize(new mod.LogicalSize(320, 180))
      await w.setSize(new mod.LogicalSize(480, 270))
      await w.setAlwaysOnTop(true)
    } else {
      await w.setAlwaysOnTop(false)
      const r = miniRestore ?? { w: 1100, h: 760 }
      miniRestore = null
      await w.setSize(new mod.LogicalSize(Math.max(760, r.w), Math.max(640, r.h)))
      await w.setMinSize(new mod.LogicalSize(760, 640))
    }
    return true
  } catch {
    return false
  }
}

// ───────────────────────── keep awake ─────────────────────────

let wantAwake = false
let wakeLock: WakeLockSentinel | null = null
let wakeLockPending = false

async function acquireWakeLock(): Promise<void> {
  if (!wantAwake || wakeLock || wakeLockPending || document.visibilityState !== 'visible') return
  const wl = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
  if (!wl || typeof wl.request !== 'function') return
  wakeLockPending = true
  try {
    const lock = await wl.request('screen')
    if (!wantAwake) {
      void lock.release().catch(() => {})
      return
    }
    wakeLock = lock
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null
    })
  } catch {
    /* denied / unsupported */
  } finally {
    wakeLockPending = false
  }
}

function onVisibility(): void {
  // Screen wake locks are dropped whenever the page is hidden — re-acquire on return.
  if (document.visibilityState === 'visible') void acquireWakeLock()
}

/** Keeps display + system awake (Tauri command / Electron powerSaveBlocker and Screen Wake Lock). Idempotent; errors are swallowed. */
export function keepAwake(on: boolean): void {
  if (wantAwake === on) return
  wantAwake = on
  const el = electronApi()
  if (el) {
    try {
      el.keepAwake(on)
    } catch {
      /* best effort */
    }
  }
  if (isTauri()) {
    void import('@tauri-apps/api/core')
      .then((core) => core.invoke('keep_awake', { on }))
      .catch(() => {})
  }
  if (on) {
    document.addEventListener('visibilitychange', onVisibility)
    void acquireWakeLock()
  } else {
    document.removeEventListener('visibilitychange', onVisibility)
    const lock = wakeLock
    wakeLock = null
    if (lock) void lock.release().catch(() => {})
  }
}

// ───────────────────────── clipboard ─────────────────────────

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall back below */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

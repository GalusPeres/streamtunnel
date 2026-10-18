// Persistent user preferences (localStorage). Every access is guarded: the app must work without storage
// (private mode, blocked site data) — it then simply forgets everything on restart.
import type { CodecPref, ContentMode, FpsPref, LatencyMode, NetConfig, ResolutionPref, StreamSettings, TurnServer } from './types.ts'
import { DEFAULT_NET, DEFAULT_SETTINGS } from './rtc/defaults.ts'
import { t } from './i18n.ts'

const KEY = 'streamtunnel.settings.v1'

export const MAX_NAME_LENGTH = 40
export const MIN_MANUAL_KBPS = 2000
export const MAX_MANUAL_KBPS = 60000

export interface AppSettings {
  /** display name shown to the other side */
  name: string
  /** last used stream settings (host) */
  stream: StreamSettings
  /** signaling brokers + ICE servers ("Erweitert") */
  net: NetConfig
  /** viewers may re-share to other viewers */
  allowRelay: boolean
  latencyMode: LatencyMode
  /** host: max direct viewers (1–8) */
  maxDirect: number
  /** host: total upload cap in kbps; 0 = unlimited */
  uploadLimitKbps: number
  /** host: ask before admitting viewers */
  requireApproval: boolean
  /** viewer playback volume 0..1 */
  volume: number
  muted: boolean
  /** show "Testbild senden" without ?test in the URL */
  showTestStream: boolean
  /**
   * Random per-install secret (32 hex chars). The viewer's peer id for a room is derived from it and the code, so
   * a host's kick / deny still applies when the same install simply joins again (see deriveViewerId).
   */
  installSecret: string
  /** UI language; 'auto' = browser language */
  lang: 'auto' | 'de' | 'en'
}

// ───────────────────────── sanitizers ─────────────────────────

/** Removes control characters, trims, caps the length. May return ''. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME_LENGTH)
}

const SECRET_RE = /^[0-9a-f]{32}$/

export function randomSecret(): string {
  try {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    let s = ''
    while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16)
    return s
  }
}

export function randomGuestName(): string {
  let n = Math.floor(Math.random() * 10000)
  try {
    const b = new Uint16Array(1)
    crypto.getRandomValues(b)
    n = b[0] % 10000
  } catch {
    /* Math.random fallback */
  }
  return `${t('guest')}-${String(n).padStart(4, '0')}`
}

const RESOLUTIONS: readonly ResolutionPref[] = ['native', 2160, 1440, 1080, 720]
const FPS: readonly FpsPref[] = [30, 60, 120]
const CODECS: readonly CodecPref[] = ['auto', 'AV1', 'H264', 'VP9', 'VP8']
const CONTENTS: readonly ContentMode[] = ['motion', 'balanced', 'detail']

function pick<T>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback
}

/** 0 (auto) or a manual bitrate clamped to 2–60 Mbit/s. */
export function clampBitrate(kbps: unknown): number {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps <= 0) return 0
  return Math.round(Math.min(MAX_MANUAL_KBPS, Math.max(MIN_MANUAL_KBPS, kbps)))
}

export function sanitizeStream(v: unknown): StreamSettings {
  const d: StreamSettings = { ...DEFAULT_SETTINGS, content: 'motion' }
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    resolution: pick(RESOLUTIONS, r.resolution, d.resolution),
    fps: pick(FPS, r.fps, d.fps),
    bitrateKbps: clampBitrate(r.bitrateKbps),
    codec: pick(CODECS, r.codec, d.codec),
    content: pick(CONTENTS, r.content, d.content),
    audio: typeof r.audio === 'boolean' ? r.audio : d.audio,
  }
}

/** wss:// only — the Tauri CSP (connect-src … wss:) blocks ws://, so a ws:// broker could never connect. */
const BROKER_RE = /^wss:\/\/[^\s]+$/i
const STUN_RE = /^stuns?:[^\s]+$/i
const TURN_RE = /^turns?:[^\s]+$/i

export function isValidBroker(s: string): boolean {
  if (!BROKER_RE.test(s)) return false
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}
export const isValidStun = (s: string): boolean => STUN_RE.test(s)
export const isValidTurn = (s: string): boolean => TURN_RE.test(s)

function stringList(v: unknown, valid: (s: string) => boolean, max: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s && valid(s) && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

export function defaultNet(): NetConfig {
  return { brokers: [...DEFAULT_NET.brokers], stun: [...DEFAULT_NET.stun], turn: DEFAULT_NET.turn.map((t) => ({ ...t })) }
}

/** Validates a NetConfig; empty broker / STUN lists fall back to the defaults. */
export function sanitizeNet(v: unknown): NetConfig {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const d = defaultNet()
  const brokers = stringList(r.brokers, isValidBroker, 8)
  const stun = stringList(r.stun, isValidStun, 8)
  const turn: TurnServer[] = []
  if (Array.isArray(r.turn)) {
    for (const t of r.turn) {
      if (!t || typeof t !== 'object') continue
      const tr = t as Record<string, unknown>
      const urls = typeof tr.urls === 'string' ? tr.urls.trim() : ''
      if (!urls || !isValidTurn(urls)) continue
      const server: TurnServer = { urls }
      if (typeof tr.username === 'string' && tr.username) server.username = tr.username.slice(0, 256)
      if (typeof tr.credential === 'string' && tr.credential) server.credential = tr.credential.slice(0, 256)
      turn.push(server)
      if (turn.length >= 4) break
    }
  }
  return { brokers: brokers.length > 0 ? brokers : d.brokers, stun: stun.length > 0 ? stun : d.stun, turn }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.round(Math.min(max, Math.max(min, v)))
}

export function defaultSettings(): AppSettings {
  return {
    name: randomGuestName(),
    // First run starts on the "Spiel (flüssig)" preset: sharing games is the main use case.
    stream: { ...DEFAULT_SETTINGS, content: 'motion' },
    net: defaultNet(),
    allowRelay: true,
    latencyMode: 'lowest',
    maxDirect: 4,
    uploadLimitKbps: 0,
    requireApproval: false,
    volume: 1,
    muted: false,
    showTestStream: false,
    installSecret: randomSecret(),
    lang: 'auto',
  }
}

function sanitize(v: unknown): AppSettings {
  const d = defaultSettings()
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const volume = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : d.volume
  return {
    name: cleanName(cleanName(r.name).replace(/\s*\(Host\)$/i, '')) || d.name, // drop a test leftover suffix
    stream: sanitizeStream(r.stream),
    net: sanitizeNet(r.net),
    allowRelay: typeof r.allowRelay === 'boolean' ? r.allowRelay : d.allowRelay,
    latencyMode: r.latencyMode === 'smooth' ? 'smooth' : 'lowest',
    maxDirect: clampInt(r.maxDirect, 1, 8, d.maxDirect),
    uploadLimitKbps: clampInt(r.uploadLimitKbps, 0, 1_000_000, 0),
    requireApproval: r.requireApproval === true,
    volume,
    muted: r.muted === true,
    showTestStream: r.showTestStream === true,
    installSecret: typeof r.installSecret === 'string' && SECRET_RE.test(r.installSecret) ? r.installSecret : d.installSecret,
    lang: r.lang === 'de' || r.lang === 'en' ? r.lang : 'auto',
  }
}

// ───────────────────────── storage ─────────────────────────

function readRaw(): unknown {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Loads (and validates) the stored settings; persists a fresh default name on first start. */
export function loadSettings(): AppSettings {
  const raw = readRaw()
  const s = sanitize(raw)
  // first start, or an older settings object without a secret yet: persist it so the viewer id stays stable
  const storedSecret = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).installSecret : undefined
  if (!raw || storedSecret !== s.installSecret) saveSettings(s)
  return s
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable or full — settings live for this run only */
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: AppSettings | null = null

/** Coalesces frequent writes (typing, sliders) into one write after 400 ms. */
export function saveSettingsSoon(s: AppSettings): void {
  pendingSave = s
  if (saveTimer) return
  saveTimer = setTimeout(flushSettings, 400)
}

/** Writes a pending debounced save immediately (e.g. on pagehide). */
export function flushSettings(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const s = pendingSave
  pendingSave = null
  if (s) saveSettings(s)
}

/** Name to send to peers: the stored name or a guest fallback. */
export function displayName(s: AppSettings): string {
  return cleanName(s.name) || t('guest')
}

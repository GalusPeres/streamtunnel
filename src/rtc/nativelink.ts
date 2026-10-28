// Native media path, page side (docs/NATIVE-PATH.md): between two StreamTunnel apps the picture travels over our
// own encrypted UDP link ("stm/1", Rust crate src-tauri/st-media) instead of WebRTC in the web view.
//   sharer (Windows + NVENC): NativeShare — next to the HostSession of the same share (same picker, same track),
//     admits watchers through the HostSession's rules and lets Rust capture + encode the picked window/screen;
//   watcher (Windows, Mac, Linux app): NativeWatch — Rust receives and reassembles, every access unit arrives over
//     a Tauri Channel and is decoded here with WebCodecs and drawn at once on a canvas (like native.ts / lowlat.ts);
//     sound is PCM played through an AudioWorklet ring buffer;
//   WatchSwitch — what TunnelSession.watch() returns when the sharer announces `live.nv`: tries NativeWatch first
//     and falls back to a normal ViewerSession (WebRTC) when no native link forms in time.
// Signaling: 'nv' join / offer / wait / no and 'nvice' (types.ts), routed by the TunnelSession.
// The pure helpers at the top are unit-tested under Node (tests/rtc-nativelink.test.ts).
import type {
  HostInfo,
  InboundStats,
  ISignalingRoom,
  IViewerSession,
  LatencyMode,
  NetConfig,
  NvCandidate,
  NvCodec,
  NvLive,
  NvViewerCaps,
  SignalBody,
  StreamSettings,
  ViewerInfo,
  ViewerState,
  CtlMessage,
} from '../types.ts'
import type { HostSession } from './host.ts'
import type { ViewerSession } from './viewer.ts'

type CoreModule = typeof import('@tauri-apps/api/core')

/** stm protocol version of this build, and the oldest one it talks to (same as STM_VERSION in st-media). */
export const NV_VERSION = 1
export const NV_MIN_VERSION = 1
/** 'nv' join re-send interval (ms). */
export const NV_JOIN_MS = 1000
/** No offer / wait for this long after the first join → WebRTC (ms). */
export const NV_OFFER_TIMEOUT_MS = 4000
/** Safety net over Rust's 2.5 s probe deadline, from the offer (ms). */
export const NV_CONNECT_TIMEOUT_MS = 3500
/** Link up but no key frame decoded for this long → WebRTC (ms). */
export const NV_FIRST_FRAME_MS = 2000
/** Most candidates accepted from one message (untrusted input). */
export const NV_MAX_CANDIDATES = 16

/** WebCodecs codec strings for the capability check (the stream's real level is read from its SPS). */
export const NV_HEVC_CODEC = 'hvc1.1.6.L153.B0'
export const NV_H264_CODEC = 'avc1.640033'

/** What `nm_caps` reports. */
export interface NmCaps {
  v: number
  min: number
  /** Some when this machine can share natively (Windows + NVENC) */
  share: { codecs: NvCodec[]; gpu: string } | null
  /** the Rust side can receive on this OS */
  watch: boolean
}

// ───────────────────────── pure helpers ─────────────────────────

const isCodec = (v: unknown): v is NvCodec => v === 'hevc' || v === 'h264'
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 255

function codecList(v: unknown): NvCodec[] {
  if (!Array.isArray(v)) return []
  const out: NvCodec[] = []
  for (const c of v) if (isCodec(c) && !out.includes(c)) out.push(c)
  return out
}

/** LiveInfo.nv from the wire; null when absent or malformed. */
export function parseNvLive(v: unknown): NvLive | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const codecs = codecList(r.codecs)
  if (!isVersion(r.v) || !isVersion(r.min) || r.min > r.v || codecs.length === 0) return null
  return { v: r.v, min: r.min, codecs }
}

/** A watcher's caps from the wire; null when malformed. */
export function parseNvViewerCaps(v: unknown): NvViewerCaps | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const dec = codecList(r.dec)
  if (!isVersion(r.v) || !isVersion(r.min) || r.min > r.v || dec.length === 0) return null
  return { v: r.v, min: r.min, dec, rfi: r.rfi === true, audio: r.audio === true }
}

const ADDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]{2,45}\]):(\d{1,5})$/

/** Candidates from the wire: valid "ip:port" / "[v6]:port" with kind host | srflx, deduplicated, at most 16. */
export function parseNvCandidates(v: unknown): NvCandidate[] {
  if (!Array.isArray(v)) return []
  const out: NvCandidate[] = []
  for (const c of v) {
    if (out.length >= NV_MAX_CANDIDATES) break
    if (!c || typeof c !== 'object') continue
    const { a, k } = c as Record<string, unknown>
    if (typeof a !== 'string' || (k !== 'host' && k !== 'srflx')) continue
    const m = ADDR.exec(a)
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) continue
    if (!out.some((o) => o.a === a)) out.push({ a, k })
  }
  return out
}

/** Our key half / the peer's: 64 lowercase hex digits. */
export function isNvKey(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** A link id from the wire: non-zero u32. */
export function isNvLinkId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0xffff_ffff
}

/** Both sides talk to each other: each one's version is at least the other's minimum. */
export function nvVersionsMatch(a: { v: number; min: number }, b: { v: number; min: number }): boolean {
  return a.v >= b.min && b.v >= a.min
}

/** HEVC when both sides have it, else H.264 when both have it, else null (→ WebRTC). */
export function chooseNvCodec(sharer: readonly NvCodec[], viewer: readonly NvCodec[]): NvCodec | null {
  if (sharer.includes('hevc') && viewer.includes('hevc')) return 'hevc'
  if (sharer.includes('h264') && viewer.includes('h264')) return 'h264'
  return null
}

/** One video access unit from the link Channel (layout: video_message in src-tauri/src/native_media.rs). */
export interface NvVideoMessage {
  key: boolean
  /** completed with FEC */
  recovered: boolean
  /** first frame after a loss */
  afterLoss: boolean
  codec: NvCodec
  frameId: number
  /** sender capture time (µs, sender clock) — the WebCodecs timestamp */
  ptsUs: number
  /** capture → handed to the page on our clock (µs), 0 = unknown */
  ageUs: number
  /** capture → encoded on the sender (µs) */
  senderLatencyUs: number
  /** Rust's wall clock at hand-over (µs since epoch) */
  sentEpochUs: number
  data: Uint8Array
}

/** 20 ms of PCM from the link Channel (layout: audio_message in native_media.rs). */
export interface NvAudioMessage {
  channels: number
  /** 5 ms packets replaced with silence */
  concealed: number
  seq: number
  captureUs: number
  /** s16 interleaved */
  pcm: Int16Array
}

export const NV_VIDEO_HEADER = 32
export const NV_AUDIO_HEADER = 16

/** Parses a raw Channel message; null for anything malformed. */
export function parseNvMessage(buf: ArrayBuffer): { video: NvVideoMessage } | { audio: NvAudioMessage } | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return null
  const d = new DataView(buf)
  const kind = d.getUint8(0)
  if (kind === 1 && buf.byteLength > NV_VIDEO_HEADER) {
    const flags = d.getUint8(1)
    const c = d.getUint8(2)
    if (c !== 1 && c !== 2) return null
    return {
      video: {
        key: (flags & 1) !== 0,
        recovered: (flags & 2) !== 0,
        afterLoss: (flags & 4) !== 0,
        codec: c === 2 ? 'hevc' : 'h264',
        frameId: d.getUint32(4, true),
        ptsUs: Number(d.getBigUint64(8, true)),
        ageUs: d.getUint32(16, true),
        senderLatencyUs: d.getUint32(20, true),
        sentEpochUs: Number(d.getBigUint64(24, true)),
        data: new Uint8Array(buf, NV_VIDEO_HEADER),
      },
    }
  }
  if (kind === 2 && buf.byteLength >= NV_AUDIO_HEADER && (buf.byteLength - NV_AUDIO_HEADER) % 4 === 0) {
    return {
      audio: {
        channels: d.getUint8(1),
        concealed: d.getUint8(2),
        seq: d.getUint32(4, true),
        captureUs: Number(d.getBigUint64(8, true)),
        pcm: new Int16Array(buf, NV_AUDIO_HEADER),
      },
    }
  }
  return null
}

// ───────────────────────── capability detection (Tauri only) ─────────────────────────

let corePromise: Promise<CoreModule> | null = null
const core = (): Promise<CoreModule> => (corePromise ??= import('@tauri-apps/api/core'))

/** Safari engine (Mac app): no HEVC on this path (WebKit's WebCodecs HEVC decode is unreliable). */
function isWebKitEngine(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)
}

/** true inside the Tauri app (any OS) — the only place the native path exists. */
export function nativeLinkAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let capsOnce: Promise<NmCaps | null> | null = null

/** What the Rust side can do (cached); null outside the app or on error. */
export function nativeCaps(): Promise<NmCaps | null> {
  capsOnce ??= nativeLinkAvailable()
    ? core()
        .then((c) => c.invoke<NmCaps>('nm_caps'))
        .catch(() => null)
    : Promise.resolve(null)
  return capsOnce
}

async function decodes(codec: string, hardwareAcceleration: HardwareAcceleration): Promise<boolean> {
  try {
    return (await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true, hardwareAcceleration })).supported === true
  } catch {
    return false
  }
}

let watchCapsOnce: Promise<NvViewerCaps | null> | null = null

/**
 * This page as a native watcher (cached): HEVC only with a hardware decoder and not on WebKit, else H.264 High;
 * null when the Rust side cannot receive or WebCodecs is missing.
 */
export function nativeWatchCaps(): Promise<NvViewerCaps | null> {
  watchCapsOnce ??= (async () => {
    const caps = await nativeCaps()
    if (!caps?.watch || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return null
    const dec: NvCodec[] = []
    if (!isWebKitEngine() && (await decodes(NV_HEVC_CODEC, 'prefer-hardware'))) dec.push('hevc')
    if ((await decodes(NV_H264_CODEC, 'prefer-hardware')) || (await decodes(NV_H264_CODEC, 'no-preference'))) dec.push('h264')
    if (dec.length === 0) return null
    return { v: NV_VERSION, min: NV_MIN_VERSION, dec, rfi: false, audio: typeof AudioWorkletNode === 'function' }
  })().catch(() => null)
  return watchCapsOnce
}

// ───────────────────────── sharer ─────────────────────────

export interface NativeShareOptions {
  room: ISignalingRoom
  /** the HostSession of the same share: admission (ban / deny / lock / approval / slots), viewer list, kick */
  host: HostSession
  stream: MediaStream
  settings: StreamSettings
  hostName: string
  net: NetConfig
}

/**
 * The native side of one share (docs/NATIVE-PATH.md §11.1). Created next to the HostSession; only exists while the
 * share can be sent natively (Windows app, NVENC, the track is a window or screen).
 */
export class NativeShare {
  /** non-fatal notices (German / English via i18n), like HostSession.onNotice */
  onNotice: (message: string) => void = () => {}

  /** construction options (APP: make private once used) */
  readonly opts: NativeShareOptions

  private constructor(opts: NativeShareOptions) {
    this.opts = opts
  }

  /** null when this share cannot be sent natively (then nothing changes: WebRTC only). */
  static async create(opts: NativeShareOptions): Promise<NativeShare | null> {
    // APP: nm_caps().share, parse the track's deviceId, nm_share_open → new NativeShare(opts)
    void opts
    return null
  }

  /** The presence field (LiveInfo.nv), null once stopped. */
  live(): NvLive | null {
    throw new Error('NativeShare.live: not implemented')
  }

  /** 'nv' join, 'nvice' / 'bye' for our sids. true = consumed. */
  handleSignal(from: string, body: SignalBody): boolean {
    void from
    void body
    return false
  }

  /** Native watchers for the viewer list (merged by HostSession.viewers()). */
  viewers(): ViewerInfo[] {
    return []
  }

  connectedCount(): number {
    return 0
  }

  /** Removes a native watcher (ctl kick + link close with "kicked"). */
  kick(viewerId: string): void {
    void viewerId
  }

  /** fps / resolution / bitrate changed (nm_share_update); codec preference does not apply here. */
  updateSettings(settings: StreamSettings): void {
    void settings
  }

  /** "Quelle wechseln": the new track's deviceId → nm_share_source; not capturable natively → native links end. */
  replaceStream(stream: MediaStream): Promise<void> {
    void stream
    return Promise.resolve()
  }

  setPaused(paused: boolean): void {
    void paused
  }

  setName(name: string): void {
    void name
  }

  /** Ends every native link (ctl bye, "ended") and the capture (nm_share_close). */
  stop(): void {}
}

// ───────────────────────── watcher ─────────────────────────

export interface NativeWatchOptions {
  room: ISignalingRoom
  name: string
  net: NetConfig
  origin: string
  originName: string
  /** the origin's presence field */
  live: NvLive
  /** this page's caps (nativeWatchCaps) */
  caps: NvViewerCaps
  latencyMode: LatencyMode
}

/**
 * Watches one member's stream over a native link (docs/NATIVE-PATH.md §11.2). Same callbacks as a ViewerSession;
 * `onFallback` asks the owner (WatchSwitch) to continue with WebRTC — called at most once, the session is dead then.
 */
export class NativeWatch implements IViewerSession {
  onState: (state: ViewerState, detail?: string) => void = () => {}
  onVideo: (stream: MediaStream) => void = () => {}
  onAudio: (stream: MediaStream) => void = () => {}
  onRenderer: (canvas: HTMLCanvasElement | null) => void = () => {}
  onHostInfo: (info: HostInfo) => void = () => {}
  onHostTx: (tx: Extract<CtlMessage, { t: 'tx' }>) => void = () => {}
  onStats: (stats: InboundStats) => void = () => {}
  onFallback: (reason: string) => void = () => {}
  readonly origin: string

  /** construction options (APP: make private once used) */
  readonly opts: NativeWatchOptions

  constructor(opts: NativeWatchOptions) {
    this.opts = opts
    this.origin = opts.origin
  }

  start(): void {
    throw new Error('NativeWatch.start: not implemented')
  }

  handleSignal(from: string, body: SignalBody): boolean {
    void from
    void body
    return false
  }

  nudge(): void {}

  originGone(reason?: string): void {
    void reason
  }

  state(): ViewerState {
    return 'waiting'
  }

  setLatencyMode(mode: LatencyMode): void {
    void mode
  }

  relayChildren(): number {
    return 0
  }

  /** Like ViewerSession.upstreamAlive: the native link to the origin is up. */
  upstreamAlive(): boolean {
    return false
  }

  setName(name: string): void {
    void name
  }

  stop(): void {}
}

export interface WatchSwitchOptions {
  origin: string
  /** the origin's presence field */
  live: NvLive
  /** builds the native session for these caps (TunnelSession passes room / name / net / prefs) */
  makeNative: (caps: NvViewerCaps) => NativeWatch
  /** builds the WebRTC session used when the native one is impossible or falls back */
  makeWebRtc: () => ViewerSession
}

/**
 * What TunnelSession.watch() returns for a sharer with `live.nv`: NativeWatch first, a ViewerSession after a
 * fallback (at most one switch). Keeps the callbacks the watch view installed and re-binds them on the switch.
 */
export class WatchSwitch implements IViewerSession {
  onState: (state: ViewerState, detail?: string) => void = () => {}
  onVideo: (stream: MediaStream) => void = () => {}
  onAudio: (stream: MediaStream) => void = () => {}
  onRenderer: (canvas: HTMLCanvasElement | null) => void = () => {}
  onHostInfo: (info: HostInfo) => void = () => {}
  onHostTx: (tx: Extract<CtlMessage, { t: 'tx' }>) => void = () => {}
  onStats: (stats: InboundStats) => void = () => {}
  readonly origin: string

  /** construction options (APP: make private once used) */
  readonly opts: WatchSwitchOptions

  constructor(opts: WatchSwitchOptions) {
    this.opts = opts
    this.origin = opts.origin
  }

  /** 'native' while the native session runs, 'webrtc' after the switch (diagnostics, E2E). */
  transport(): 'native' | 'webrtc' {
    return 'native'
  }

  start(): void {
    throw new Error('WatchSwitch.start: not implemented')
  }

  handleSignal(from: string, body: SignalBody): boolean {
    void from
    void body
    return false
  }

  nudge(): void {}

  originGone(reason?: string): void {
    void reason
  }

  state(): ViewerState {
    return 'waiting'
  }

  setLatencyMode(mode: LatencyMode): void {
    void mode
  }

  relayChildren(): number {
    return 0
  }

  upstreamAlive(): boolean {
    return false
  }

  setName(name: string): void {
    void name
  }

  stop(): void {}
}

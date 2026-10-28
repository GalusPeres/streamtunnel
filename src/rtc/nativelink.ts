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
  CodecPref,
  CtlMessage,
  HostInfo,
  InboundStats,
  ISignalingRoom,
  IViewerSession,
  LatencyMode,
  NetConfig,
  NvCandidate,
  NvCodec,
  NvLive,
  NvNoReason,
  NvViewerCaps,
  OutboundStats,
  SignalBody,
  StreamSettings,
  ViewerInfo,
  ViewerState,
} from '../types.ts'
import { randomId } from '../core/crypto.ts'
import { parseCtl, sanitizeName } from './host.ts'
import type { HostSession } from './host.ts'
import { NV_H264_CODEC, NV_HEVC_CODEC, NvAudioPlayer, NvVideoRenderer, prepareVideoSink } from './nativeplayer.ts'
import { nativeShareAudioSupported } from './sysaudio.ts'
import { t } from '../i18n.ts'
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

/** The watcher's page timers (docs/NATIVE-PATH.md §7); tests pass shorter ones. */
export interface NvTiming {
  joinMs: number
  offerMs: number
  connectMs: number
  firstFrameMs: number
}
export const NV_TIMING: NvTiming = { joinMs: NV_JOIN_MS, offerMs: NV_OFFER_TIMEOUT_MS, connectMs: NV_CONNECT_TIMEOUT_MS, firstFrameMs: NV_FIRST_FRAME_MS }

/** WebCodecs codec strings for the capability check (nativeplayer.ts reads the stream's real level from its SPS). */
export { NV_H264_CODEC, NV_HEVC_CODEC }

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

/** Our ephemeral X25519 public key / the peer's (the link keys come from a Diffie-Hellman in Rust): 64 lowercase hex digits. */
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

/**
 * HEVC when both sides have it (unless the sharer picked H.264), else H.264 when both have it, else null (→ WebRTC).
 * AV1 / VP9 / VP8 do not exist on this path: they count as 'auto'.
 */
export function chooseNvCodec(sharer: readonly NvCodec[], viewer: readonly NvCodec[], pref: CodecPref = 'auto'): NvCodec | null {
  if (pref !== 'H264' && sharer.includes('hevc') && viewer.includes('hevc')) return 'hevc'
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


/** What the watcher does with an 'nv' no (§11.2 step 8): WebRTC instead, or end like a WebRTC reject; null = ignore. */
export function nvNoAction(reason: unknown): { fallback: true } | { state: 'rejected' | 'kicked'; detail: string } | null {
  switch (reason) {
    case 'unavailable':
    case 'busy':
    case 'full':
      return { fallback: true }
    case 'locked':
    case 'denied':
      return { state: 'rejected', detail: reason }
    case 'kicked':
      return { state: 'kicked', detail: 'kicked' }
    default:
      return null
  }
}

/**
 * What the watcher does when a live link ends (its `closed` event): the sharer kicked us or ended the stream →
 * that state; the link died (peer gone, timeout) → one native retry, then WebRTC; our own close → nothing.
 */
export function nvClosedAction(reason: unknown, retried: boolean): 'kicked' | 'ended' | 'retry' | 'fallback' | null {
  if (reason === 'closed') return null
  if (reason === 'kicked') return 'kicked'
  if (reason === 'ended') return 'ended'
  return retried ? 'fallback' : 'retry'
}

/** Native first, or straight to WebRTC (missing caps, no common version or codec)? */
export function nvWatchPlan(caps: NvViewerCaps | null, live: NvLive): 'native' | 'webrtc' {
  if (!caps || !nvVersionsMatch(caps, live)) return 'webrtc'
  return chooseNvCodec(live.codecs, caps.dec) ? 'native' : 'webrtc'
}

/** The share's resolution cap for nm_share_* (0 = native size). */
export function nvMaxHeight(s: StreamSettings): number {
  return s.resolution === 'native' ? 0 : s.resolution
}

/** "window:<hwnd>:0" / "screen:<id>:0" of a getDisplayMedia track (what Rust can capture), else null. */
export function nvSourceOf(stream: MediaStream): { source: string; width: number; height: number } | null {
  const track = stream.getVideoTracks()[0]
  if (!track || track.readyState === 'ended') return null
  let s: MediaTrackSettings = {}
  try {
    s = track.getSettings()
  } catch {
    return null
  }
  const id = typeof s.deviceId === 'string' ? s.deviceId : ''
  if (!/^(window|screen):\d+:/.test(id)) return null
  return { source: id, width: typeof s.width === 'number' ? s.width : 0, height: typeof s.height === 'number' ? s.height : 0 }
}

const WIRE_ID = /^[A-Za-z0-9_-]{1,64}$/
const isWireId = (v: unknown): v is string => typeof v === 'string' && WIRE_ID.test(v)

/** Adds new candidates (deduplicated, at most NV_MAX_CANDIDATES); returns the ones that were new. */
function mergeCandidates(into: NvCandidate[], add: readonly NvCandidate[]): NvCandidate[] {
  const fresh: NvCandidate[] = []
  for (const c of add) {
    if (into.length >= NV_MAX_CANDIDATES) break
    if (into.some((o) => o.a === c.a)) continue
    into.push(c)
    fresh.push(c)
  }
  return fresh
}

// ───────────────────────── the Rust side (Tauri only) ─────────────────────────

/** The Tauri side as the sessions see it. Unit tests install a fake with setNativeBackend(). */
export interface NativeBackend {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  /** A Channel to pass as `events`: JSON events arrive parsed, raw messages as ArrayBuffer. */
  channel(onMessage: (m: unknown) => void): unknown
  /** tests: what nativeWatchCaps() reports (Node has no WebCodecs) */
  watchCaps?: NvViewerCaps | null
}

let corePromise: Promise<CoreModule> | null = null
const core = (): Promise<CoreModule> => (corePromise ??= import('@tauri-apps/api/core'))
let fake: NativeBackend | null = null

/** Tests: replaces the Tauri side (null restores it) and forgets the cached caps. */
export function setNativeBackend(b: NativeBackend | null): void {
  fake = b
  capsOnce = null
  watchCapsOnce = null
}

async function backend(): Promise<NativeBackend> {
  if (fake) return fake
  const c = await core()
  return { invoke: (cmd, args) => c.invoke(cmd, args), channel: (fn) => new c.Channel<unknown>(fn) }
}

/** invoke that never throws into a handler (a closed link or share is not an error here). */
function quietly(cmd: string, args: Record<string, unknown>): void {
  void backend()
    .then((b) => b.invoke(cmd, args))
    .catch(() => {})
}

/**
 * Set once HEVC failed to decode on this machine (WebKit's WebCodecs HEVC had decoder bugs, WebKit bug 262950):
 * from then on this machine asks for H.264.
 */
const NO_HEVC_KEY = 'streamtunnel.nv.noHevc'

function hevcFailedHere(): boolean {
  try {
    return localStorage.getItem(NO_HEVC_KEY) === '1'
  } catch {
    return false
  }
}

function rememberHevcFailed(): void {
  try {
    localStorage.setItem(NO_HEVC_KEY, '1')
  } catch { /* storage blocked: this session still retries with H.264 */ }
  watchCapsOnce = null
}

/** true inside the Tauri app (any OS) — the only place the native path exists. */
export function nativeLinkAvailable(): boolean {
  return fake !== null || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
}

let capsOnce: Promise<NmCaps | null> | null = null

/** What the Rust side can do (cached); null outside the app or on error. */
export function nativeCaps(): Promise<NmCaps | null> {
  capsOnce ??= nativeLinkAvailable()
    ? backend()
        .then((b) => b.invoke<NmCaps>('nm_caps'))
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
 * This page as a native watcher (cached): HEVC with a hardware decoder (unless it failed here before), and H.264
 * High; null when the Rust side cannot receive or WebCodecs is missing.
 */
export function nativeWatchCaps(): Promise<NvViewerCaps | null> {
  if (fake && 'watchCaps' in fake) return Promise.resolve(fake.watchCaps ?? null)
  watchCapsOnce ??= (async () => {
    const caps = await nativeCaps()
    if (!caps?.watch || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return null
    const dec: NvCodec[] = []
    if (!hevcFailedHere() && (await decodes(NV_HEVC_CODEC, 'prefer-hardware'))) dec.push('hevc')
    if ((await decodes(NV_H264_CODEC, 'prefer-hardware')) || (await decodes(NV_H264_CODEC, 'no-preference'))) dec.push('h264')
    if (dec.length === 0) return null
    // the renderer picks its element (a <video> of a track on WebKit) without waiting
    await prepareVideoSink()
    return { v: NV_VERSION, min: NV_MIN_VERSION, dec, rfi: false, audio: typeof AudioWorkletNode === 'function' }
  })().catch(() => null)
  return watchCapsOnce
}

/** Link events from Rust (docs/NATIVE-PATH.md §9.2); raw messages arrive as ArrayBuffer. */
type LinkEventMsg =
  | { t: 'cand'; cand: unknown }
  | { t: 'up'; remote: string; lan: boolean; rttMs: number }
  | { t: 'fail'; reason: string }
  | { t: 'closed'; reason: string }
  | { t: 'msg'; m: string }
  | { t: 'stats'; link: NvLinkStats; recv?: NvRecvStats }

/** st-media LinkStats (camelCase JSON). */
export interface NvLinkStats {
  kind: string
  remote: string
  rttMs: number
  txKbps: number
  rxKbps: number
  paceKbps: number
  lossPct: number
  rejected: number
}

/** st-media RecvStats (camelCase JSON). */
export interface NvRecvStats {
  frames: number
  framesRecovered: number
  framesLost: number
  keyframes: number
  keyframeRequests: number
  fps: number
  videoKbps: number
  ageMs: number
  audioLost: number
}

/** Share channel: per codec what the capture runs at, and the stats of captures and senders (§9.2). */
interface ShareInfo {
  codec: NvCodec
  width: number
  height: number
  fps: number
  kbps: number
}
interface CaptureStatsMsg {
  codec: string
  width: number
  height: number
  fps: number
  targetKbps: number
  bitrateKbps: number
  encodeFps: number
  encodeMs: number
  closed: boolean
}
interface SenderStatsMsg {
  codec: string
  videoKbps: number
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type RxMessage = Extract<CtlMessage, { t: 'rx' }>
type TxMessage = Extract<CtlMessage, { t: 'tx' }>
type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

/** ctl 'tx' to native watchers, like HostSession's stats loop (ms). */
const TX_MS = 2000
/** ctl 'rx' from a native watcher (ms). */
const RX_MS = 2000
const STATS_MS = 1000
/** A native watcher whose offer is not answered by a link within this time is dropped (Rust fails it after 2.5 s). */
const SHARE_CONNECT_MS = 8000
/** Native watchers per share (links per endpoint are capped in Rust as well). */
const MAX_NATIVE_VIEWERS = 8
/** The same offer is re-sent at most this often when joins keep coming (ms). */
const OFFER_RESEND_MS = 900
/** Budget for 'nv' wait / no replies (a join flood must not crowd out offers on the brokers). */
const NO_RATE_PER_SEC = 4
const NO_BURST = 8
/** Per-watcher budget for App messages (legit: 'rx' every 2 s + one 'hello'). */
const CTL_RATE_PER_SEC = 20
const CTL_BURST = 40
/** nvice candidates that arrived before their offer, per watcher. */
const MAX_EARLY_SIDS = 4
/** Sound of the native path: s16 stereo at 48 kHz. */
const PCM_KBPS = 1536

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

interface ShareViewer {
  id: string
  name: string
  nid: string
  sid: string
  codec: NvCodec
  caps: NvViewerCaps
  peer: { link: number; key: string; cand: NvCandidate[] }
  /** our link, null while it is being opened */
  link: number | null
  /** our candidates (the offer's, then late ones) */
  cand: NvCandidate[]
  offer: Extract<SignalBody, { t: 'nv'; k: 'offer' }> | null
  offerSentAt: number
  state: 'connecting' | 'connected'
  createdAt: number
  connectedAt: number | null
  named: boolean
  rx: RxMessage | null
  stats: NvLinkStats | null
  ctlTokens: number
  ctlRefill: number
  /** keeps App messages to this watcher in order */
  chain: Promise<unknown>
  timer: Timer | null
  closed: boolean
}

/**
 * The native side of one share (docs/NATIVE-PATH.md §11.1). Created next to the HostSession; only exists while the
 * share can be sent natively (Windows app, NVENC, the track is a window or screen).
 */
export class NativeShare {
  /** non-fatal notices (German / English via i18n), like HostSession.onNotice */
  onNotice: (message: string) => void = () => {}
  /** the native watcher list changed (the HostSession re-emits its merged list) */
  onChange: () => void = () => {}

  private readonly room: ISignalingRoom
  private readonly host: HostSession
  private readonly net: NetConfig
  private readonly shareId: number
  private readonly codecs: NvCodec[]
  private settings: StreamSettings
  private hostName: string
  private readonly audio: boolean
  private readonly viewers_ = new Map<string, ShareViewer>()
  private readonly info = new Map<NvCodec, ShareInfo>()
  private captures: CaptureStatsMsg[] = []
  private senders: SenderStatsMsg[] = []
  /** the current source can be captured natively; false → joins get 'unavailable', presence drops `nv` */
  private available = true
  private paused = false
  private stopped = false
  private txTimer: Interval | null = null
  private noTokens = NO_BURST
  private noRefill = 0

  private constructor(opts: NativeShareOptions, shareId: number, codecs: NvCodec[], audio: boolean) {
    this.room = opts.room
    this.host = opts.host
    this.net = opts.net
    this.settings = { ...opts.settings }
    this.hostName = opts.hostName
    this.shareId = shareId
    this.codecs = codecs
    this.audio = audio
  }

  /** null when this share cannot be sent natively (then nothing changes: WebRTC only). */
  static async create(opts: NativeShareOptions): Promise<NativeShare | null> {
    if (!nativeLinkAvailable()) return null
    try {
      const caps = await nativeCaps()
      const codecs = caps?.share?.codecs.filter((c) => c === 'hevc' || c === 'h264') ?? []
      const src = nvSourceOf(opts.stream)
      if (codecs.length === 0 || !src) return null
      // Native share sound is the app's own capture (sysaudio.ts). A share whose sound comes from the picker would be
      // silent here, so it stays on WebRTC.
      const hasAudio = opts.settings.audio && opts.stream.getAudioTracks().some((t) => t.readyState === 'live')
      if (hasAudio && !fake && !(await nativeShareAudioSupported())) return null
      const b = await backend()
      let ns: NativeShare | null = null
      const early: unknown[] = []
      const ch = b.channel((m) => (ns ? ns.onShareEvent(m) : early.push(m)))
      const s = opts.settings
      const id = await b.invoke<number>('nm_share_open', {
        cfg: { source: src.source, width: src.width, height: src.height, fps: s.fps, maxHeight: nvMaxHeight(s), kbps: Math.max(0, Math.round(s.bitrateKbps)), audio: hasAudio },
        events: ch,
      })
      const share: NativeShare = new NativeShare(opts, id, codecs, hasAudio)
      ns = share
      for (const m of early) share.onShareEvent(m)
      share.txTimer = setInterval(() => share.txTick(), TX_MS)
      console.info(`[native] share ready (${codecs.join(', ')} · ${caps?.share?.gpu ?? ''})`)
      return share
    } catch (err) {
      console.info('[native] share stays on WebRTC:', errText(err))
      return null
    }
  }

  /** The presence field (LiveInfo.nv), null once stopped or while the source cannot be captured natively. */
  live(): NvLive | null {
    return this.stopped || !this.available ? null : { v: NV_VERSION, min: NV_MIN_VERSION, codecs: [...this.codecs] }
  }

  /** 'nv' join, 'nvice' / 'bye' for our sids. true = consumed. */
  handleSignal(from: string, body: SignalBody): boolean {
    if (this.stopped || !body || typeof body !== 'object') return false
    switch (body.t) {
      case 'nv':
        if (body.k !== 'join' || body.origin !== this.room.selfId) return false
        this.onJoin(from, body)
        return true
      case 'nvice': {
        const v = this.viewers_.get(from)
        if (!v || v.closed || body.sid !== v.sid) return false
        const fresh = mergeCandidates(v.peer.cand, parseNvCandidates(body.cand))
        if (fresh.length > 0 && v.link !== null) quietly('nm_link_cand', { link: v.link, cand: fresh })
        return true
      }
      case 'bye': {
        // A live link only ends over the link itself (authenticated); a signaling bye drops one still being set up.
        const v = this.viewers_.get(from)
        if (!v || v.closed || v.state === 'connected') return false
        if (typeof body.sid === 'string' && body.sid !== v.sid) return false
        this.drop(v, 'closed')
        return true
      }
      default:
        return false
    }
  }

  private onJoin(from: string, b: Extract<SignalBody, { t: 'nv'; k: 'join' }>): void {
    if (!from || !isWireId(b.nid) || !isNvLinkId(b.link) || !isNvKey(b.key)) return
    const caps = parseNvViewerCaps(b.caps)
    if (!caps) return
    const cand = parseNvCandidates(b.cand)
    const existing = this.viewers_.get(from)
    if (existing && existing.nid === b.nid) {
      // the same attempt: its candidates may have grown; it may have missed our offer
      const fresh = mergeCandidates(existing.peer.cand, cand)
      if (fresh.length > 0 && existing.link !== null) quietly('nm_link_cand', { link: existing.link, cand: fresh })
      this.resendOffer(existing)
      return
    }
    const codec = chooseNvCodec(this.codecs, caps.dec, this.settings.codec)
    if (!this.available || !codec || !nvVersionsMatch(caps, { v: NV_VERSION, min: NV_MIN_VERSION })) return this.no(from, b.nid, 'unavailable')
    const decision = this.host.admitNative(from, sanitizeName(b.name))
    if (decision === 'pending') return this.reply({ t: 'nv', k: 'wait', nid: b.nid }, from)
    if (decision !== 'ok') return this.no(from, b.nid, decision)
    if (existing) this.drop(existing, 'closed') // a new attempt replaces the old one
    if (this.viewers_.size >= MAX_NATIVE_VIEWERS) return this.no(from, b.nid, 'busy')
    const v: ShareViewer = {
      id: from,
      name: sanitizeName(b.name),
      nid: b.nid,
      sid: randomId(8),
      codec,
      caps,
      peer: { link: b.link, key: b.key, cand },
      link: null,
      cand: [],
      offer: null,
      offerSentAt: 0,
      state: 'connecting',
      createdAt: Date.now(),
      connectedAt: null,
      named: false,
      rx: null,
      stats: null,
      ctlTokens: CTL_BURST,
      ctlRefill: Date.now(),
      chain: Promise.resolve(),
      timer: null,
      closed: false,
    }
    this.viewers_.set(from, v)
    v.timer = setTimeout(() => {
      v.timer = null
      if (!v.closed && v.state !== 'connected') this.drop(v, 'closed')
    }, SHARE_CONNECT_MS)
    this.changed()
    void this.setup(v)
  }

  /** Link + capture for an admitted watcher, then the offer. */
  private async setup(v: ShareViewer): Promise<void> {
    let b: NativeBackend
    try {
      b = await backend()
      const ch = b.channel((m) => this.onLinkEvent(v, m))
      const r = await b.invoke<{ link: number; key: string; cand: unknown }>('nm_link_open', { role: 'share', stun: this.net.stun, events: ch })
      v.link = r.link
      if (v.closed || this.stopped) {
        quietly('nm_link_close', { link: r.link, reason: 'closed' })
        return
      }
      mergeCandidates(v.cand, parseNvCandidates(r.cand))
      v.offer = { t: 'nv', k: 'offer', nid: v.nid, sid: v.sid, codec: v.codec, link: r.link, key: r.key, cand: [], hostName: this.hostName, fps: this.settings.fps, kbps: 0, audio: this.audio }
    } catch (err) {
      console.info('[native] link open failed:', errText(err))
      if (!v.closed) {
        this.no(v.id, v.nid, 'busy')
        this.drop(v, 'closed')
      }
      return
    }
    try {
      // The capture first (starting NVENC takes a moment), then the probing deadline starts with nm_link_remote.
      await b.invoke('nm_share_add', { share: this.shareId, link: v.link, codec: v.codec, rfi: v.caps.rfi })
      if (v.closed) return
      await b.invoke('nm_link_remote', { link: v.link, peerLink: v.peer.link, key: v.peer.key, cand: v.peer.cand })
    } catch (err) {
      console.info('[native] share link setup failed:', errText(err))
      if (!v.closed) {
        this.no(v.id, v.nid, 'unavailable')
        this.drop(v, 'closed')
      }
      return
    }
    if (v.closed || this.stopped) return
    this.sendOffer(v)
  }

  private sendOffer(v: ShareViewer): void {
    if (!v.offer) return
    const kbps = this.settings.bitrateKbps > 0 ? Math.round(this.settings.bitrateKbps) : (this.info.get(v.codec)?.kbps ?? 0)
    v.offer = { ...v.offer, cand: v.cand.slice(), hostName: this.hostName, fps: this.settings.fps, kbps }
    v.offerSentAt = Date.now()
    this.reply(v.offer, v.id)
  }

  private resendOffer(v: ShareViewer): void {
    if (v.closed || v.state === 'connected' || !v.offer || Date.now() - v.offerSentAt < OFFER_RESEND_MS) return
    this.sendOffer(v)
  }

  private onLinkEvent(v: ShareViewer, m: unknown): void {
    if (v.closed || this.stopped || !m || typeof m !== 'object' || m instanceof ArrayBuffer) return
    const ev = m as LinkEventMsg
    switch (ev.t) {
      case 'cand': {
        const fresh = mergeCandidates(v.cand, parseNvCandidates(ev.cand))
        // before the offer they simply travel with it
        if (fresh.length > 0 && v.offerSentAt > 0) this.reply({ t: 'nvice', sid: v.sid, cand: fresh }, v.id)
        return
      }
      case 'up':
        if (v.state === 'connected') return
        v.state = 'connected'
        v.connectedAt = Date.now()
        if (v.timer) clearTimeout(v.timer)
        v.timer = null
        this.sendCtl(v, this.infoMsg())
        if (this.paused) this.sendCtl(v, { t: 'paused', paused: true })
        console.info(`[native] ${v.name} watches natively (${v.codec}, ${ev.lan ? 'LAN' : 'P2P'}, ${ev.remote})`)
        this.changed()
        return
      case 'fail':
      case 'closed':
        this.drop(v, 'closed')
        return
      case 'msg':
        this.onCtl(v, ev.m)
        return
      case 'stats':
        if (ev.link && typeof ev.link === 'object') v.stats = ev.link
        return
      default:
        return
    }
  }

  private onCtl(v: ShareViewer, text: unknown): void {
    const now = Date.now()
    v.ctlTokens = Math.min(CTL_BURST, v.ctlTokens + ((now - v.ctlRefill) * CTL_RATE_PER_SEC) / 1000)
    v.ctlRefill = now
    if (v.ctlTokens < 1) return
    v.ctlTokens -= 1
    const msg = parseCtl(text)
    if (!msg) return
    if (msg.t === 'hello') {
      if (v.named) return // once per connection
      v.named = true
      v.name = sanitizeName(msg.name)
      this.changed()
    } else if (msg.t === 'rx') {
      v.rx = msg
    } else if (msg.t === 'bye') {
      this.drop(v, 'closed')
    }
  }

  private onShareEvent(m: unknown): void {
    if (this.stopped || !m || typeof m !== 'object' || m instanceof ArrayBuffer) return
    const ev = m as Record<string, unknown>
    switch (ev.t) {
      case 'info': {
        const codec = ev.codec === 'hevc' || ev.codec === 'h264' ? ev.codec : null
        if (!codec) return
        this.info.set(codec, { codec, width: num(ev.width), height: num(ev.height), fps: num(ev.fps), kbps: num(ev.kbps) })
        console.info(`[native] ${codec} capture ${num(ev.width)}x${num(ev.height)} @ ${num(ev.fps)} fps, ${num(ev.kbps)} kbit/s (${String(ev.gpu ?? '')})`)
        return
      }
      case 'stats':
        this.captures = Array.isArray(ev.capture) ? (ev.capture as CaptureStatsMsg[]) : []
        this.senders = Array.isArray(ev.senders) ? (ev.senders as SenderStatsMsg[]) : []
        return
      case 'ended':
        console.info('[native] capture ended:', String(ev.reason ?? ''))
        if (ev.reason === 'error') {
          // the encoder failed for good while the source is still there: like a source Rust cannot capture, the
          // native watchers retry once, get 'unavailable' and continue over WebRTC (the web track lives on)
          this.available = false
          for (const v of [...this.viewers_.values()]) this.drop(v, 'closed')
          this.changed()
        }
        // 'closed': the source window closed, the web track ends too and main.ts pauses the share (watchTrack)
        return
      case 'err':
        console.warn('[native]', String(ev.m ?? ''))
        return
      default:
        return
    }
  }

  /** Every 2 s: sender stats to the connected watchers (ctl 'tx'), refreshed viewer list. */
  private txTick(): void {
    if (this.stopped) return
    let any = false
    for (const v of this.viewers_.values()) {
      if (v.closed || v.state !== 'connected') continue
      any = true
      const cs = this.captures.find((c) => c.codec === v.codec)
      const ss = this.senders.find((s) => s.codec === v.codec)
      const tx: TxMessage = {
        t: 'tx',
        encodeMs: cs ? Math.round(num(cs.encodeMs) * 10) / 10 : null,
        encoder: 'NVENC',
        hw: true,
        kbps: Math.round(num(ss?.videoKbps, num(cs?.bitrateKbps))),
        upstreamLatencyMs: 0,
        lim: 'none',
        fps: Math.round(num(cs?.encodeFps, this.settings.fps)),
      }
      this.sendCtl(v, tx)
    }
    if (any) this.changed()
  }

  private infoMsg(): CtlMessage {
    // codec: a CodecName placeholder — the watcher takes the real codec from the offer
    return { t: 'info', hostName: this.hostName, settings: { ...this.settings }, viewers: this.host.connectedCount() + this.host.relayedCount(), codec: 'H264', hops: 1 }
  }

  private sendCtl(v: ShareViewer, msg: CtlMessage): void {
    if (v.closed || v.link === null) return
    const link = v.link
    const text = JSON.stringify(msg)
    v.chain = v.chain.then(() => backend().then((b) => b.invoke('nm_link_send', { link, text }))).catch(() => {})
  }

  /** Native watchers for the viewer list (merged by HostSession.viewers()). */
  viewers(): ViewerInfo[] {
    const out: ViewerInfo[] = []
    for (const v of this.viewers_.values()) {
      if (v.closed) continue
      out.push({ id: v.id, name: v.name, state: v.state, connectedAt: v.connectedAt, codec: v.codec === 'h264' ? 'H264' : null, tx: this.outbound(v), rx: v.rx, native: true })
    }
    return out
  }

  private outbound(v: ShareViewer): OutboundStats | null {
    const cs = this.captures.find((c) => c.codec === v.codec)
    const ss = this.senders.find((s) => s.codec === v.codec)
    const ls = v.stats
    if (v.state !== 'connected' || (!cs && !ls)) return null
    return {
      bitrateKbps: num(ss?.videoKbps, num(cs?.bitrateKbps)),
      fps: num(cs?.encodeFps),
      width: num(cs?.width),
      height: num(cs?.height),
      codec: v.codec === 'hevc' ? 'HEVC' : 'H264',
      encoder: 'NVENC',
      hw: true,
      encodeMs: cs ? num(cs.encodeMs) : null,
      qualityLimitation: 'none',
      rttMs: ls && num(ls.rttMs) > 0 ? num(ls.rttMs) : null,
      connType: ls?.kind === 'lan' ? 'lan' : 'p2p',
      availableKbps: null,
      audioKbps: this.audio ? PCM_KBPS : 0,
    }
  }

  connectedCount(): number {
    let n = 0
    for (const v of this.viewers_.values()) if (!v.closed && v.state === 'connected') n++
    return n
  }

  /** Links holding a direct slot (connecting + connected), not counting `except`. */
  slotCount(except?: string): number {
    let n = 0
    for (const v of this.viewers_.values()) if (!v.closed && v.id !== except) n++
    return n
  }

  /** Removes a native watcher (ctl kick + link close with "kicked"). */
  kick(viewerId: string): void {
    const v = this.viewers_.get(viewerId)
    if (!v || v.closed) return
    if (v.state === 'connected') this.sendCtl(v, { t: 'kick' })
    else this.no(v.id, v.nid, 'kicked')
    this.drop(v, 'kicked')
  }

  /** fps / resolution / bitrate changed (nm_share_update); a codec change applies to the viewers that join after it. */
  updateSettings(settings: StreamSettings): void {
    if (this.stopped) return
    const prev = this.settings
    this.settings = { ...settings }
    if (prev.fps !== settings.fps || prev.resolution !== settings.resolution || prev.bitrateKbps !== settings.bitrateKbps) {
      quietly('nm_share_update', { share: this.shareId, cfg: { fps: settings.fps, maxHeight: nvMaxHeight(settings), kbps: Math.max(0, Math.round(settings.bitrateKbps)) } })
    }
    for (const v of this.viewers_.values()) if (v.state === 'connected') this.sendCtl(v, this.infoMsg())
  }

  /**
   * "Quelle wechseln": the new track's deviceId → nm_share_source. A source Rust cannot capture ends the native
   * links (Bye "closed": the watchers retry once, get 'unavailable' and continue over WebRTC).
   */
  async replaceStream(stream: MediaStream): Promise<void> {
    if (this.stopped) return
    const src = nvSourceOf(stream)
    let ok = false
    if (src) {
      try {
        const b = await backend()
        await b.invoke('nm_share_source', { share: this.shareId, source: src.source, width: src.width, height: src.height })
        ok = true
      } catch (err) {
        console.info('[native] new source not capturable natively:', errText(err))
      }
    }
    if (this.stopped) return
    this.available = ok
    if (!ok) for (const v of [...this.viewers_.values()]) this.drop(v, 'closed')
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (this.stopped) return
    for (const v of this.viewers_.values()) if (v.state === 'connected') this.sendCtl(v, { t: 'paused', paused })
  }

  setName(name: string): void {
    this.hostName = name
  }

  /** Ends every native link (ctl bye, "ended") and the capture (nm_share_close). */
  stop(): void {
    if (this.stopped) return
    for (const v of [...this.viewers_.values()]) {
      if (v.state === 'connected') this.sendCtl(v, { t: 'bye' })
      this.drop(v, 'ended')
    }
    this.stopped = true
    if (this.txTimer) clearInterval(this.txTimer)
    this.txTimer = null
    quietly('nm_share_close', { share: this.shareId })
  }

  /** Forgets a watcher and closes its link (Rust stops feeding it; its capture stops with the codec's last link). */
  private drop(v: ShareViewer, reason: 'closed' | 'kicked' | 'ended'): void {
    if (v.closed) return
    v.closed = true
    if (v.timer) clearTimeout(v.timer)
    v.timer = null
    if (this.viewers_.get(v.id) === v) this.viewers_.delete(v.id)
    if (v.link !== null) {
      const link = v.link
      // after the queued ctl messages (kick / bye), so they leave first
      v.chain = v.chain.then(() => backend().then((b) => b.invoke('nm_link_close', { link, reason }))).catch(() => {})
    }
    this.changed()
  }

  private no(to: string, nid: string, reason: NvNoReason): void {
    this.reply({ t: 'nv', k: 'no', nid, reason }, to, reason === 'kicked')
  }

  /** room.send for wait / no / offer / nvice; wait and no share a budget (kicks always go out). */
  private reply(body: SignalBody, to: string, always = false): void {
    const limited = body.t === 'nv' && (body.k === 'wait' || body.k === 'no')
    if (limited && !always) {
      const now = Date.now()
      this.noTokens = Math.min(NO_BURST, this.noTokens + ((now - this.noRefill) * NO_RATE_PER_SEC) / 1000)
      this.noRefill = now
      if (this.noTokens < 1) return
      this.noTokens -= 1
    }
    try {
      this.room.send(body, to)
    } catch {
      /* signaling unavailable — the watcher re-sends its join */
    }
  }

  private changed(): void {
    try {
      this.onChange()
    } catch {
      /* ignore */
    }
  }
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
  /** tests: shorter page timers */
  timing?: Partial<NvTiming>
}

interface WatchLink {
  /** start() generation: events of an older link are ignored */
  gen: number
  id: number
  nid: string
  key: string
  /** our candidates (they grow until the offer, later ones go out as 'nvice') */
  cand: NvCandidate[]
  sid: string | null
  codec: NvCodec | null
  audio: boolean
  up: boolean
  lan: boolean
  rttMs: number | null
  /** keeps App messages in order */
  chain: Promise<unknown>
}

/**
 * Watches one member's stream over a native link (docs/NATIVE-PATH.md §11.2). Same callbacks as a ViewerSession;
 * `onFallback` asks the owner (WatchSwitch) to continue with WebRTC — called at most once, the session is dead then.
 */
export class NativeWatch implements IViewerSession {
  onState: (state: ViewerState, detail?: string) => void = () => {}
  onVideo: (stream: MediaStream) => void = () => {}
  onAudio: (stream: MediaStream) => void = () => {}
  onRenderer: (view: HTMLElement | null) => void = () => {}
  onHostInfo: (info: HostInfo) => void = () => {}
  onHostTx: (tx: Extract<CtlMessage, { t: 'tx' }>) => void = () => {}
  onStats: (stats: InboundStats) => void = () => {}
  onFallback: (reason: string) => void = () => {}
  readonly origin: string
  /** why the session ended (diagnostics) */
  endReason = ''

  private readonly room: ISignalingRoom
  private readonly net: NetConfig
  /** loses 'hevc' when HEVC does not decode here */
  private caps: NvViewerCaps
  private readonly timing: NvTiming
  private readonly originName: string
  private name: string

  private st: ViewerState = 'waiting'
  private stDetail: string | undefined
  private running = false
  private disposed = false
  private fellBack = false
  /** the one native retry after a live link died was used */
  private retried = false
  /** the one native retry with H.264 after HEVC did not decode was used */
  private h264Retried = false
  private gen = 0
  private link: WatchLink | null = null
  /** local candidates that came before nm_link_open returned */
  private earlyCand: NvCandidate[] = []
  /** 'nvice' that overtook its offer: sid → candidates */
  private readonly earlyIce = new Map<string, NvCandidate[]>()
  private lastJoinAt = 0

  private joinTimer: Interval | null = null
  private offerTimer: Timer | null = null
  private connectTimer: Timer | null = null
  private frameTimer: Timer | null = null
  private statsTimer: Interval | null = null
  private rxTimer: Interval | null = null

  private renderer: NvVideoRenderer | null = null
  private audio: NvAudioPlayer | null = null
  private hostInfo: HostInfo | null = null
  private linkStats: NvLinkStats | null = null
  private recvStats: NvRecvStats | null = null
  private lastStats: InboundStats | null = null
  private sampleAt = 0
  private sampleDrawn = 0
  private sampleBytes = 0
  private sampleAudio = 0

  constructor(opts: NativeWatchOptions) {
    this.room = opts.room
    this.net = opts.net
    this.caps = opts.caps
    this.timing = { ...NV_TIMING, ...(opts.timing ?? {}) }
    this.origin = opts.origin
    this.originName = opts.originName.slice(0, 40)
    this.name = opts.name
  }

  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.setState('waiting', undefined, true)
    void this.open()
  }

  /** New link + join loop (again after a live link died). */
  private async open(): Promise<void> {
    const gen = ++this.gen
    this.earlyCand = []
    this.earlyIce.clear()
    let r: { link: number; key: string; cand: unknown }
    try {
      const b = await backend()
      const ch = b.channel((m) => this.onEvent(gen, m))
      r = await b.invoke('nm_link_open', { role: 'watch', stun: this.net.stun, events: ch })
    } catch (err) {
      if (gen === this.gen) this.fallback(`link: ${errText(err)}`)
      return
    }
    if (gen !== this.gen || !this.running) {
      quietly('nm_link_close', { link: r.link, reason: 'closed' })
      return
    }
    const cand: NvCandidate[] = []
    mergeCandidates(cand, parseNvCandidates(r.cand))
    mergeCandidates(cand, this.earlyCand)
    this.link = { gen, id: r.link, nid: randomId(8), key: r.key, cand, sid: null, codec: null, audio: false, up: false, lan: false, rttMs: null, chain: Promise.resolve() }
    this.sendJoin()
    this.joinTimer = setInterval(() => this.sendJoin(), this.timing.joinMs)
    this.offerTimer = setTimeout(() => this.fallback('no offer'), this.timing.offerMs)
  }

  private sendJoin(): void {
    const l = this.link
    if (!this.running || !l || l.sid !== null) return
    this.lastJoinAt = Date.now()
    this.send({ t: 'nv', k: 'join', nid: l.nid, origin: this.origin, name: this.name, caps: this.caps, link: l.id, key: l.key, cand: l.cand.slice() }, this.origin)
  }

  handleSignal(from: string, body: SignalBody): boolean {
    if (this.disposed || !body || typeof body !== 'object' || from !== this.origin) return false
    const l = this.link
    if (body.t === 'nvice') {
      if (!l || !isWireId(body.sid)) return false
      const cand = parseNvCandidates(body.cand)
      if (l.sid === null) {
        // candidates can overtake their offer (different brokers): keep a few sids around
        let early = this.earlyIce.get(body.sid)
        if (!early) {
          if (this.earlyIce.size >= MAX_EARLY_SIDS) return true
          early = []
          this.earlyIce.set(body.sid, early)
        }
        mergeCandidates(early, cand)
        return true
      }
      if (body.sid !== l.sid) return false
      if (cand.length > 0) quietly('nm_link_cand', { link: l.id, cand })
      return true
    }
    if (body.t !== 'nv' || !l || body.nid !== l.nid) return false
    if (!this.running) return true
    switch (body.k) {
      case 'offer':
        this.onOffer(l, body)
        return true
      case 'wait':
        // the sharer asks its user first: no offer timeout while that is pending
        if (l.sid === null && this.offerTimer) {
          clearTimeout(this.offerTimer)
          this.offerTimer = null
        }
        return true
      case 'no': {
        if (l.sid !== null) return true // after the offer only the link itself can end it
        const a = nvNoAction(body.reason)
        if (!a) return true
        if ('fallback' in a) this.fallback(`no: ${String(body.reason)}`)
        else this.finish(a.state, a.detail)
        return true
      }
      default:
        return false
    }
  }

  private onOffer(l: WatchLink, b: Extract<SignalBody, { t: 'nv'; k: 'offer' }>): void {
    if (l.sid !== null) return // already probing (first offer wins)
    if (!isWireId(b.sid) || !isNvLinkId(b.link) || !isNvKey(b.key)) return
    if ((b.codec !== 'hevc' && b.codec !== 'h264') || !this.caps.dec.includes(b.codec)) return
    const cand = parseNvCandidates(b.cand)
    mergeCandidates(cand, this.earlyIce.get(b.sid) ?? [])
    this.earlyIce.clear()
    l.sid = b.sid
    l.codec = b.codec
    l.audio = b.audio === true && this.caps.audio
    this.clearJoinTimers()
    this.setState('connecting')
    const offered = typeof b.hostName === 'string' ? sanitizeName(b.hostName) : ''
    this.updateHostInfo({ hostName: offered || this.hostInfo?.hostName || this.originName, codec: b.codec === 'h264' ? 'H264' : null, hops: 1, paused: false })
    this.connectTimer = setTimeout(() => this.fallback('connect timeout'), this.timing.connectMs)
    void backend()
      .then((be) => be.invoke('nm_link_remote', { link: l.id, peerLink: b.link, key: b.key, cand }))
      .catch((err: unknown) => {
        if (this.link === l) this.fallback(`remote: ${errText(err)}`)
      })
  }

  private onEvent(gen: number, m: unknown): void {
    if (gen !== this.gen || this.disposed || !this.running) return
    if (m instanceof ArrayBuffer) {
      this.onMedia(m)
      return
    }
    if (!m || typeof m !== 'object') return
    const ev = m as LinkEventMsg
    const l = this.link
    switch (ev.t) {
      case 'cand': {
        const cand = parseNvCandidates(ev.cand)
        if (!l) mergeCandidates(this.earlyCand, cand)
        else {
          const fresh = mergeCandidates(l.cand, cand)
          if (l.sid !== null && fresh.length > 0) this.send({ t: 'nvice', sid: l.sid, cand: fresh }, this.origin)
        }
        return
      }
      case 'up':
        if (l && !l.up) this.onUp(l, ev)
        return
      case 'fail':
        if (l && !l.up) this.fallback(`fail: ${String(ev.reason)}`)
        return
      case 'closed':
        if (l) this.onClosed(String(ev.reason))
        return
      case 'msg':
        if (l) this.onCtl(ev.m)
        return
      case 'stats':
        if (ev.link && typeof ev.link === 'object') this.linkStats = ev.link
        this.recvStats = ev.recv && typeof ev.recv === 'object' ? ev.recv : null
        return
      default:
        return
    }
  }

  private onUp(l: WatchLink, ev: Extract<LinkEventMsg, { t: 'up' }>): void {
    l.up = true
    l.lan = ev.lan === true
    l.rttMs = num(ev.rttMs, -1) >= 0 ? num(ev.rttMs) : null
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    // the renderer (decoder + canvas) is made with the first access unit
    if (l.audio && !this.audio) {
      const a = new NvAudioPlayer()
      this.audio = a
      void a.ready.then((stream) => {
        if (stream && this.audio === a && this.running) this.safe(() => this.onAudio(stream))
      })
    }
    this.setState('connected')
    this.frameTimer = setTimeout(() => this.fallback('no picture'), this.timing.firstFrameMs)
    this.sendCtl({ t: 'hello', name: this.name })
    this.sampleAt = performance.now()
    this.statsTimer = setInterval(() => this.statsTick(), STATS_MS)
    this.rxTimer = setInterval(() => this.sendRx(), RX_MS)
  }

  private ensureRenderer(): NvVideoRenderer {
    if (this.renderer) return this.renderer
    const r = new NvVideoRenderer()
    r.onFirstFrame = () => {
      if (this.renderer !== r || !this.running) return
      if (this.frameTimer) clearTimeout(this.frameTimer)
      this.frameTimer = null
      this.safe(() => this.onRenderer(r.view))
    }
    r.onKeyframeNeeded = () => {
      const l = this.link
      if (l && this.renderer === r) quietly('nm_link_keyframe', { link: l.id })
    }
    r.onFatal = (reason) => {
      if (this.renderer === r) this.fallback(reason)
    }
    this.renderer = r
    return r
  }

  private onMedia(buf: ArrayBuffer): void {
    const m = parseNvMessage(buf)
    if (!m) return
    if ('video' in m) this.ensureRenderer().push(m.video)
    else this.audio?.push(m.audio)
  }

  /** The live link ended (§11.2 step 8). */
  private onClosed(reason: string): void {
    switch (nvClosedAction(reason, this.retried)) {
      case 'kicked':
        this.finish('kicked', 'kicked')
        return
      case 'ended':
        this.endReason = 'link bye (ended)'
        this.finish('ended')
        return
      case 'retry':
        // one more native attempt with a new nid and link, then WebRTC
        this.retried = true
        this.teardown(false)
        this.setState('reconnecting')
        void this.open()
        return
      case 'fallback':
        this.fallback(`closed: ${reason}`)
        return
      default:
        return
    }
  }

  private onCtl(text: unknown): void {
    const msg = parseCtl(text)
    if (!msg) return
    switch (msg.t) {
      case 'info': {
        // the codec comes from the offer (the ctl 'info' carries a CodecName placeholder)
        const codec = this.link?.codec === 'h264' ? 'H264' : null
        this.updateHostInfo({ hostName: msg.hostName, settings: msg.settings, viewers: msg.viewers, codec, hops: 1 })
        return
      }
      case 'tx':
        this.safe(() => this.onHostTx(msg))
        return
      case 'paused':
        this.updateHostInfo({ paused: msg.paused })
        return
      case 'kick':
        this.finish('kicked', 'kicked')
        return
      case 'bye':
        this.endReason = 'ctl bye from origin'
        this.finish('ended')
        return
      default:
        return
    }
  }

  private statsTick(): void {
    const l = this.link
    const r = this.renderer
    if (!l || !l.up || !r || !this.running) return
    const now = performance.now()
    const dt = Math.max(0.001, (now - this.sampleAt) / 1000)
    this.sampleAt = now
    const v = r.sample()
    const a = this.audio?.stats()
    const fps = (v.drawn - this.sampleDrawn) / dt
    const kbps = this.recvStats ? num(this.recvStats.videoKbps) : ((v.bytes - this.sampleBytes) * 8) / 1000 / dt
    const audioKbps = a ? ((a.bytes - this.sampleAudio) * 8) / 1000 / dt : 0
    this.sampleDrawn = v.drawn
    this.sampleBytes = v.bytes
    this.sampleAudio = a?.bytes ?? 0
    const ls = this.linkStats
    const rtt = ls && num(ls.rttMs) > 0 ? num(ls.rttMs) : l.rttMs
    const st: InboundStats = {
      bitrateKbps: Math.round(kbps),
      fps: Math.round(fps * 10) / 10,
      width: v.width,
      height: v.height,
      codec: l.codec === 'hevc' ? 'HEVC' : 'H264',
      decoder: `WebCodecs${v.hw ? ' (GPU)' : ''}`,
      hw: v.hw,
      rttMs: rtt !== null ? Math.round(rtt * 10) / 10 : null,
      jitterBufferMs: 0,
      decodeMs: v.decodeMs !== null ? Math.round(v.decodeMs * 10) / 10 : null,
      lossPct: Math.max(0, Math.min(100, num(ls?.lossPct))),
      framesDropped: v.dropped,
      freezeCount: 0,
      connType: ls ? (ls.kind === 'lan' ? 'lan' : 'p2p') : l.lan ? 'lan' : 'p2p',
      latencyMs: v.latencyMs !== null ? Math.round(v.latencyMs) : null,
      audioKbps: Math.round(audioKbps),
      transport: 'native',
    }
    this.lastStats = st
    this.safe(() => this.onStats(st))
  }

  private sendRx(): void {
    const s = this.lastStats
    if (!s) return
    this.sendCtl({ t: 'rx', fps: s.fps, latencyMs: s.latencyMs, lossPct: s.lossPct, width: s.width, height: s.height, children: 0, descendants: 0, canRelay: false })
  }

  private sendCtl(msg: CtlMessage): void {
    const l = this.link
    if (!l) return
    const text = JSON.stringify(msg)
    l.chain = l.chain.then(() => backend().then((b) => b.invoke('nm_link_send', { link: l.id, text }))).catch(() => {})
  }

  nudge(): void {
    const l = this.link
    if (!this.running || !l || l.sid !== null || Date.now() - this.lastJoinAt < 500) return
    this.sendJoin()
  }

  originGone(reason = 'origin gone'): void {
    this.endReason = reason
    this.finish('ended')
  }

  state(): ViewerState {
    return this.st
  }

  /** The native path has no jitter buffer: both modes show every frame at once. */
  setLatencyMode(mode: LatencyMode): void {
    void mode
  }

  relayChildren(): number {
    return 0
  }

  /** Like ViewerSession.upstreamAlive: the native link to the origin is up. */
  upstreamAlive(): boolean {
    return this.running && !!this.link?.up
  }

  setName(name: string): void {
    this.name = name
  }

  stop(): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown(this.running)
    this.running = false
  }

  /** Terminal state from the sharer (or the tunnel): stop for good, no fallback. */
  private finish(state: 'ended' | 'kicked' | 'rejected', detail?: string): void {
    if (!this.running) return
    this.running = false
    this.teardown(false)
    this.setState(state, detail)
  }

  /** The native path did not work: hand over to WebRTC (once). */
  private fallback(reason: string): void {
    if (this.fellBack || this.disposed || !this.running) return
    if (this.retryWithH264(reason)) return
    this.fellBack = true
    this.running = false
    this.endReason = `fallback: ${reason}`
    console.info(`[native] watch → WebRTC (${reason})`)
    this.teardown(false)
    this.onFallback(reason)
  }

  /**
   * HEVC arrived but did not decode here (decoder errors, or frames came and none was drawn): remember that for this
   * machine and try once more natively with H.264; only after that WebRTC.
   */
  private retryWithH264(reason: string): boolean {
    const l = this.link
    if (this.h264Retried || !l || !l.up || l.codec !== 'hevc' || !this.caps.dec.includes('h264')) return false
    const decoderFailed = reason === 'decoder' || reason.startsWith('no decoder')
    if (!decoderFailed && !(reason === 'no picture' && (this.renderer?.sample().received ?? 0) > 0)) return false
    this.h264Retried = true
    console.info(`[native] HEVC did not decode here (${reason}): H.264 instead`)
    rememberHevcFailed()
    this.caps = { ...this.caps, dec: this.caps.dec.filter((c) => c !== 'hevc') }
    this.teardown(false)
    this.setState('reconnecting')
    void this.open()
    return true
  }

  /**
   * Closes the current link and everything that belongs to it. A link that never came up also gets the signaling
   * bye with its sid (the sharer frees the slot at once); `leaving` (the user stops watching) also sends the sid-less
   * one while we were still joining — never on a fallback, where it would overtake the WebRTC join.
   */
  private teardown(leaving: boolean): void {
    this.gen++
    this.clearJoinTimers()
    for (const t of [this.connectTimer, this.frameTimer]) if (t) clearTimeout(t)
    for (const t of [this.statsTimer, this.rxTimer]) if (t) clearInterval(t)
    this.connectTimer = this.frameTimer = null
    this.statsTimer = this.rxTimer = null
    const l = this.link
    this.link = null
    if (l) {
      if (!l.up && l.sid !== null) this.send({ t: 'bye', sid: l.sid }, this.origin)
      else if (!l.up && leaving) this.send({ t: 'bye' }, this.origin)
      const id = l.id
      l.chain.then(() => backend().then((b) => b.invoke('nm_link_close', { link: id, reason: 'closed' }))).catch(() => {})
    }
    if (this.renderer) {
      this.renderer.close()
      this.renderer = null
      this.safe(() => this.onRenderer(null))
    }
    this.audio?.close()
    this.audio = null
    this.linkStats = null
    this.recvStats = null
    this.sampleDrawn = this.sampleBytes = this.sampleAudio = 0
    this.earlyIce.clear()
  }

  private clearJoinTimers(): void {
    if (this.joinTimer) clearInterval(this.joinTimer)
    if (this.offerTimer) clearTimeout(this.offerTimer)
    this.joinTimer = null
    this.offerTimer = null
  }

  private updateHostInfo(patch: Partial<HostInfo>): void {
    const prev: HostInfo = this.hostInfo ?? { hostName: this.originName ? sanitizeName(this.originName) : '', settings: null, viewers: 0, codec: null, hops: 1, paused: false }
    const next: HostInfo = { ...prev, ...patch }
    this.hostInfo = next
    this.safe(() => this.onHostInfo({ ...next }))
  }

  private setState(state: ViewerState, detail?: string, force = false): void {
    if (!force && state === this.st && detail === this.stDetail) return
    this.st = state
    this.stDetail = detail
    this.safe(() => this.onState(state, detail))
  }

  private send(body: SignalBody, to: string): void {
    try {
      this.room.send(body, to)
    } catch {
      /* signaling unavailable — joins are re-sent, timers fall back */
    }
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch {
      /* UI callback errors must not break the session */
    }
  }
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
/** User-facing reason for a fall-back to WebRTC (shown as a toast, so a slow picture is never a mystery). */
export function fallbackMessage(reason: string): string {
  const r = reason.toLowerCase()
  if (r === 'no offer') return t('nv.fb.noOffer')
  if (r === 'connect timeout' || r.startsWith('fail') || r.startsWith('link') || r.startsWith('remote')) return t('nv.fb.connect')
  if (r === 'no picture') return t('nv.fb.picture')
  if (r.includes('decod')) return t('nv.fb.decoder')
  if (r.startsWith('no: ')) return t('nv.fb.unavailable')
  return t('nv.fb.other', { reason })
}

export class WatchSwitch implements IViewerSession {
  /** why the native path was given up (a German / English sentence for a toast) */
  onNotice: (message: string) => void = () => {}
  onState: (state: ViewerState, detail?: string) => void = () => {}
  onVideo: (stream: MediaStream) => void = () => {}
  onAudio: (stream: MediaStream) => void = () => {}
  onRenderer: (view: HTMLElement | null) => void = () => {}
  onHostInfo: (info: HostInfo) => void = () => {}
  onHostTx: (tx: Extract<CtlMessage, { t: 'tx' }>) => void = () => {}
  onStats: (stats: InboundStats) => void = () => {}
  readonly origin: string
  /** why the native session was given up ('' while it runs) — diagnostics */
  fallbackReason = ''

  private readonly opts: WatchSwitchOptions
  private native: NativeWatch | null = null
  private web: ViewerSession | null = null
  private started = false
  private stopped = false
  /** the origin went away before a session existed */
  private gone = false
  private latencyMode: LatencyMode | null = null
  private name: string | null = null

  constructor(opts: WatchSwitchOptions) {
    this.opts = opts
    this.origin = opts.origin
  }

  /** 'native' while the native session runs, 'webrtc' after the switch (diagnostics, E2E). */
  transport(): 'native' | 'webrtc' {
    return this.web ? 'webrtc' : 'native'
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void nativeWatchCaps()
      .catch(() => null)
      .then((caps) => {
        if (this.stopped || this.gone || this.web) return
        if (!caps || nvWatchPlan(caps, this.opts.live) === 'webrtc') {
          this.toWebRtc(caps ? 'no common codec' : 'no native caps')
          return
        }
        let n: NativeWatch
        try {
          n = this.opts.makeNative(caps)
        } catch (err) {
          this.toWebRtc(`native setup: ${errText(err)}`)
          return
        }
        this.native = n
        this.bind(n)
        n.onFallback = (reason) => this.toWebRtc(reason)
        if (this.name !== null) n.setName(this.name)
        n.start()
      })
  }

  private toWebRtc(reason: string): void {
    if (this.web || this.stopped) return
    this.fallbackReason = reason
    this.safe(() => this.onNotice(fallbackMessage(reason)))
    const n = this.native
    this.native = null
    if (n) {
      n.onFallback = () => {}
      n.stop()
      this.unbind(n)
    }
    this.safe(() => this.onRenderer(null))
    let w: ViewerSession
    try {
      w = this.opts.makeWebRtc()
    } catch {
      this.safe(() => this.onState('failed'))
      return
    }
    this.web = w
    this.bind(w)
    if (this.latencyMode !== null) w.setLatencyMode(this.latencyMode)
    if (this.name !== null) w.setName(this.name)
    w.start()
  }

  private active(): NativeWatch | ViewerSession | null {
    return this.web ?? this.native
  }

  private bind(s: NativeWatch | ViewerSession): void {
    s.onState = (st, d) => this.onState(st, d)
    s.onVideo = (v) => this.onVideo(v)
    s.onAudio = (a) => this.onAudio(a)
    s.onRenderer = (c) => this.onRenderer(c)
    s.onHostInfo = (i) => this.onHostInfo(i)
    s.onHostTx = (t) => this.onHostTx(t)
    s.onStats = (st) => this.onStats(st)
  }

  private unbind(s: NativeWatch | ViewerSession): void {
    s.onState = () => {}
    s.onVideo = () => {}
    s.onAudio = () => {}
    s.onRenderer = () => {}
    s.onHostInfo = () => {}
    s.onHostTx = () => {}
    s.onStats = () => {}
  }

  handleSignal(from: string, body: SignalBody): boolean {
    if (this.stopped) return false
    if (this.native && this.native.handleSignal(from, body)) return true
    return !!this.web && this.web.handleSignal(from, body)
  }

  nudge(): void {
    this.active()?.nudge()
  }

  originGone(reason?: string): void {
    const s = this.active()
    if (s) {
      s.originGone(reason)
      return
    }
    if (this.gone || this.stopped) return
    this.gone = true
    this.safe(() => this.onState('ended'))
  }

  state(): ViewerState {
    return this.active()?.state() ?? (this.gone ? 'ended' : 'waiting')
  }

  setLatencyMode(mode: LatencyMode): void {
    this.latencyMode = mode
    this.active()?.setLatencyMode(mode)
  }

  relayChildren(): number {
    return this.web ? this.web.relayChildren() : 0
  }

  upstreamAlive(): boolean {
    return this.active()?.upstreamAlive() ?? false
  }

  setName(name: string): void {
    this.name = name
    this.active()?.setName(name)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.native?.stop()
    this.web?.stop()
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch {
      /* UI callback errors must not break the session */
    }
  }
}

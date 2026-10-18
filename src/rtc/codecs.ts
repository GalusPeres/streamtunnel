// Hardware encode probe, hardware decode capabilities and codec preference ordering.
// Pure helpers (orderCodecs, chooseCodec, classifyEncoder, codecNameFromMime) never touch the DOM.
import type { CodecName, CodecPref } from '../types.ts'
import { AUDIO_KBPS } from './defaults.ts'
import { mungeAnswer, waitIceGathering } from './tuning.ts'
import { nativeRtcActive } from './native.ts'

export interface HwEncoders {
  av1: boolean
  h264: boolean
}

/** Result used when the probe cannot decide (H.264 hardware encode is near-universal on Windows). */
export const FALLBACK_HW: HwEncoders = { av1: false, h264: true }

const HW_ENCODER_RE = /MediaFoundation|NVENC|AMF|QSV|D3D12|VideoToolbox|VAAPI|V4L2|ExternalEncoder/i
const SW_ENCODER_RE = /libaom|libvpx|OpenH264|SVT/i
const HW_DECODER_RE = /ExternalDecoder|D3D11|D3D12|MediaFoundation|VideoToolbox|VAAPI|V4L2/i
const SW_DECODER_RE = /libvpx|dav1d|FFmpeg|libaom|OpenH264|libgav1/i

/** 'video/AV1' → 'AV1' etc.; null for anything we do not negotiate (H.265, rtx, red, …). */
export function codecNameFromMime(mime: string): CodecName | null {
  const m = mime.toLowerCase()
  if (m === 'video/av1' || m === 'video/av1x') return 'AV1'
  if (m === 'video/h264') return 'H264'
  if (m === 'video/vp9') return 'VP9'
  if (m === 'video/vp8') return 'VP8'
  return null
}

/** true = hardware, false = software, null = unknown. */
export function classifyEncoder(implementation: string | undefined, powerEfficient: boolean | undefined): boolean | null {
  const name = implementation ?? ''
  if (powerEfficient === true || HW_ENCODER_RE.test(name)) return true
  if (SW_ENCODER_RE.test(name) || powerEfficient === false) return false
  return null
}

/** Same for decoders (decoderImplementation / powerEfficientDecoder). */
export function classifyDecoder(implementation: string | undefined, powerEfficient: boolean | undefined): boolean | null {
  const name = implementation ?? ''
  if (powerEfficient === true || HW_DECODER_RE.test(name)) return true
  if (SW_DECODER_RE.test(name) || powerEfficient === false) return false
  return null
}

// ───────────────────────── codec ordering ─────────────────────────

const OTHER_ORDER: CodecName[] = ['AV1', 'H264', 'VP9', 'VP8']
const AUX_RE = /^video\/(rtx|red|ulpfec|flexfec(-03)?)$/i
const NEVER_RE = /^video\/(h265|hevc)$/i

function fmtpValue(fmtp: string | undefined, key: string): string | null {
  if (!fmtp) return null
  for (const part of fmtp.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim().toLowerCase() === key) return part.slice(eq + 1).trim()
  }
  return null
}

/** Lower = better. packetization-mode=1 entries always before mode 0; then High > Main > CB > Baseline > rest. */
function h264Rank(fmtp: string | undefined): number {
  const pl = (fmtpValue(fmtp, 'profile-level-id') ?? '').toLowerCase()
  const profile = pl.startsWith('64') ? 0 : pl.startsWith('4d') ? 1 : pl.startsWith('42e0') ? 2 : pl.startsWith('4200') ? 3 : 4
  const mode = fmtpValue(fmtp, 'packetization-mode') === '1' ? 0 : 1
  return mode * 10 + profile
}

/**
 * Codec preference list: primary first (H.264 profiles High > Main > CB > Baseline, mode 1 before 0),
 * then AV1, H264, VP9, VP8 (minus primary), then unknown codecs, then rtx/red/ulpfec/flexfec.
 * H.265 is dropped entirely (WebView2 cannot send it). Input order is otherwise preserved.
 */
export function orderCodecs(caps: RTCRtpCodec[], primary: CodecName): RTCRtpCodec[] {
  const groupOf = (c: RTCRtpCodec): number => {
    if (AUX_RE.test(c.mimeType)) return 100
    const name = codecNameFromMime(c.mimeType)
    if (name === primary) return 0
    if (name) return 1 + OTHER_ORDER.indexOf(name)
    return 50
  }
  const items = caps
    .filter((c) => !NEVER_RE.test(c.mimeType))
    .map((c, i) => ({ c, i, g: groupOf(c), r: codecNameFromMime(c.mimeType) === 'H264' ? h264Rank(c.sdpFmtpLine) : 0 }))
  items.sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i)
  return items.map((x) => x.c)
}

/** Explicit preference wins; auto → AV1 only if the host encodes AV1 in hardware and the viewer decodes it in hardware. */
export function chooseCodec(pref: CodecPref, hostHw: HwEncoders, viewerDec: CodecName[]): CodecName {
  if (pref !== 'auto') return pref
  return hostHw.av1 && viewerDec.includes('AV1') ? 'AV1' : 'H264'
}

/**
 * setCodecPreferences with orderCodecs(). Uses sender capabilities (sendonly transceiver) and falls back to
 * receiver capabilities if the browser rejects them. Returns false if neither worked (default order stays).
 */
export function applyCodecPreferences(transceiver: RTCRtpTransceiver, primary: CodecName): boolean {
  const sources: Array<() => RTCRtpCapabilities | null> = [
    () => (typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities('video') : null),
    () => (typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities('video') : null),
  ]
  for (const get of sources) {
    try {
      const caps = get()
      if (!caps || caps.codecs.length === 0) continue
      transceiver.setCodecPreferences(orderCodecs(caps.codecs, primary))
      return true
    } catch {
      /* try the next capability source */
    }
  }
  return false
}

// ───────────────────────── hardware encoder probe ─────────────────────────
//
// Only AV1 is probed (H.264 hardware encode is assumed; nothing reads HwEncoders.h264 for decisions). The probe
// encodes a clone of the live capture track at its real size and frame rate (hardware eligibility depends on both:
// MF caps ~1080p120 / 2160p30) and returns as soon as a few frames were encoded. It aborts within ~100 ms when the
// capture track ends (user stopped / switched the source), so it never keeps a capture alive.

const PROBE_TOTAL_MS = 4000
const PROBE_POLL_MS = 100
/** A verdict needs a few encoded frames (a single first frame on a fallback path must not decide it). */
const PROBE_MIN_FRAMES = 3

/** Definite verdicts per source bucket ("WxH@fps"): AV1 in hardware or not. */
const encByBucket = new Map<string, boolean>()
/** Some source already proved AV1 hardware encode in this app session (used by relays, which cannot probe). */
let av1SeenHw = false
let encInflight: { trackId: string; promise: Promise<HwEncoders> } | null = null

function fpsBucket(fps: number): number {
  return fps > 60 ? 120 : fps > 30 ? 60 : 30
}

function bucketOf(track: MediaStreamTrack): string | null {
  let s: MediaTrackSettings = {}
  try { s = track.getSettings() } catch { /* ignore */ }
  const w = typeof s.width === 'number' ? Math.round(s.width) : 0
  const h = typeof s.height === 'number' ? Math.round(s.height) : 0
  if (!(w > 0) || !(h > 0)) return null
  return `${w}x${h}@${fpsBucket(typeof s.frameRate === 'number' ? s.frameRate : 30)}`
}

/**
 * Cached probe verdict. With a track: the definite result for that source's size / fps bucket (null = unknown).
 * Without a track (relays): AV1 counts as hardware only if some source proved it in this app session.
 */
export function cachedHardwareEncoders(track?: MediaStreamTrack): HwEncoders | null {
  if (!track) return av1SeenHw ? { av1: true, h264: true } : null
  const key = bucketOf(track)
  const v = key ? encByBucket.get(key) : undefined
  return v === undefined ? null : { av1: v, h264: true }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

type Rec = Record<string, unknown>

/** undefined = not enough frames encoded yet; otherwise the classification. */
async function readEncoder(pc: RTCPeerConnection): Promise<boolean | null | undefined> {
  const report = await pc.getStats()
  let result: boolean | null | undefined
  report.forEach((s: Rec) => {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video') return
    const frames = typeof s.framesEncoded === 'number' ? s.framesEncoded : 0
    if (frames < PROBE_MIN_FRAMES) return
    const impl = typeof s.encoderImplementation === 'string' ? s.encoderImplementation : undefined
    const pe = typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : undefined
    if ((!impl || impl === 'unknown') && pe === undefined) {
      result = null // frames flow but the implementation is hidden (page not capturing)
      return
    }
    result = classifyEncoder(impl, pe)
  })
  return result
}

/** Resources of one running probe (closed by the probe itself or by the hard-cap timeout). */
interface ProbeRes {
  pcs: RTCPeerConnection[]
  clone: MediaStreamTrack | null
  done: boolean
}

function releaseProbe(res: ProbeRes): void {
  if (res.done) return
  res.done = true
  for (const pc of res.pcs) {
    try { pc.close() } catch { /* ignore */ }
  }
  try { res.clone?.stop() } catch { /* ignore */ }
}

/** Loopback AV1 encode test: true = HW, false = SW / not available, null = could not tell (aborted, hidden, timeout). */
async function probeAv1(track: MediaStreamTrack, deadline: number, res: ProbeRes): Promise<boolean | null> {
  const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? []
  const wanted = caps.filter((c) => codecNameFromMime(c.mimeType) === 'AV1')
  if (wanted.length === 0) return false
  const alive = () => !res.done && track.readyState === 'live' && performance.now() < deadline
  const a = new RTCPeerConnection()
  const b = new RTCPeerConnection()
  res.pcs.push(a, b)
  const clone = track.clone()
  res.clone = clone
  let fps = 0
  try { fps = track.getSettings().frameRate ?? 0 } catch { /* ignore */ }
  try {
    if (!alive()) return null
    // Screencast mode: no automatic downscaling (Chromium forces software encoders below 360p).
    try { clone.contentHint = 'detail' } catch { /* ignore */ }
    // Same size and frame rate as the real sender, so the encoder is set up the same way.
    const enc: RTCRtpEncodingParameters = { maxBitrate: 10_000_000 }
    if (fps > 0) enc.maxFramerate = fps
    const tr = a.addTransceiver(clone, { direction: 'sendonly', sendEncodings: [enc] })
    try {
      tr.setCodecPreferences(orderCodecs(wanted, 'AV1'))
    } catch {
      const recv = (RTCRtpReceiver.getCapabilities('video')?.codecs ?? []).filter((c) => codecNameFromMime(c.mimeType) === 'AV1')
      try { if (recv.length) tr.setCodecPreferences(orderCodecs(recv, 'AV1')) } catch { /* default order */ }
    }
    await a.setLocalDescription()
    if (!alive()) return null
    await waitIceGathering(a, 500)
    const offer = a.localDescription
    if (!offer || !alive()) return null
    await b.setRemoteDescription(offer)
    await b.setLocalDescription()
    if (!alive()) return null
    await waitIceGathering(b, 500)
    const answer = b.localDescription
    if (!answer || !alive()) return null
    await a.setRemoteDescription({ type: 'answer', sdp: mungeAnswer(answer.sdp, { startKbps: 8000, audioKbps: AUDIO_KBPS }) })
    // Early exit: return on the first read with enough encoded frames instead of a fixed run time.
    while (alive()) {
      const r = await readEncoder(a)
      if (r !== undefined) return r
      await sleep(Math.min(PROBE_POLL_MS, deadline - performance.now()))
    }
    return null
  } finally {
    releaseProbe(res)
  }
}

async function runProbe(track: MediaStreamTrack): Promise<{ value: HwEncoders; definite: boolean; key: string | null }> {
  const key = bucketOf(track)
  if (typeof RTCPeerConnection === 'undefined' || track.kind !== 'video' || track.readyState !== 'live') {
    return { value: FALLBACK_HW, definite: false, key }
  }
  const res: ProbeRes = { pcs: [], clone: null, done: false }
  const deadline = performance.now() + PROBE_TOTAL_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Hard cap in case getStats / setRemoteDescription hangs: also tears the probe down (stops the clone).
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        releaseProbe(res)
        resolve(null)
      }, PROBE_TOTAL_MS + 1500)
    })
    const av1 = await Promise.race([probeAv1(track, deadline, res), timeout])
    return { value: { av1: av1 === true, h264: true }, definite: av1 !== null, key }
  } catch {
    releaseProbe(res)
    return { value: FALLBACK_HW, definite: false, key }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Loopback test whether AV1 encodes in hardware for this source (needs a live capture track; the page must be
 * capturing, otherwise Chromium hides encoderImplementation). Definite results are cached per source size / fps
 * bucket for the app session; on failure resolves to {av1:false, h264:true} without caching.
 */
export function probeHardwareEncoders(videoTrack: MediaStreamTrack): Promise<HwEncoders> {
  const cached = cachedHardwareEncoders(videoTrack)
  if (cached) return Promise.resolve(cached)
  // Reuse an in-flight probe only for the same track (a probe of another source says nothing about this one).
  if (encInflight && encInflight.trackId === videoTrack.id) return encInflight.promise
  const p = runProbe(videoTrack).then((r) => {
    if (r.definite && r.key) encByBucket.set(r.key, r.value.av1)
    if (r.definite && r.value.av1) av1SeenHw = true
    return r.value
  })
  const entry = { trackId: videoTrack.id, promise: p }
  encInflight = entry
  void p.finally(() => {
    if (encInflight === entry) encInflight = null
  })
  return p
}

// ───────────────────────── hardware decoders ─────────────────────────

let decCache: Promise<CodecName[]> | null = null

async function detectDecoders(): Promise<CodecName[]> {
  // Linux app: the GStreamer engine answers H.264 only (decoded by WebCodecs, VA-API when available)
  if (nativeRtcActive()) return ['H264']
  const mc = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined
  if (!mc || typeof mc.decodingInfo !== 'function') return []
  const list: Array<[CodecName, string]> = [
    ['AV1', 'video/AV1'],
    ['H264', 'video/H264'],
    ['VP9', 'video/VP9'],
  ]
  const results = await Promise.all(
    list.map(async ([name, contentType]): Promise<CodecName | null> => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000) })
        const info = await Promise.race([
          mc.decodingInfo({ type: 'webrtc', video: { contentType, width: 1920, height: 1080, bitrate: 10e6, framerate: 60 } }),
          timeout,
        ])
        clearTimeout(timer)
        return info && info.supported && info.powerEfficient ? name : null
      } catch {
        return null
      }
    }),
  )
  return results.filter((n): n is CodecName => n !== null)
}

/** Codecs this machine decodes in hardware for WebRTC (MediaCapabilities; reliable for decode). Cached. */
export function hardwareDecoders(): Promise<CodecName[]> {
  if (!decCache) decCache = detectDecoders().catch(() => [])
  return decCache
}

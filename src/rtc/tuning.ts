// SDP munging (remote answer on the sending side), sender parameters and receiver tuning.
// mungeAnswer / negotiatedVideoCodec / startBitrateKbps are pure string/number functions (unit-tested).
import type { CodecName, ContentMode, LatencyMode, NetConfig } from '../types.ts'
import { AUDIO_KBPS, DEFAULT_NET, iceServers } from './defaults.ts'
import { NativePeerConnection, nativeRtcActive } from './native.ts'

export interface MungeOptions {
  /** x-google-start-bitrate for the video codecs, kbps */
  startKbps: number
  /** x-google-min-bitrate (kbps): the bandwidth estimate may not go below it — same LAN only, keeps the rate steady */
  minKbps?: number
  /** Opus maxaveragebitrate, kbps */
  audioKbps: number
}

const VIDEO_CODEC_NAMES = new Set(['av1', 'av1x', 'h264', 'vp8', 'vp9'])

function mergeFmtpParams(existing: string, params: Array<[string, string]>): string {
  const parts = existing
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const keyOf = (p: string) => {
    const eq = p.indexOf('=')
    return (eq < 0 ? p : p.slice(0, eq)).trim().toLowerCase()
  }
  for (const [key, value] of params) {
    const k = key.toLowerCase()
    const idx = parts.findIndex((p) => keyOf(p) === k)
    const entry = `${key}=${value}`
    if (idx < 0) {
      parts.push(entry)
    } else {
      parts[idx] = entry
      // drop later duplicates of the same key
      for (let i = parts.length - 1; i > idx; i--) if (keyOf(parts[i]) === k) parts.splice(i, 1)
    }
  }
  return parts.join(';')
}

/**
 * Video m-line: if the first codec is H.264 but the answer also lists an H.264 High-profile payload type
 * (profile-level-id 64…, packetization-mode=1), move that one to the front. Chromium encodes High profile with the
 * GPU's H.264 encoder, constrained baseline only in software (crbug 1088650).
 */
export function preferH264High(lines: string[]): string[] {
  const mIdx = lines.findIndex((l) => /^m=video\s/.test(l))
  if (mIdx < 0) return lines
  const parts = lines[mIdx].split(' ')
  const pts = parts.slice(3)
  const name = new Map<string, string>()
  const fmtp = new Map<string, string>()
  for (const l of lines) {
    const r = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(l)
    if (r) name.set(r[1], r[2].toUpperCase())
    const f = /^a=fmtp:(\d+)\s+(.*)$/.exec(l)
    if (f) fmtp.set(f[1], f[2])
  }
  if (name.get(pts[0]) !== 'H264') return lines
  const isHigh = (pt: string) => {
    const p = fmtp.get(pt) ?? ''
    return name.get(pt) === 'H264' && /profile-level-id=64/i.test(p) && /packetization-mode=1/.test(p)
  }
  if (isHigh(pts[0])) return lines
  const high = pts.find(isHigh)
  if (!high) return lines
  const out = lines.slice()
  out[mIdx] = [...parts.slice(0, 3), high, ...pts.filter((p) => p !== high)].join(' ')
  return out
}

function mungeSection(lines: string[], opts: MungeOptions): string[] {
  const kind = /^m=(\w+)/.exec(lines[0])?.[1]
  if (kind === 'video') lines = preferH264High(lines)
  if (kind !== 'video' && kind !== 'audio') return lines
  const targets = new Set<string>()
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(l)
    if (!m) continue
    const name = m[2].toLowerCase()
    if (kind === 'video' ? VIDEO_CODEC_NAMES.has(name) : name === 'opus') targets.add(m[1])
  }
  if (targets.size === 0) return lines
  const params: Array<[string, string]> =
    kind === 'video'
      ? [
          ['x-google-start-bitrate', String(Math.max(1, Math.round(opts.startKbps)))],
          ...(opts.minKbps && opts.minKbps > 0 ? ([['x-google-min-bitrate', String(Math.round(opts.minKbps))]] as Array<[string, string]>) : []),
        ]
      : [
          ['stereo', '1'],
          ['sprop-stereo', '1'],
          ['maxaveragebitrate', String(Math.max(6000, Math.round(opts.audioKbps * 1000)))],
          ['useinbandfec', '1'],
          ['usedtx', '0'],
        ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of lines) {
    const m = /^a=fmtp:(\d+)(?:\s+(.*))?$/.exec(l)
    if (m && targets.has(m[1])) {
      if (seen.has(m[1])) continue // duplicate fmtp line for the same payload type: keep the first only
      seen.add(m[1])
      out.push(`a=fmtp:${m[1]} ${mergeFmtpParams(m[2] ?? '', params)}`)
      continue
    }
    out.push(l)
  }
  for (const pt of targets) {
    if (seen.has(pt)) continue
    const line = `a=fmtp:${pt} ${mergeFmtpParams('', params)}`
    const idx = out.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `))
    if (idx >= 0) out.splice(idx + 1, 0, line)
    else out.push(line)
  }
  return out
}

/**
 * Munges the viewer's answer before the host applies it as remote description:
 * video codecs get x-google-start-bitrate, Opus gets stereo/bitrate/FEC/no-DTX. CRLF line endings.
 */
export function mungeAnswer(sdp: string, opts: MungeOptions): string {
  const lines = sdp.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const sections: string[][] = [[]]
  for (const l of lines) {
    if (l.startsWith('m=')) sections.push([l])
    else sections[sections.length - 1].push(l)
  }
  const out: string[] = [...sections[0]]
  for (let i = 1; i < sections.length; i++) out.push(...mungeSection(sections[i], opts))
  return out.join('\r\n') + '\r\n'
}

/** Codec of the first payload type in the video m-line (= the codec the sender will use), or null. */
export function negotiatedVideoCodec(sdp: string): CodecName | null {
  const lines = sdp.split(/\r?\n/)
  let inVideo = false
  let firstPt: string | null = null
  for (const l of lines) {
    if (l.startsWith('m=')) {
      if (inVideo) break
      const m = /^m=video\s+\d+\s+\S+\s+(.*)$/.exec(l)
      if (m && !/^m=video\s+0\s/.test(l)) {
        inVideo = true
        firstPt = m[1].trim().split(/\s+/)[0] ?? null
      }
      continue
    }
    if (!inVideo || firstPt === null) continue
    const r = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(l)
    if (r && r[1] === firstPt) {
      const name = r[2].toUpperCase()
      if (name === 'AV1' || name === 'AV1X') return 'AV1'
      if (name === 'H264') return 'H264'
      if (name === 'VP9') return 'VP9'
      if (name === 'VP8') return 'VP8'
      return null
    }
  }
  return null
}

/** Start bitrate for the bandwidth estimator: 60 % of max, clamped to [3000, 10000] kbps. */
export function startBitrateKbps(maxKbps: number): number {
  return Math.min(10000, Math.max(3000, Math.round(maxKbps * 0.6)))
}

/**
 * Resolution and frame rate stay fixed in every mode; when the link is short only the bitrate (quality) gives way.
 * Measured in Chromium at 2.5 Mbit/s for 1440p60: 'maintain-framerate' fell to 640x360, this kept 2560x1440 @ 57 fps.
 */
export function degradationFor(_content: ContentMode): RTCDegradationPreference {
  return 'maintain-framerate-and-resolution' as RTCDegradationPreference
}

export interface SenderParamsOptions {
  maxKbps: number
  fps: number
  content: ContentMode
  kind: 'video' | 'audio'
}

const senderChains = new WeakMap<RTCRtpSender, Promise<void>>()

async function applyNow(sender: RTCRtpSender, o: SenderParamsOptions): Promise<void> {
  const build = (withDegradation: boolean): RTCRtpSendParameters => {
    const p = sender.getParameters() // fresh transactionId every time
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}]
    const e = p.encodings[0]
    if (o.kind === 'video') {
      e.maxBitrate = Math.max(100, Math.round(o.maxKbps)) * 1000
      if (o.fps > 0) e.maxFramerate = o.fps
      e.priority = 'high'
      e.networkPriority = 'high'
      if (withDegradation) p.degradationPreference = degradationFor(o.content)
    } else {
      e.maxBitrate = AUDIO_KBPS * 1000
      e.priority = 'high'
    }
    return p
  }
  try {
    await sender.setParameters(build(true))
  } catch {
    if (o.kind !== 'video') return
    try {
      await sender.setParameters(build(false))
    } catch {
      /* closed pc or unsupported — nothing else to do */
    }
  }
}

/**
 * Applies bitrate/framerate/priority/degradation to a sender. Calls are serialized per sender (setParameters
 * must never overlap) and must only be made after negotiation. Never rejects.
 */
export function applySenderParams(sender: RTCRtpSender, opts: SenderParamsOptions): Promise<void> {
  const prev = senderChains.get(sender) ?? Promise.resolve()
  const next = prev.then(() => applyNow(sender, opts)).catch(() => {})
  senderChains.set(sender, next)
  return next
}

/** 'lowest' → jitterBufferTarget 0 (default behaviour), 'smooth' → 120 ms floor. */
export function tuneReceiver(receiver: RTCRtpReceiver, mode: LatencyMode): void {
  if ('jitterBufferTarget' in receiver) {
    try {
      receiver.jitterBufferTarget = mode === 'smooth' ? 120 : 0
    } catch {
      /* RangeError / unsupported — ignore */
    }
  }
  // Older name (seconds) that some engines still implement instead (WebKit / Mac app).
  const r = receiver as RTCRtpReceiver & { playoutDelayHint?: number | null }
  if ('playoutDelayHint' in r) {
    try {
      r.playoutDelayHint = mode === 'smooth' ? 0.12 : 0
    } catch {
      /* ignore */
    }
  }
}

/** Resolves when ICE gathering is complete or after `ms` (half-trickle). Never rejects. */
export function waitIceGathering(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete' || pc.signalingState === 'closed') return Promise.resolve()
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    timer = setTimeout(done, Math.max(0, ms))
  })
}

const STUN_URL_RE = /^stuns?:[^\s]+$/i
const TURN_URL_RE = /^turns?:[^\s]+$/i

/** Keeps only syntactically plausible STUN urls and TURN servers with credentials. */
function filteredIceServers(net: NetConfig): RTCIceServer[] {
  const stun = (net.stun ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => STUN_URL_RE.test(s))
  const out: RTCIceServer[] = stun.length > 0 ? [{ urls: stun }] : []
  for (const t of net.turn ?? []) {
    const url = typeof t?.urls === 'string' ? t.urls.trim() : ''
    if (TURN_URL_RE.test(url) && t.username && t.credential) out.push({ urls: url, username: t.username, credential: t.credential })
  }
  return out
}

/**
 * RTCPeerConnection with max-bundle / rtcp-mux. Invalid user ICE configuration makes the constructor throw;
 * then retry with the plausible entries, then the default STUN list, then none. `iceConfigInvalid` tells
 * the caller to show a notice. Throws only if WebRTC itself is unavailable.
 */
export function createPeerConnection(net: NetConfig): { pc: RTCPeerConnection; iceConfigInvalid: boolean } {
  const base: RTCConfiguration = { bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }
  // Linux app (WebKitGTK has no WebRTC): GStreamer engine behind an RTCPeerConnection-shaped stand-in (watch only).
  if (nativeRtcActive()) {
    return { pc: new NativePeerConnection({ ...base, iceServers: filteredIceServers(net) }) as unknown as RTCPeerConnection, iceConfigInvalid: false }
  }
  try {
    return { pc: new RTCPeerConnection({ ...base, iceServers: iceServers(net) }), iceConfigInvalid: false }
  } catch {
    /* fall through to the repaired configurations */
  }
  const fallbacks: RTCIceServer[][] = [filteredIceServers(net), iceServers(DEFAULT_NET), []]
  let lastError: unknown = null
  for (const servers of fallbacks) {
    try {
      return { pc: new RTCPeerConnection({ ...base, iceServers: servers }), iceConfigInvalid: true }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('RTCPeerConnection unavailable')
}

/** Connection addresses of the srflx (public, as seen by STUN) and private IPv4 host candidates in an SDP. */
function candidateAddrs(sdp: string): { pub: Set<string>; lan: Set<string> } {
  const pub = new Set<string>()
  const lan = new Set<string>()
  for (const l of sdp.split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/.exec(l)
    if (!m) continue
    const [, addr, typ] = m
    if (typ === 'srflx') pub.add(addr)
    else if (typ === 'host' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr)) lan.add(addr.split('.').slice(0, 3).join('.'))
  }
  return { pub, lan }
}

/**
 * Both ends in the same local network: same public address behind the router (srflx) or private host addresses in
 * the same /24. There the sender may run at a fixed rate like Parsec does instead of probing up and down.
 */
export function sameNetwork(offerSdp: string, answerSdp: string): boolean {
  const a = candidateAddrs(offerSdp)
  const b = candidateAddrs(answerSdp)
  for (const x of a.pub) if (b.pub.has(x)) return true
  for (const x of a.lan) if (b.lan.has(x)) return true
  return false
}

/**
 * Offer for a WebKit viewer (Mac app). WebKit only receives H.264 Constrained High (640c..) and Constrained Baseline,
 * Chromium's GPU encoder only offers High (64..), and libwebrtc matches profiles exactly, so the two would meet on
 * Constrained Baseline, which Chromium encodes in software (crbug 1088650). Show High as Constrained High towards the
 * viewer (it never gets B-frames from WebRTC, so its decoder is fine) and remember the real value per payload type.
 */
export function asConstrainedHigh(sdp: string): { sdp: string; restore: Record<string, string> } {
  const restore: Record<string, string> = {}
  const lines = sdp.split(/\r\n|\n/).map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (!m) return l
    const pl = /profile-level-id=([0-9a-fA-F]{6})/.exec(m[2])
    if (!pl) return l
    const id = pl[1].toLowerCase()
    if (!id.startsWith('64') || id.startsWith('640c')) return l
    restore[m[1]] = id
    return l.replace(pl[0], `profile-level-id=640c${id.slice(4)}`)
  })
  return { sdp: lines.join('\r\n'), restore }
}

/** The viewer's answer back to what our local offer really said (see asConstrainedHigh). */
export function restoreH264Profiles(sdp: string, restore: Record<string, string>): string {
  return sdp
    .split(/\r\n|\n/)
    .map((l) => {
      const m = /^a=fmtp:(\d+) /.exec(l)
      const real = m ? restore[m[1]] : undefined
      return real ? l.replace(/profile-level-id=[0-9a-fA-F]{6}/, `profile-level-id=${real}`) : l
    })
    .join('\r\n')
}

// getStats sampling → OutboundStats (host side) / InboundStats (viewer side) with interval deltas.
import type { ConnType, InboundStats, OutboundStats } from '../types.ts'
import { classifyDecoder, classifyEncoder } from './codecs.ts'

type Rec = Record<string, unknown>

const num = (r: Rec | undefined, k: string): number | undefined => {
  const v = r?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
const str = (r: Rec | undefined, k: string): string | undefined => {
  const v = r?.[k]
  return typeof v === 'string' ? v : undefined
}
const bool = (r: Rec | undefined, k: string): boolean | undefined => {
  const v = r?.[k]
  return typeof v === 'boolean' ? v : undefined
}

/** Counters remembered between two samples of one RTP stream. */
interface Snap {
  id: string
  ts: number
  bytes: number
  frames: number
  /** totalEncodeTime (outbound) / totalDecodeTime (inbound), seconds */
  procTime: number
  jbDelay: number
  jbCount: number
  lost: number
  recv: number
}

function snap(s: Rec, outbound: boolean): Snap {
  return {
    id: str(s, 'id') ?? '',
    ts: num(s, 'timestamp') ?? 0,
    bytes: num(s, outbound ? 'bytesSent' : 'bytesReceived') ?? 0,
    frames: num(s, outbound ? 'framesEncoded' : 'framesDecoded') ?? 0,
    procTime: num(s, outbound ? 'totalEncodeTime' : 'totalDecodeTime') ?? 0,
    jbDelay: num(s, 'jitterBufferDelay') ?? 0,
    jbCount: num(s, 'jitterBufferEmittedCount') ?? 0,
    lost: num(s, 'packetsLost') ?? 0,
    recv: num(s, 'packetsReceived') ?? 0,
  }
}

/** Previous snapshot only if it belongs to the same stream and counters did not go backwards. */
function usablePrev(prev: Snap | null, cur: Snap): Snap | null {
  if (!prev || prev.id !== cur.id || cur.ts <= prev.ts || cur.bytes < prev.bytes || cur.frames < prev.frames) return null
  return prev
}

const kbpsBetween = (prev: Snap | null, cur: Snap): number => (prev ? ((cur.bytes - prev.bytes) * 8) / (cur.ts - prev.ts) : 0)

/** Window for the displayed frame rate: long enough that 59/61 jitter of single intervals averages out. */
const FPS_WINDOW_MS = 3000

/**
 * Frame rate over the last FPS_WINDOW_MS from the frame counter (encoded / decoded frames), keeping `hist` as a
 * rolling list of samples. Starts over when the stream changes or a counter goes backwards. 0 until two samples exist.
 */
export function windowFps(hist: Array<{ id: string; ts: number; frames: number }>, cur: { id: string; ts: number; frames: number }): number {
  const last = hist[hist.length - 1]
  if (last && (last.id !== cur.id || cur.ts <= last.ts || cur.frames < last.frames)) hist.length = 0
  hist.push({ id: cur.id, ts: cur.ts, frames: cur.frames })
  // keep the newest sample that is at least FPS_WINDOW_MS old as the window start
  while (hist.length > 2 && cur.ts - hist[1].ts >= FPS_WINDOW_MS) hist.shift()
  const first = hist[0]
  if (hist.length < 2 || cur.ts <= first.ts) return 0
  return ((cur.frames - first.frames) * 1000) / (cur.ts - first.ts)
}

function selectedPair(report: RTCStatsReport): Rec | undefined {
  let pair: Rec | undefined
  report.forEach((s: Rec) => {
    if (pair || s.type !== 'transport') return
    const id = str(s, 'selectedCandidatePairId')
    if (id) pair = report.get(id) as Rec | undefined
  })
  if (!pair) {
    report.forEach((s: Rec) => {
      if (!pair && s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded') pair = s
    })
  }
  return pair
}

/** 8 groups of an IPv6 address, or null if it is not one. */
function v6Groups(addr: string): number[] | null {
  let a = addr.toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const pct = a.indexOf('%')
  if (pct >= 0) a = a.slice(0, pct)
  if (!a.includes(':')) return null
  const halves = a.split('::')
  if (halves.length > 2) return null
  const parse = (p: string): number[] => (p ? p.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : [])
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail]
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null
}

function v4Octets(addr: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every((x) => x <= 255) ? o : null
}

/** Private, link-local, CGNAT, loopback or mDNS (.local) address. */
export function isLocalAddress(addr: string): boolean {
  if (/\.local\.?$/i.test(addr)) return true
  const v4 = v4Octets(addr)
  if (v4) {
    const [a, b] = v4
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  const v6 = v6Groups(addr)
  if (!v6) return false
  if (v6.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true // ::1
  return (v6[0] & 0xfe00) === 0xfc00 || (v6[0] & 0xffc0) === 0xfe80
}

/**
 * Host↔host pair = 'lan' only if both ends are local addresses, both are global IPv6 in the same /64 (same home
 * network) or the IPv4 addresses are equal; public IPv6 host candidates across the internet are 'p2p'.
 * Missing addresses keep the old 'lan' verdict.
 */
export function hostPairIsLan(local: string | undefined, remote: string | undefined): boolean {
  if (!local || !remote) return true
  if (isLocalAddress(local) && isLocalAddress(remote)) return true
  const l6 = v6Groups(local)
  const r6 = v6Groups(remote)
  if (l6 && r6) return l6[0] === r6[0] && l6[1] === r6[1] && l6[2] === r6[2] && l6[3] === r6[3]
  return local === remote
}

function connTypeOf(report: RTCStatsReport, pair: Rec | undefined): ConnType {
  if (!pair) return 'unknown'
  const local = report.get(str(pair, 'localCandidateId') ?? '') as Rec | undefined
  const remote = report.get(str(pair, 'remoteCandidateId') ?? '') as Rec | undefined
  const lt = str(local, 'candidateType')
  const rt = str(remote, 'candidateType')
  if (!lt || !rt) return 'unknown'
  if (lt === 'relay' || rt === 'relay') return 'relay'
  if (lt === 'host' && rt === 'host') {
    return hostPairIsLan(str(local, 'address') ?? str(local, 'ip'), str(remote, 'address') ?? str(remote, 'ip')) ? 'lan' : 'p2p'
  }
  return 'p2p'
}

function codecOf(report: RTCStatsReport, s: Rec): string {
  const c = report.get(str(s, 'codecId') ?? '') as Rec | undefined
  const mime = str(c, 'mimeType') ?? ''
  const slash = mime.indexOf('/')
  return slash >= 0 ? mime.slice(slash + 1).toUpperCase() : mime.toUpperCase()
}

function pickLargest(report: RTCStatsReport, type: string, kind: string, bytesKey: string): Rec | undefined {
  let best: Rec | undefined
  report.forEach((s: Rec) => {
    if (s.type !== type || s.kind !== kind) return
    if (!best || (num(s, bytesKey) ?? 0) > (num(best, bytesKey) ?? 0)) best = s
  })
  return best
}

export interface LatencyParts {
  /** encode time reported by the sender over ctl 'tx' (null → 6 ms default) */
  hostEncodeMs: number | null
  rttMs: number | null
  jitterBufferMs: number | null
  decodeMs: number | null
  fps: number
  /** latency from the origin to our upstream relay (0 for a direct link) */
  upstreamLatencyMs: number
}

/**
 * Glass-to-glass estimate: encode + rtt/2 + jitter buffer + decode + render(8) + half a capture frame + upstream.
 * null when rtt, jitter buffer or decode time is unknown (never substitutes 0 — that would under-report).
 */
export function estimateLatencyMs(p: LatencyParts): number | null {
  if (p.rttMs === null || !Number.isFinite(p.rttMs)) return null
  if (p.jitterBufferMs === null || !Number.isFinite(p.jitterBufferMs) || p.decodeMs === null || !Number.isFinite(p.decodeMs)) return null
  const encode = p.hostEncodeMs !== null && Number.isFinite(p.hostEncodeMs) ? p.hostEncodeMs : 6
  const capture = p.fps > 0 ? 1000 / p.fps / 2 : 0
  const total = encode + p.rttMs / 2 + p.jitterBufferMs + p.decodeMs + 8 + capture + Math.max(0, p.upstreamLatencyMs || 0)
  return Math.round(total)
}

export interface InboundContext {
  hostEncodeMs?: number | null
  upstreamLatencyMs?: number
}

const round1 = (v: number) => Math.round(v * 10) / 10

export class StatsSampler {
  private readonly pc: RTCPeerConnection
  private prevVideo: Snap | null = null
  private prevAudio: Snap | null = null
  /** last good interval values (inbound latency estimate during freezes) */
  private lastDecodeMs: number | null = null
  private lastJbMs: number | null = null
  private lastFps = 0
  private fpsHist: Array<{ id: string; ts: number; frames: number }> = []

  constructor(pc: RTCPeerConnection) {
    this.pc = pc
  }

  private async report(): Promise<RTCStatsReport | null> {
    if (this.pc.connectionState === 'closed') return null
    try {
      return await this.pc.getStats()
    } catch {
      return null
    }
  }

  /** Sender-side stats of the video (+ audio) sender. null if the pc is closed or nothing is sent yet. */
  async outbound(): Promise<OutboundStats | null> {
    const report = await this.report()
    if (!report) return null
    const video = pickLargest(report, 'outbound-rtp', 'video', 'bytesSent')
    const audio = pickLargest(report, 'outbound-rtp', 'audio', 'bytesSent')
    const pair = selectedPair(report)

    let audioKbps = 0
    if (audio) {
      const cur = snap(audio, true)
      audioKbps = kbpsBetween(usablePrev(this.prevAudio, cur), cur)
      this.prevAudio = cur
    }
    if (!video) return null

    const cur = snap(video, true)
    const prev = usablePrev(this.prevVideo, cur)
    this.prevVideo = cur
    const dFrames = prev ? cur.frames - prev.frames : 0
    const fps = windowFps(this.fpsHist, { id: cur.id, ts: performance.now(), frames: cur.frames })
    const encodeMs = prev && dFrames > 0 ? ((cur.procTime - prev.procTime) * 1000) / dFrames : null

    let remoteIn = report.get(str(video, 'remoteId') ?? '') as Rec | undefined
    if (!remoteIn) {
      report.forEach((s: Rec) => {
        if (!remoteIn && s.type === 'remote-inbound-rtp' && s.kind === 'video') remoteIn = s
      })
    }
    const rttS = num(remoteIn, 'roundTripTime') ?? num(pair, 'currentRoundTripTime')
    const avail = num(pair, 'availableOutgoingBitrate')
    const encoder = str(video, 'encoderImplementation') ?? ''
    return {
      bitrateKbps: Math.round(kbpsBetween(prev, cur)),
      fps: round1(fps),
      width: num(video, 'frameWidth') ?? 0,
      height: num(video, 'frameHeight') ?? 0,
      codec: codecOf(report, video),
      encoder: encoder === 'unknown' ? '' : encoder,
      hw: classifyEncoder(encoder === 'unknown' ? '' : encoder, bool(video, 'powerEfficientEncoder')),
      encodeMs: encodeMs !== null ? round1(encodeMs) : null,
      qualityLimitation: str(video, 'qualityLimitationReason') ?? 'none',
      rttMs: rttS !== undefined ? Math.round(rttS * 1000) : null,
      connType: connTypeOf(report, pair),
      availableKbps: avail !== undefined ? Math.round(avail / 1000) : null,
      audioKbps: Math.round(audioKbps),
    }
  }

  /** Receiver-side stats incl. latency estimate. `hwHint` = MediaCapabilities guess when the decoder is hidden. */
  async inbound(hwHint: boolean | null, ctx: InboundContext = {}): Promise<InboundStats | null> {
    const report = await this.report()
    if (!report) return null
    const video = pickLargest(report, 'inbound-rtp', 'video', 'bytesReceived')
    const audio = pickLargest(report, 'inbound-rtp', 'audio', 'bytesReceived')
    const pair = selectedPair(report)

    let audioKbps = 0
    if (audio) {
      const cur = snap(audio, false)
      audioKbps = kbpsBetween(usablePrev(this.prevAudio, cur), cur)
      this.prevAudio = cur
    }
    if (!video) return null

    const cur = snap(video, false)
    const prev = usablePrev(this.prevVideo, cur)
    this.prevVideo = cur
    const dFrames = prev ? cur.frames - prev.frames : 0
    const fps = windowFps(this.fpsHist, { id: cur.id, ts: performance.now(), frames: cur.frames })
    const decodeMs = prev && dFrames > 0 ? ((cur.procTime - prev.procTime) * 1000) / dFrames : null
    const dJb = prev ? cur.jbCount - prev.jbCount : 0
    const jitterBufferMs = prev && dJb > 0 ? ((cur.jbDelay - prev.jbDelay) * 1000) / dJb : null
    const dLost = prev ? Math.max(0, cur.lost - prev.lost) : 0
    const dRecv = prev ? Math.max(0, cur.recv - prev.recv) : 0
    const lossPct = dLost + dRecv > 0 ? Math.min(100, (dLost * 100) / (dLost + dRecv)) : 0

    // Latency inputs: interval values; on the first sample the cumulative averages; during a freeze (no frames in
    // the interval) the last good interval values — never 0, which would show the best latency at the worst moment.
    if (decodeMs !== null) this.lastDecodeMs = decodeMs
    if (jitterBufferMs !== null) this.lastJbMs = jitterBufferMs
    if (fps > 0) this.lastFps = fps
    const latDecode = decodeMs ?? this.lastDecodeMs ?? (cur.frames > 0 ? (cur.procTime * 1000) / cur.frames : null)
    const latJb = jitterBufferMs ?? this.lastJbMs ?? (cur.jbCount > 0 ? (cur.jbDelay * 1000) / cur.jbCount : null)

    const remoteOut = report.get(str(video, 'remoteId') ?? '') as Rec | undefined
    const rttS = num(remoteOut, 'roundTripTime') ?? num(pair, 'currentRoundTripTime')
    const rttMs = rttS !== undefined ? Math.round(rttS * 1000) : null
    const decoder = str(video, 'decoderImplementation') ?? ''
    const hw = classifyDecoder(decoder === 'unknown' ? '' : decoder, bool(video, 'powerEfficientDecoder')) ?? hwHint
    const latencyMs = estimateLatencyMs({
      hostEncodeMs: ctx.hostEncodeMs ?? null,
      rttMs,
      jitterBufferMs: latJb,
      decodeMs: latDecode,
      fps: fps > 0 ? fps : this.lastFps,
      upstreamLatencyMs: ctx.upstreamLatencyMs ?? 0,
    })
    return {
      bitrateKbps: Math.round(kbpsBetween(prev, cur)),
      fps: round1(fps),
      width: num(video, 'frameWidth') ?? 0,
      height: num(video, 'frameHeight') ?? 0,
      codec: codecOf(report, video),
      decoder: decoder === 'unknown' ? '' : decoder,
      hw,
      rttMs,
      jitterBufferMs: jitterBufferMs !== null ? round1(jitterBufferMs) : null,
      decodeMs: decodeMs !== null ? round1(decodeMs) : null,
      lossPct: round1(lossPct),
      framesDropped: num(video, 'framesDropped') ?? 0,
      freezeCount: num(video, 'freezeCount') ?? 0,
      connType: connTypeOf(report, pair),
      latencyMs,
      audioKbps: Math.round(audioKbps),
    }
  }

  /** Forget interval baselines (e.g. after replaceTrack). */
  reset(): void {
    this.prevVideo = null
    this.prevAudio = null
    this.fpsHist = []
    this.lastDecodeMs = null
    this.lastJbMs = null
    this.lastFps = 0
  }
}

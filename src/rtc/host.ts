// HostSession: one RTCPeerConnection per direct viewer. Used by the member who shares a stream (role 'host', the
// root of its tree) and (role 'relay') by watchers that re-share a received stream to children.
//
// Signal ownership: no HostSession touches room.onSignal. The TunnelSession owns it and routes messages through
// handleSignal() (directly for our own stream, via the ViewerSession for an embedded relay). Joins are only
// accepted for `origin` (the member whose stream this session sends).
import type {
  CodecName,
  CtlMessage,
  HostSessionOptions,
  IHostSession,
  ISignalingRoom,
  NetConfig,
  OutboundStats,
  RejectReason,
  SignalBody,
  StreamSettings,
  ViewerConnState,
  ViewerInfo,
} from '../types.ts'
import { randomId } from '../core/crypto.ts'
import { applyCaptureSettings, contentHintFor } from './capture.ts'
import { applyCodecPreferences, cachedHardwareEncoders, chooseCodec, FALLBACK_HW, probeHardwareEncoders } from './codecs.ts'
import type { HwEncoders } from './codecs.ts'
import { AUDIO_KBPS, DEFAULT_SETTINGS, effectiveBitrateKbps } from './defaults.ts'
import { nextSeq } from './seq.ts'
import { StatsSampler } from './stats.ts'
import { applySenderParams, asConstrainedHigh, createPeerConnection, mungeAnswer, negotiatedVideoCodec, restoreH264Profiles, sameNetwork, startBitrateKbps, waitIceGathering } from './tuning.ts'

const STATS_MS = 2000
const GATHER_MS = 800
const ICE_BATCH_MS = 300
const OFFER_RESEND_MS = 1500
const CONNECT_TIMEOUT_MS = 25_000
/** A peer whose offer was never answered is dropped after this (real viewers answer within ~1–3 s). */
const ANSWER_TIMEOUT_MS = 10_000
/** An unanswered offer older than this marks a slot as likely to free up soon (see slotFreeingSoon). */
const STALE_OFFER_MS = 3000
const DISCONNECT_GRACE_MS = 10_000
const KICK_CLOSE_MS = 300
const STOP_CLOSE_MS = 200
const PENDING_EXPIRE_MS = 10_000
/** Undecided approval requests kept at most (a flood of fake ids beyond it is ignored silently). */
const MAX_PENDING = 8
/** Children per relay (a relaying viewer re-encodes once per child). Also bounds the reported rx counts. */
export const MAX_RELAY_CHILDREN = 3
const REDIRECT_HOLD_MS = 8000
/** A viewer that came back from a relay (new jid) is not sent to that relay again within this window. */
const RELAY_TRIED_TTL_MS = 60_000
/** Redirects that never showed up as a child of the relay within REDIRECT_HOLD_MS, counted over this window. */
const RELAY_MISS_WINDOW_MS = 60_000
/** A relay candidate must have reported 'rx' this recently (viewers send it every second). */
const RELAY_RX_FRESH_MS = 4000
/** Relay role: how long a root's ctl 'expect' (vouching for a redirected viewer) stays valid. */
const EXPECT_TTL_MS = 15_000
const MAX_EXPECTED = 16
/** Below this per-viewer share the upload budget counts as exhausted (never for the first direct viewer). */
const MIN_PEER_KBPS = 1500
const MAX_PENDING_ICE = 128
const MAX_LATE_ICE = 64
const MAX_DC_QUEUE = 32
const DEAD_JID_CAP = 256
const RELAY_TRIED_CAP = 256
/** Global budget for 'reject' replies (a join flood must not crowd out offers / ICE on the brokers). */
const REJECT_RATE_PER_SEC = 4
const REJECT_BURST = 8
/** Per-peer budget for incoming ctl messages (legit: 'rx' once a second + one 'hello'). */
const CTL_RATE_PER_SEC = 20
const CTL_BURST = 40
/** Dropped ctl messages after which the peer is disconnected. */
const CTL_ABUSE_DROPS = 400
/** onViewersChanged is coalesced to at most one call per this interval. */
const EMIT_MIN_INTERVAL_MS = 100

const SW_NOTICE = 'Software-Encoder aktiv (hohe CPU-Last) – niedrigere Auflösung/FPS oder H.264 wählen.'
const ICE_CONFIG_NOTICE = 'STUN/TURN-Einstellungen ungültig – ungültige Einträge werden ignoriert. Bitte unter „Erweitert“ prüfen.'

type RxMessage = Extract<CtlMessage, { t: 'rx' }>
type Timer = ReturnType<typeof setTimeout>

interface PendingJoin {
  id: string
  name: string
  jid: string
  dec: CodecName[]
  lastJoinAt: number
}

interface Peer {
  id: string
  name: string
  jid: string
  sid: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  dcQueue: Array<{ t: string; data: string }>
  videoTr: RTCRtpTransceiver | null
  audioTr: RTCRtpTransceiver | null
  codec: CodecName
  state: ViewerConnState
  createdAt: number
  connectedAt: number | null
  offerSdp: string | null
  /** both ends in the same local network (from the candidates): fixed high rate like Moonlight */
  lan: boolean
  /** WebKit viewer: real H.264 profile-level-id per payload type we relabelled in the offer (asConstrainedHigh) */
  h264Restore: Record<string, string>
  offerSentAt: number
  localDescSent: boolean
  answerApplied: boolean
  remoteSet: boolean
  pendingRemoteIce: RTCIceCandidateInit[]
  lateLocalIce: RTCIceCandidateInit[]
  iceOut: RTCIceCandidateInit[]
  sampler: StatsSampler | null
  tx: OutboundStats | null
  rx: RxMessage | null
  /** Date.now() of the last 'rx' from this viewer */
  rxAt: number
  swCount: number
  maxKbps: number
  /** viewer id → time we redirected it to this peer (counts as a child until rx catches up, oldest first) */
  redirects: Map<string, number>
  /** times of redirects that never showed up as a child of this relay (last RELAY_MISS_WINDOW_MS) */
  redirectMisses: number[]
  /** 'hello' is accepted once per connection */
  named: boolean
  /** ctl rate limit (token bucket) */
  ctlTokens: number
  ctlRefill: number
  ctlDrops: number
  connectTimer: Timer | null
  answerTimer: Timer | null
  disconnectTimer: Timer | null
  iceTimer: Timer | null
  closed: boolean
}

export class HostSession implements IHostSession {
  onViewersChanged: (viewers: ViewerInfo[]) => void = () => {}
  onJoinRequest: (viewer: { id: string; name: string }, allow: (ok: boolean) => void) => void = (_v, allow) => allow(true)
  onNotice: (message: string) => void = () => {}
  /** id of the member whose stream this session sends (root: our own id; relay: the watched member) */
  readonly origin: string

  private readonly room: ISignalingRoom
  private readonly net: NetConfig
  private readonly role: 'host' | 'relay'
  private readonly maxDirect: number
  private readonly uploadLimitKbps: number
  private readonly requireApproval: boolean
  /** viewers whose join said they run on WebKit (Mac app) */
  private readonly webkitViewers = new Set<string>()
  private hostName: string
  private readonly upstreamLatency: (() => number) | undefined
  private hops: number
  private originName: string | undefined
  private settings: StreamSettings
  private stream: MediaStream
  private videoTrack: MediaStreamTrack | null = null
  private audioTrack: MediaStreamTrack | null = null
  /** Separate MediaStreams (msids) for video and audio so the receiver never lip-syncs video to audio. */
  private readonly videoStream: MediaStream
  private readonly audioStream: MediaStream

  private readonly peers = new Map<string, Peer>()
  private readonly pending = new Map<string, PendingJoin>()
  private readonly banned = new Set<string>()
  private readonly denied = new Set<string>()
  private readonly approved = new Set<string>()
  /** ids the host let in (direct or by redirect) this session — allowed back in while locked */
  private readonly admitted = new Set<string>()
  private readonly deadJids = new Map<string, number>()
  /** root: viewer id → relay id → the redirect we sent it there (jid, time) */
  private readonly relayTried = new Map<string, Map<string, { jid: string; at: number }>>()
  /** relay: viewers the root vouched for (ctl 'expect'): id → jid, time */
  private readonly expected = new Map<string, { jid: string; at: number }>()
  private readonly lingering = new Set<RTCPeerConnection>()
  private readonly lingerTimers = new Set<Timer>()

  private hw: HwEncoders | null = null
  private locked = false
  private paused = false
  private started = false
  private stopped = false
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private statsBusy = false
  private swNoticeShown = false
  private iceNoticeShown = false
  private lastInfoViewers = -1
  /** relay: total audience reported by our upstream (includes our own subtree, maybe with a lag) */
  private upstreamViewers = 0
  private opChain: Promise<void> = Promise.resolve()
  private sourceHint: { w: number; h: number } | null = null
  private probing = false
  private rejectTokens = REJECT_BURST
  private rejectRefill = 0
  private emitTimer: Timer | null = null
  private lastEmitAt = -Infinity

  constructor(opts: HostSessionOptions) {
    this.room = opts.room
    this.net = opts.net
    this.role = opts.role ?? 'host'
    const origin = opts.origin ?? (this.role === 'host' ? opts.room.selfId : '')
    if (typeof origin !== 'string' || !origin) throw new TypeError('HostSession: role relay needs an origin')
    this.origin = origin
    this.maxDirect = Math.max(1, Math.floor(opts.maxDirect ?? (this.role === 'relay' ? 3 : 4)))
    this.uploadLimitKbps = this.role === 'host' ? Math.max(0, opts.uploadLimitKbps ?? 0) : 0
    this.requireApproval = this.role === 'host' && opts.requireApproval === true
    this.hostName = opts.hostName
    this.upstreamLatency = opts.upstreamLatencyMs
    this.hops = this.role === 'relay' ? Math.max(1, opts.hops ?? 1) : 0
    this.originName = opts.originName
    this.settings = { ...opts.settings }
    this.stream = opts.stream
    this.videoStream = new MediaStream()
    this.audioStream = new MediaStream()
    this.takeTracks(opts.stream)
  }

  // ───────────────────────── public API ─────────────────────────

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (this.role === 'host') {
      this.maybeProbe()
    } else {
      // Relays cannot see their encoder implementation (not capturing): only a hardware AV1 encoder this machine
      // already proved while hosting in this app session counts; otherwise relays stay on H.264 (see createPeer).
      this.hw = cachedHardwareEncoders() ?? FALLBACK_HW
    }
    this.statsTimer = setInterval(() => void this.statsTick(), STATS_MS)
  }

  /**
   * Root, codec 'auto' only: find out whether AV1 encodes in hardware (loopback probe, cached per source size).
   * Until it resolves AV1 counts as unavailable (new viewers get H.264). Explicit codecs need no probe.
   */
  private maybeProbe(): void {
    if (this.role !== 'host' || this.stopped || !this.started || this.probing || this.settings.codec !== 'auto') return
    if (this.hw?.av1) return
    const track = this.videoTrack
    if (!track || track.readyState !== 'live') {
      this.hw ??= FALLBACK_HW
      return
    }
    const cached = cachedHardwareEncoders(track)
    if (cached) {
      this.hw = cached
      return
    }
    this.probing = true
    probeHardwareEncoders(track)
      .then(
        (hw) => {
          if (!this.stopped) this.hw = hw
        },
        () => {
          if (!this.stopped) this.hw ??= FALLBACK_HW
        },
      )
      .finally(() => {
        this.probing = false
      })
  }

  viewers(): ViewerInfo[] {
    const out: ViewerInfo[] = []
    for (const p of this.pending.values()) {
      out.push({ id: p.id, name: p.name, state: 'pending', connectedAt: null, codec: null, tx: null, rx: null })
    }
    for (const p of this.peers.values()) {
      out.push({ id: p.id, name: p.name, state: p.state, connectedAt: p.connectedAt, codec: p.codec, tx: p.tx, rx: p.rx })
    }
    return out
  }

  relayedCount(): number {
    // Only hop-1 viewers relay, so a relay's children never have descendants: don't let them inflate the count.
    if (this.role === 'relay') return 0
    let n = 0
    for (const p of this.peers.values()) if (p.state === 'connected' && p.rx) n += p.rx.descendants
    return n
  }

  /** Not part of IHostSession: the stream currently sent (after replaceStream the new one). */
  currentStream(): MediaStream {
    return this.stream
  }

  /** Not part of IHostSession: the settings currently applied (after updateSettings the new ones). */
  currentSettings(): StreamSettings {
    return { ...this.settings }
  }

  /** Occupied direct slots (connecting + connected) — what join admission counts against maxDirect. */
  slotCount(): number {
    return this.directCount()
  }

  /**
   * Relay helper: the root host vouches for a viewer it is about to redirect to us (ctl 'expect' over the
   * authenticated data channel). Relays only admit such viewers, so the root's approval / deny / ban / lock hold.
   */
  expect(id: string, jid: string): void {
    if (this.role !== 'relay' || this.stopped) return
    const now = Date.now()
    for (const [k, e] of this.expected) if (now - e.at > EXPECT_TTL_MS) this.expected.delete(k)
    this.expected.delete(id)
    this.expected.set(id, { jid, at: now })
    while (this.expected.size > MAX_EXPECTED) {
      const oldest = this.expected.keys().next().value
      if (oldest === undefined) break
      this.expected.delete(oldest)
    }
  }

  /** Connected direct viewers (relay role: our children). */
  connectedCount(): number {
    let n = 0
    for (const p of this.peers.values()) if (p.state === 'connected') n++
    return n
  }

  kick(viewerId: string): void {
    if (this.stopped) return
    this.banned.add(viewerId)
    const pend = this.pending.get(viewerId)
    if (pend) {
      this.pending.delete(viewerId)
      this.reject(viewerId, pend.jid, 'kicked')
      this.emitViewers()
      return
    }
    const peer = this.peers.get(viewerId)
    if (!peer) return
    this.sendCtl(peer, { t: 'kick' })
    this.reject(viewerId, peer.jid, 'kicked')
    this.removePeer(peer, 'kicked', KICK_CLOSE_MS)
  }

  setLocked(locked: boolean): void {
    this.locked = locked
  }

  isLocked(): boolean {
    return this.locked
  }

  updateSettings(settings: StreamSettings): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      this.settings = { ...settings }
      if (this.role === 'host') {
        await applyCaptureSettings(this.stream, this.settings)
      } else if (this.videoTrack) {
        try { this.videoTrack.contentHint = contentHintFor(this.settings.content) } catch { /* ignore */ }
      }
      if (this.stopped) return
      this.maybeProbe() // e.g. switched to 'auto'
      this.reapplyAll()
      this.broadcastInfo()
    })
  }

  replaceStream(stream: MediaStream): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      this.stream = stream
      this.takeTracks(stream)
      const video = this.videoTrack
      const audio = this.audioTrack
      const jobs: Promise<unknown>[] = []
      for (const p of this.peers.values()) {
        if (p.videoTr) jobs.push(p.videoTr.sender.replaceTrack(video).catch(() => {}))
        if (p.audioTr) jobs.push(p.audioTr.sender.replaceTrack(audio).catch(() => {}))
      }
      await Promise.all(jobs)
      if (this.stopped) return
      // A negative AV1 probe was for the old source's size / fps: check the new source (cached per size).
      if (this.role === 'host' && this.hw && !this.hw.av1) this.maybeProbe()
      this.reapplyAll()
      this.setPaused(false)
      this.broadcastInfo()
    })
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (this.stopped) return
    for (const p of this.peers.values()) this.sendCtl(p, { t: 'paused', paused })
  }

  /** Ends the session: ctl bye to every viewer, broadcast sid-less bye (root: "my stream ended"), close everything. */
  stop(): void {
    this.shutdown(true)
  }

  /**
   * Relay helper: drop all children WITHOUT telling them the stream ended, so they immediately reconnect
   * through the host (used when the relaying viewer leaves, is kicked or gives up).
   */
  release(): void {
    this.shutdown(false)
  }

  /** Relay helper: size of the frames we receive (bitrate model input when the track reports no size). */
  setSourceSize(width: number, height: number): void {
    if (this.stopped || !(width > 0) || !(height > 0)) return
    const prev = this.sourceHint
    if (prev && prev.w === width && prev.h === height) return
    this.sourceHint = { w: width, h: height }
    this.reapplyAll()
  }

  /**
   * Relay helper: upstream info changed → hop count / origin name / total audience for our children
   * (`viewers` = the upstream's viewer count, which already includes our subtree).
   */
  updateUpstream(hops: number, originName: string, viewers?: number): void {
    if (this.role !== 'relay' || this.stopped) return
    const h = Math.max(1, Math.floor(hops))
    if (typeof viewers === 'number' && Number.isFinite(viewers) && viewers >= 0) this.upstreamViewers = Math.round(viewers)
    const changed = h !== this.hops || originName !== this.originName
    this.hops = h
    this.originName = originName
    if (changed || this.viewerCount() !== this.lastInfoViewers) this.broadcastInfo()
  }

  /**
   * Routes one signaling message. Returns true if the message belongs to this session (consumed): a join for our
   * origin, an answer / ice / bye for one of our sids, or a sid-less bye of a viewer that has not connected yet.
   */
  handleSignal(from: string, body: SignalBody): boolean {
    if (this.stopped || !this.started || !body || typeof body !== 'object') return false
    switch (body.t) {
      case 'join':
        if (body.origin !== this.origin) return false // a join for another member's stream
        this.onJoin(from, body)
        return true
      case 'answer': {
        const peer = this.peerBySid(from, body.sid)
        if (!peer) return false
        void this.onAnswer(peer, body.sdp)
        return true
      }
      case 'ice': {
        const peer = this.peerBySid(from, body.sid)
        if (!peer) return false
        this.onRemoteIce(peer, body.c)
        return true
      }
      case 'bye': {
        if (typeof body.sid === 'string') {
          const peer = this.peerBySid(from, body.sid)
          if (!peer) return false
          // A live connection only ends over its own authenticated data channel (ctl 'bye', channel close) or
          // ICE — never because of a signaling message any code holder could forge with the viewer's id + sid.
          if (peer.state !== 'connected') this.removePeer(peer, 'bye')
          return true
        }
        let consumed = false
        // A viewer that was still waiting for approval leaves.
        if (this.pending.delete(from)) {
          this.emitViewers()
          consumed = true
        }
        // It left before our offer arrived (or while reconnecting): free its slot now, not after the timeouts.
        const peer = this.peers.get(from)
        if (peer && !peer.closed && peer.state !== 'connected') {
          this.removePeer(peer, 'bye')
          consumed = true
        }
        return consumed
      }
      default:
        return false
    }
  }

  // ───────────────────────── join handling ─────────────────────────

  private onJoin(from: string, body: Extract<SignalBody, { t: 'join' }>): void {
    const jid = typeof body.jid === 'string' ? body.jid : ''
    if (!jid || jid.length > 64 || !from) return
    const name = sanitizeName(body.name)
    const dec = Array.isArray(body.dec) ? body.dec.filter(isCodecName) : []

    if (this.banned.has(from)) return this.reject(from, jid, 'kicked')
    if (this.denied.has(from)) return this.reject(from, jid, 'denied')
    if (this.deadJids.has(`${from}|${jid}`)) return // late duplicate of an attempt we already closed

    if (body.wk === true) this.webkitViewers.add(from)
    else this.webkitViewers.delete(from)

    const pend = this.pending.get(from)
    if (pend) {
      // still waiting for the host's decision: remember the newest attempt, never ask twice
      pend.jid = jid
      pend.name = name
      pend.dec = dec
      pend.lastJoinAt = Date.now()
      return
    }

    const existing = this.peers.get(from)
    if (existing && existing.jid === jid) {
      this.maybeResendOffer(existing)
      return
    }
    // Relays only take viewers the root host vouched for (ctl 'expect' over the authenticated data channel), so
    // the root's approval / deny / ban / lock also hold for joins addressed directly to a relaying viewer.
    if (this.role === 'relay' && !this.takeExpectation(from, jid)) return this.reject(from, jid, 'full')
    // Same viewer, new attempt (reconnect): drop the old connection before creating a new one.
    if (existing) this.removePeer(existing, 'replaced')

    if (this.locked && !this.admitted.has(from) && !this.approved.has(from)) return this.reject(from, jid, 'locked')

    if (this.requireApproval && !this.approved.has(from)) {
      if (this.pending.size >= MAX_PENDING) return // request flood: ignore new ids silently (real viewers retry)
      this.askApproval({ id: from, name, jid, dec, lastJoinAt: Date.now() })
      return
    }
    this.admit(from, jid, name, dec)
  }

  private takeExpectation(id: string, jid: string): boolean {
    const e = this.expected.get(id)
    if (!e || e.jid !== jid || Date.now() - e.at > EXPECT_TTL_MS) return false
    this.expected.delete(id)
    return true
  }

  private askApproval(p: PendingJoin): void {
    this.pending.set(p.id, p)
    this.emitViewers()
    let answered = false
    const allow = (ok: boolean) => {
      if (answered) return
      answered = true
      if (this.stopped || this.pending.get(p.id) !== p) return // expired, kicked, left or session over
      this.pending.delete(p.id)
      if (!ok) {
        this.denied.add(p.id)
        this.reject(p.id, p.jid, 'denied')
        this.emitViewers()
        return
      }
      this.approved.add(p.id)
      this.admit(p.id, p.jid, p.name, p.dec)
      this.emitViewers()
    }
    try {
      this.onJoinRequest({ id: p.id, name: p.name }, allow)
    } catch {
      /* UI error: request stays pending until it expires */
    }
  }

  private admit(id: string, jid: string, name: string, dec: CodecName[]): void {
    const direct = this.directCount()
    if (direct >= this.maxDirect || this.budgetExhausted(direct + 1)) {
      if (this.role === 'host') {
        const pick = this.pickRelay(id, jid)
        if (pick.relay) {
          const relay = pick.relay
          // Lock / approval passed: the viewer may come back through us if its relay drops later.
          this.admitted.add(id)
          // Vouch for it at the relay first (data channel: reaches the relay before the viewer's join does).
          this.sendCtl(relay, { t: 'expect', id, jid })
          relay.redirects.delete(id) // re-insert → Map order stays "oldest redirect first"
          relay.redirects.set(id, Date.now())
          this.markTried(id, relay.id, jid)
          this.send({ t: 'redirect', jid, relay: relay.id }, id)
          return
        }
        // A relay is free but this viewer just came back from it: let its join loop retry instead of a terminal
        // 'full' (it is offered that relay again once RELAY_TRIED_TTL_MS passed, or another one frees up).
        if (pick.wait) return
        // A direct slot is about to free up (peer dying / gone silent / offer never answered): same.
        if (this.slotFreeingSoon()) return
      }
      this.reject(id, jid, 'full')
      return
    }
    this.admitted.add(id)
    void this.createPeer(id, jid, name, dec)
  }

  /** The upload budget can only push the 2nd and later direct viewers to relays; peerMaxKbps caps the first. */
  private budgetExhausted(count: number): boolean {
    return this.uploadLimitKbps > 0 && count > 1 && this.uploadLimitKbps / count < MIN_PEER_KBPS
  }

  /** True if a counted direct slot will probably be freed within seconds (so a join should wait, not get 'full'). */
  private slotFreeingSoon(): boolean {
    const now = Date.now()
    for (const p of this.peers.values()) {
      if (p.closed) continue
      if (p.state === 'connected') {
        // Every connected viewer reports 'rx' once a second: silence or a non-connected transport = dying.
        const heard = p.rxAt || p.connectedAt || 0
        if (p.pc.connectionState !== 'connected' || now - heard > RELAY_RX_FRESH_MS) return true
      } else if (p.state === 'connecting' && !p.answerApplied && p.offerSentAt > 0 && now - p.offerSentAt > STALE_OFFER_MS) {
        return true // offer unanswered → removed at ANSWER_TIMEOUT_MS
      }
    }
    return false
  }

  private markTried(viewer: string, relay: string, jid: string): void {
    let m = this.relayTried.get(viewer)
    if (!m) {
      m = new Map()
      this.relayTried.set(viewer, m)
      while (this.relayTried.size > RELAY_TRIED_CAP) {
        const oldest = this.relayTried.keys().next().value
        if (oldest === undefined) break
        this.relayTried.delete(oldest)
      }
    }
    m.set(relay, { jid, at: Date.now() })
  }

  /**
   * Least loaded healthy relay for `viewer`. `wait` = none is usable right now, but one would be if the viewer had
   * not just come back from it (redirected there with an older jid) — never send it straight back.
   */
  private pickRelay(viewer: string, jid: string): { relay: Peer | null; wait: boolean } {
    const now = Date.now()
    const tried = this.relayTried.get(viewer)
    if (tried) {
      for (const [rid, t] of tried) if (now - t.at > RELAY_TRIED_TTL_MS) tried.delete(rid)
      if (tried.size === 0) this.relayTried.delete(viewer)
    }
    let best: Peer | null = null
    let bestLoad = Infinity
    let bestRtt = Infinity
    let wait = false
    for (const p of this.peers.values()) {
      if (p.id === viewer || p.state !== 'connected' || !p.rx || !p.rx.canRelay) continue
      // Never send viewers to a relay that is currently unreachable or went silent (crashed, network gone).
      if (p.pc.connectionState !== 'connected' || now - p.rxAt > RELAY_RX_FRESH_MS) continue
      if (p.tx && p.tx.connType === 'relay') continue
      // Redirects not yet reflected in rx.children (onCtl drops them as the reported count rises). One that ages
      // out without ever showing up is a miss; a relay with several recent misses fails or lies → skip it.
      for (const [vid, ts] of p.redirects) {
        if (now - ts <= REDIRECT_HOLD_MS) continue
        p.redirects.delete(vid)
        p.redirectMisses.push(now)
      }
      while (p.redirectMisses.length > 0 && now - p.redirectMisses[0] > RELAY_MISS_WINDOW_MS) p.redirectMisses.shift()
      if (p.redirectMisses.length >= MAX_RELAY_CHILDREN) continue
      let pending = 0
      for (const vid of p.redirects.keys()) if (vid !== viewer) pending++
      const load = p.rx.children + pending
      if (load >= MAX_RELAY_CHILDREN) continue
      const t = tried?.get(p.id)
      if (t && t.jid !== jid) {
        wait = true
        continue
      }
      const rtt = p.tx?.rttMs ?? 9999
      if (load < bestLoad || (load === bestLoad && rtt < bestRtt)) {
        best = p
        bestLoad = load
        bestRtt = rtt
      }
    }
    return { relay: best, wait: best === null && wait }
  }

  private async createPeer(id: string, jid: string, name: string, dec: CodecName[]): Promise<void> {
    // Relays cannot verify that an explicit AV1 / VP9 / VP8 choice encodes in hardware (they do not capture), so
    // they follow the 'auto' rule — H.264 unless AV1 hardware encode is proven on this machine.
    const pref = this.role === 'relay' && this.settings.codec !== 'H264' && !(this.settings.codec === 'AV1' && this.hw?.av1) ? 'auto' : this.settings.codec
    const codec = chooseCodec(pref, this.hw ?? FALLBACK_HW, dec)
    let pc: RTCPeerConnection
    try {
      const made = createPeerConnection(this.net)
      pc = made.pc
      if (made.iceConfigInvalid && !this.iceNoticeShown) {
        this.iceNoticeShown = true
        this.notice(ICE_CONFIG_NOTICE)
      }
    } catch {
      return // WebRTC unavailable; the viewer keeps retrying and times out
    }
    let dc: RTCDataChannel
    try {
      dc = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true })
    } catch {
      pc.close()
      return
    }
    const peer: Peer = {
      id,
      name,
      jid,
      sid: randomId(8),
      pc,
      dc,
      dcQueue: [],
      videoTr: null,
      audioTr: null,
      codec,
      state: 'connecting',
      createdAt: Date.now(),
      connectedAt: null,
      offerSdp: null,
      lan: false,
      h264Restore: {},
      offerSentAt: 0,
      localDescSent: false,
      answerApplied: false,
      remoteSet: false,
      pendingRemoteIce: [],
      lateLocalIce: [],
      iceOut: [],
      sampler: null,
      tx: null,
      rx: null,
      rxAt: 0,
      swCount: 0,
      maxKbps: 0,
      redirects: new Map(),
      redirectMisses: [],
      named: false,
      ctlTokens: CTL_BURST,
      ctlRefill: Date.now(),
      ctlDrops: 0,
      connectTimer: null,
      answerTimer: null,
      disconnectTimer: null,
      iceTimer: null,
      closed: false,
    }
    this.peers.set(id, peer)
    this.wirePeer(peer)
    try {
      peer.maxKbps = this.peerMaxKbps(peer, this.directCount())
      peer.videoTr = pc.addTransceiver(this.videoTrack ?? 'video', {
        direction: 'sendonly',
        streams: [this.videoStream],
        sendEncodings: [
          { maxBitrate: peer.maxKbps * 1000, maxFramerate: this.settings.fps, priority: 'high', networkPriority: 'high' },
        ],
      })
      // Always create the audio transceiver so audio can be added/removed later with replaceTrack.
      peer.audioTr = pc.addTransceiver(this.audioTrack ?? 'audio', { direction: 'sendonly', streams: [this.audioStream] })
      applyCodecPreferences(peer.videoTr, codec)
    } catch {
      this.removePeer(peer, 'error')
      return
    }
    this.emitViewers()
    this.rebalance()

    try {
      await pc.setLocalDescription()
      if (peer.closed) return
      await waitIceGathering(pc, GATHER_MS)
      if (peer.closed) return
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('no local description')
      // Everything gathered so far is inside this SDP; later candidates are trickled (half-trickle).
      // WebKit viewers get Chromium's GPU H.264 (High) labelled as Constrained High; the answer is mapped back.
      const relabel = this.webkitViewers.has(peer.id) ? asConstrainedHigh(sdp) : { sdp, restore: {} }
      peer.h264Restore = relabel.restore
      peer.offerSdp = relabel.sdp
      peer.localDescSent = true
      peer.offerSentAt = Date.now()
      this.sendOffer(peer)
      // Two-stage timeout: an offer nobody answers (left, or a fake join) frees its slot quickly; ICE gets longer.
      peer.answerTimer = setTimeout(() => {
        peer.answerTimer = null
        if (!peer.closed && !peer.answerApplied && peer.state !== 'connected') this.removePeer(peer, 'timeout')
      }, ANSWER_TIMEOUT_MS)
      peer.connectTimer = setTimeout(() => {
        peer.connectTimer = null
        if (!peer.closed && peer.state !== 'connected') this.removePeer(peer, 'timeout')
      }, CONNECT_TIMEOUT_MS)
    } catch {
      if (!peer.closed) this.removePeer(peer, 'error')
    }
  }

  private wirePeer(peer: Peer): void {
    const { pc, dc } = peer
    pc.onicecandidate = (e) => {
      if (peer.closed || !peer.localDescSent || !e.candidate || !e.candidate.candidate) return
      const c = e.candidate.toJSON()
      if (peer.lateLocalIce.length < MAX_LATE_ICE) peer.lateLocalIce.push(c)
      peer.iceOut.push(c)
      if (!peer.iceTimer) peer.iceTimer = setTimeout(() => this.flushIce(peer), ICE_BATCH_MS)
    }
    pc.onconnectionstatechange = () => this.onConnState(peer)
    dc.onopen = () => {
      if (peer.closed) return
      this.sendCtl(peer, this.infoFor(peer))
      if (this.paused) this.sendCtl(peer, { t: 'paused', paused: true })
      const queued = peer.dcQueue.splice(0)
      for (const q of queued) {
        if (q.t === 'info' || q.t === 'paused') continue // state messages were just sent fresh
        try { dc.send(q.data) } catch { /* ignore */ }
      }
    }
    dc.onmessage = (e) => this.onCtl(peer, e.data)
    dc.onclose = () => {
      // The viewer closed its connection (left without bye or crashed): free the slot right away.
      if (!peer.closed && peer.state === 'connected') this.removePeer(peer, 'closed')
    }
  }

  private flushIce(peer: Peer): void {
    peer.iceTimer = null
    if (peer.closed || peer.iceOut.length === 0) return
    this.send({ t: 'ice', sid: peer.sid, c: peer.iceOut.splice(0) }, peer.id)
  }

  private sendOffer(peer: Peer): void {
    if (!peer.offerSdp) return
    this.send({ t: 'offer', jid: peer.jid, sid: peer.sid, sdp: peer.offerSdp, hostName: this.displayName() }, peer.id)
  }

  /** Duplicate join for an existing attempt: re-send the cached offer if the viewer apparently missed it. */
  private maybeResendOffer(peer: Peer): void {
    if (peer.closed || peer.state === 'connected' || !peer.localDescSent || peer.answerApplied) return
    const now = Date.now()
    if (now - peer.offerSentAt <= OFFER_RESEND_MS) return
    peer.offerSentAt = now
    this.sendOffer(peer)
    if (peer.lateLocalIce.length > 0) this.send({ t: 'ice', sid: peer.sid, c: peer.lateLocalIce.slice() }, peer.id)
  }

  private async onAnswer(peer: Peer, sdp: unknown): Promise<void> {
    if (peer.closed || peer.answerApplied || !peer.localDescSent) return
    if (peer.pc.signalingState !== 'have-local-offer') return
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > 60_000) return
    peer.answerApplied = true // blocks duplicates while the async apply runs
    const answer = Object.keys(peer.h264Restore).length > 0 ? restoreH264Profiles(sdp, peer.h264Restore) : sdp
    let munged = answer
    try {
      // Same LAN: start at the full rate and do not let the estimate drift down (steady picture, like Parsec).
      const lan = !!peer.offerSdp && sameNetwork(peer.offerSdp, answer)
      peer.lan = lan
      peer.maxKbps = this.peerMaxKbps(peer, this.directCount())
      // Fixed rate also when the user set the bitrate by hand: the engine may not wander below it.
      const fixed = lan || this.settings.bitrateKbps > 0
      munged = mungeAnswer(answer, fixed
        ? { startKbps: peer.maxKbps, minKbps: Math.round(peer.maxKbps * 0.9), audioKbps: AUDIO_KBPS }
        : { startKbps: startBitrateKbps(peer.maxKbps), audioKbps: AUDIO_KBPS })
    } catch {
      munged = answer
    }
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: munged })
    } catch {
      if (peer.closed) return
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: answer })
      } catch {
        if (!peer.closed) this.removePeer(peer, 'error')
        return
      }
    }
    if (peer.closed) return
    peer.remoteSet = true
    if (peer.answerTimer) clearTimeout(peer.answerTimer)
    peer.answerTimer = null
    const negotiated = negotiatedVideoCodec(answer)
    if (negotiated) peer.codec = negotiated
    for (const c of peer.pendingRemoteIce.splice(0)) peer.pc.addIceCandidate(c).catch(() => {})
    peer.maxKbps = this.peerMaxKbps(peer, this.directCount())
    this.applyParams(peer)
    this.emitViewers()
  }

  private onRemoteIce(peer: Peer, raw: unknown): void {
    if (peer.closed) return
    for (const c of parseCandidates(raw)) {
      if (peer.remoteSet) peer.pc.addIceCandidate(c).catch(() => {})
      else if (peer.pendingRemoteIce.length < MAX_PENDING_ICE) peer.pendingRemoteIce.push(c)
    }
  }

  private onConnState(peer: Peer): void {
    if (peer.closed) return
    const s = peer.pc.connectionState
    if (s === 'connected') {
      if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer)
        peer.disconnectTimer = null
      }
      if (peer.state !== 'connected') {
        peer.state = 'connected'
        peer.connectedAt = Date.now()
        if (peer.connectTimer) {
          clearTimeout(peer.connectTimer)
          peer.connectTimer = null
        }
        this.admitted.add(peer.id)
        this.relayTried.delete(peer.id)
        peer.sampler = new StatsSampler(peer.pc)
        this.emitViewers()
      }
    } else if (s === 'disconnected') {
      if (!peer.disconnectTimer) {
        peer.disconnectTimer = setTimeout(() => {
          peer.disconnectTimer = null
          if (!peer.closed && peer.pc.connectionState !== 'connected') this.removePeer(peer, 'disconnected')
        }, DISCONNECT_GRACE_MS)
      }
    } else if (s === 'failed') {
      this.removePeer(peer, 'failed')
    }
  }

  // ───────────────────────── data channel ─────────────────────────

  private onCtl(peer: Peer, data: unknown): void {
    if (peer.closed) return
    if (!this.takeCtlToken(peer)) {
      // A connected viewer flooding the channel: drop the excess, disconnect it if it keeps going.
      if (++peer.ctlDrops > CTL_ABUSE_DROPS) this.removePeer(peer, 'error')
      return
    }
    const msg = parseCtl(data)
    if (!msg) return
    if (msg.t === 'hello') {
      if (peer.named) return // once per connection
      peer.named = true
      const name = sanitizeName(msg.name)
      if (name !== peer.name) {
        peer.name = name
        this.emitViewers()
      }
    } else if (msg.t === 'rx') {
      // Redirected viewers that now show up as children are no longer pending (oldest redirects first).
      let grown = msg.children - (peer.rx?.children ?? 0)
      if (grown > 0) {
        for (const vid of [...peer.redirects.keys()]) {
          if (grown-- <= 0) break
          peer.redirects.delete(vid)
        }
      }
      peer.rx = msg
      peer.rxAt = Date.now()
    } else if (msg.t === 'bye') {
      // The viewer leaves (authenticated: it came over this peer's own data channel).
      this.removePeer(peer, 'bye')
    }
  }

  private takeCtlToken(peer: Peer): boolean {
    const now = Date.now()
    peer.ctlTokens = Math.min(CTL_BURST, peer.ctlTokens + ((now - peer.ctlRefill) * CTL_RATE_PER_SEC) / 1000)
    peer.ctlRefill = now
    if (peer.ctlTokens < 1) return false
    peer.ctlTokens -= 1
    return true
  }

  private sendCtl(peer: Peer, msg: CtlMessage): void {
    if (peer.closed) return
    const dc = peer.dc
    const data = JSON.stringify(msg)
    if (dc.readyState === 'open') {
      try { dc.send(data) } catch { /* ignore */ }
      return
    }
    if (dc.readyState !== 'connecting') return
    if (msg.t === 'tx') return // stale by the time the channel opens
    if (msg.t === 'info' || msg.t === 'paused') {
      const idx = peer.dcQueue.findIndex((q) => q.t === msg.t)
      if (idx >= 0) peer.dcQueue.splice(idx, 1)
    }
    if (peer.dcQueue.length < MAX_DC_QUEUE) peer.dcQueue.push({ t: msg.t, data })
  }

  private infoFor(peer: Peer): CtlMessage {
    return {
      t: 'info',
      hostName: this.displayName(),
      settings: { ...this.settings },
      viewers: this.viewerCount(),
      codec: peer.codec,
      hops: this.role === 'relay' ? this.hops + 1 : 1,
    }
  }

  private broadcastInfo(): void {
    this.lastInfoViewers = this.viewerCount()
    for (const p of this.peers.values()) this.sendCtl(p, this.infoFor(p))
  }

  // ───────────────────────── stats / periodic ─────────────────────────

  private async statsTick(): Promise<void> {
    if (this.statsBusy || this.stopped) return
    this.statsBusy = true
    try {
      let changed = this.expirePending()
      const live = [...this.peers.values()].filter((p) => p.state === 'connected' && p.sampler)
      if (live.length > 0) {
        const results = await Promise.all(live.map((p) => (p.sampler as StatsSampler).outbound().catch(() => null)))
        if (this.stopped) return
        const upstream = this.upstreamMs()
        live.forEach((p, i) => {
          const tx = results[i]
          if (p.closed || !tx) return
          p.tx = tx
          if (tx.hw === false) {
            p.swCount++
            if (p.swCount >= 2 && !this.swNoticeShown) {
              this.swNoticeShown = true
              this.notice(SW_NOTICE)
            }
          } else if (tx.hw === true) {
            p.swCount = 0
          }
          this.sendCtl(p, { t: 'tx', encodeMs: tx.encodeMs, encoder: tx.encoder, hw: tx.hw, kbps: tx.bitrateKbps, upstreamLatencyMs: upstream, lim: limOf(tx.qualityLimitation), fps: Math.round(tx.fps) })
        })
        changed = true
      }
      if (this.viewerCount() !== this.lastInfoViewers) this.broadcastInfo()
      if (changed) this.emitViewers()
    } finally {
      this.statsBusy = false
    }
  }

  private expirePending(): boolean {
    const now = Date.now()
    let changed = false
    for (const [id, p] of this.pending) {
      if (now - p.lastJoinAt > PENDING_EXPIRE_MS) {
        this.pending.delete(id)
        changed = true
      }
    }
    return changed
  }

  // ───────────────────────── bitrate / params ─────────────────────────

  private captureSize(): { w: number; h: number; fps: number } {
    let s: MediaTrackSettings = {}
    try { s = this.videoTrack?.getSettings() ?? {} } catch { /* ignore */ }
    const trackFps = typeof s.frameRate === 'number' && s.frameRate > 0 ? s.frameRate : 0
    let w = typeof s.width === 'number' ? s.width : 0
    let h = typeof s.height === 'number' ? s.height : 0
    // Remote tracks (relay role) may not report a size: use the received frame size instead.
    if ((!(w > 0) || !(h > 0)) && this.sourceHint) {
      w = this.sourceHint.w
      h = this.sourceHint.h
    }
    return { w, h, fps: trackFps > 0 ? Math.min(this.settings.fps, trackFps) : this.settings.fps }
  }

  private peerMaxKbps(peer: Peer, directCount: number): number {
    const { w, h, fps } = this.captureSize()
    let kbps = effectiveBitrateKbps(this.settings, peer.codec, w, h, fps, peer.lan)
    if (this.uploadLimitKbps > 0 && directCount > 0) kbps = Math.min(kbps, Math.floor(this.uploadLimitKbps / directCount))
    return Math.max(300, Math.round(kbps))
  }

  /** setParameters for both senders — only after the answer is applied (serialized per sender in tuning.ts). */
  private applyParams(peer: Peer): void {
    if (peer.closed || !peer.remoteSet) return
    if (peer.videoTr) {
      void applySenderParams(peer.videoTr.sender, { maxKbps: peer.maxKbps, fps: this.settings.fps, content: this.settings.content, kind: 'video' })
    }
    if (peer.audioTr) {
      void applySenderParams(peer.audioTr.sender, { maxKbps: AUDIO_KBPS, fps: 0, content: this.settings.content, kind: 'audio' })
    }
  }

  private reapplyAll(): void {
    const direct = this.directCount()
    for (const p of this.peers.values()) {
      p.maxKbps = this.peerMaxKbps(p, direct)
      this.applyParams(p)
    }
  }

  /** Upload budget: per-viewer max depends on the number of direct viewers. */
  private rebalance(): void {
    if (this.uploadLimitKbps <= 0 || this.stopped) return
    const direct = this.directCount()
    for (const p of this.peers.values()) {
      const kbps = this.peerMaxKbps(p, direct)
      if (kbps === p.maxKbps) continue
      p.maxKbps = kbps
      this.applyParams(p)
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  private takeTracks(stream: MediaStream): void {
    this.videoTrack = stream.getVideoTracks()[0] ?? null
    this.audioTrack = stream.getAudioTracks()[0] ?? null
    if (this.videoTrack) {
      try { this.videoTrack.contentHint = contentHintFor(this.settings.content) } catch { /* ignore */ }
    }
    // Root: the audio toggle mutes the capture track. Relays never touch the received track (it is also played locally).
    if (this.role === 'host' && this.audioTrack) this.audioTrack.enabled = this.settings.audio
  }

  /** Own display name changed in the tunnel: used for every offer / redirect sent from now on. */
  setName(name: string): void {
    this.hostName = name
  }

  private displayName(): string {
    return this.role === 'relay' ? this.originName || this.hostName : this.hostName
  }

  private upstreamMs(): number {
    if (!this.upstreamLatency) return 0
    try {
      const v = this.upstreamLatency()
      return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
    } catch {
      return 0
    }
  }

  private directCount(): number {
    let n = 0
    for (const p of this.peers.values()) if (!p.closed && (p.state === 'connecting' || p.state === 'connected')) n++
    return n
  }

  private totalViewers(): number {
    return this.connectedCount() + this.relayedCount()
  }

  /** Audience shown to viewers: root = everyone; relay = the upstream's total (it includes our subtree, maybe late). */
  private viewerCount(): number {
    return this.role === 'relay' ? Math.max(this.upstreamViewers, this.totalViewers()) : this.totalViewers()
  }

  private peerBySid(from: string, sid: unknown): Peer | null {
    if (typeof sid !== 'string') return null
    const p = this.peers.get(from)
    return p && !p.closed && p.sid === sid ? p : null
  }

  private reject(to: string, jid: string, reason: RejectReason): void {
    // Refusals to a flood of (fake) ids must not crowd out offers / ICE: global budget, silent beyond it — real
    // viewers re-send their join every 2 s anyway. Kicks always go out.
    if (reason !== 'kicked') {
      const now = Date.now()
      this.rejectTokens = Math.min(REJECT_BURST, this.rejectTokens + ((now - this.rejectRefill) * REJECT_RATE_PER_SEC) / 1000)
      this.rejectRefill = now
      if (this.rejectTokens < 1) return
      this.rejectTokens -= 1
    }
    this.send({ t: 'reject', jid, reason }, to)
  }

  private rememberDead(id: string, jid: string): void {
    const key = `${id}|${jid}`
    this.deadJids.delete(key)
    this.deadJids.set(key, Date.now())
    while (this.deadJids.size > DEAD_JID_CAP) {
      const oldest = this.deadJids.keys().next().value
      if (oldest === undefined) break
      this.deadJids.delete(oldest)
    }
  }

  private removePeer(peer: Peer, reason: string, closeDelayMs = 0): void {
    if (peer.closed) return
    peer.closed = true
    peer.state = 'failed'
    if (peer.connectTimer) clearTimeout(peer.connectTimer)
    if (peer.answerTimer) clearTimeout(peer.answerTimer)
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer)
    if (peer.iceTimer) clearTimeout(peer.iceTimer)
    peer.connectTimer = peer.answerTimer = peer.disconnectTimer = peer.iceTimer = null
    peer.dcQueue.length = 0
    peer.pendingRemoteIce.length = 0
    if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id)
    // The viewer already moved past this attempt (it had our offer) → ignore late joins with this jid.
    if (peer.answerApplied || reason === 'bye' || reason === 'kicked') this.rememberDead(peer.id, peer.jid)
    this.detachPeer(peer)
    this.closeLater(peer.pc, closeDelayMs)
    this.emitViewers()
    this.rebalance()
  }

  private detachPeer(peer: Peer): void {
    const { pc, dc } = peer
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    dc.onopen = null
    dc.onmessage = null
    dc.onclose = null
  }

  private closeLater(pc: RTCPeerConnection, delayMs: number): void {
    if (delayMs <= 0) {
      try { pc.close() } catch { /* ignore */ }
      return
    }
    this.lingering.add(pc)
    const timer = setTimeout(() => {
      this.lingerTimers.delete(timer)
      this.lingering.delete(pc)
      try { pc.close() } catch { /* ignore */ }
    }, delayMs)
    this.lingerTimers.add(timer)
  }

  private shutdown(sayBye: boolean): void {
    if (this.stopped) return
    this.stopped = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    // Root: tell the whole tunnel that this stream ended (sid-less bye on the broadcast topic).
    if (sayBye && this.role === 'host' && this.started) this.send({ t: 'bye', seq: nextSeq() })
    const peers = [...this.peers.values()]
    this.peers.clear()
    this.pending.clear()
    // Kicked peers that are still lingering: close now.
    for (const t of this.lingerTimers) clearTimeout(t)
    this.lingerTimers.clear()
    for (const pc of this.lingering) {
      try { pc.close() } catch { /* ignore */ }
    }
    this.lingering.clear()
    const toClose: RTCPeerConnection[] = []
    for (const p of peers) {
      if (sayBye && p.dc.readyState === 'open') {
        try { p.dc.send(JSON.stringify({ t: 'bye' } satisfies CtlMessage)) } catch { /* ignore */ }
      }
      p.closed = true
      if (p.connectTimer) clearTimeout(p.connectTimer)
      if (p.answerTimer) clearTimeout(p.answerTimer)
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer)
      if (p.iceTimer) clearTimeout(p.iceTimer)
      p.connectTimer = p.answerTimer = p.disconnectTimer = p.iceTimer = null
      this.detachPeer(p)
      toClose.push(p.pc)
    }
    if (sayBye && toClose.length > 0) {
      // Give the ctl 'bye' a moment to leave the SCTP queue before tearing the transports down.
      setTimeout(() => {
        for (const pc of toClose) {
          try { pc.close() } catch { /* ignore */ }
        }
      }, STOP_CLOSE_MS)
    } else {
      for (const pc of toClose) {
        try { pc.close() } catch { /* ignore */ }
      }
    }
    this.expected.clear()
    this.relayTried.clear()
    this.emitViewersNow()
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.opChain.then(fn).catch(() => {})
    this.opChain = next
    return next
  }

  /** room.send that can never throw into a handler (room may already be closed). */
  private send(body: SignalBody, to?: string): void {
    try {
      this.room.send(body, to)
    } catch {
      /* signaling unavailable — retries/timeouts take care of it */
    }
  }

  /** Coalesced: bursts (join floods, ctl spam, many peers changing at once) cause at most ~10 UI renders/s. */
  private emitViewers(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, EMIT_MIN_INTERVAL_MS - (Date.now() - this.lastEmitAt))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitViewersNow()
    }, wait)
  }

  private emitViewersNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.lastEmitAt = Date.now()
    try {
      this.onViewersChanged(this.viewers())
    } catch {
      /* UI error must not break the session */
    }
  }

  private notice(message: string): void {
    try {
      this.onNotice(message)
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────── wire validation (shared with viewer.ts) ─────────────────────────

export function isCodecName(v: unknown): v is CodecName {
  return v === 'AV1' || v === 'H264' || v === 'VP9' || v === 'VP8'
}

/** Display name from untrusted input: no control characters, max 40 chars, never empty. */
export function sanitizeName(v: unknown): string {
  if (typeof v !== 'string') return 'Gast'
  const s = v.replace(/\p{Cc}/gu, '').trim().slice(0, 40)
  return s || 'Gast'
}

/** Validates a trickle batch from the wire; drops malformed and end-of-candidates entries. */
export function parseCandidates(raw: unknown): RTCIceCandidateInit[] {
  if (!Array.isArray(raw)) return []
  const out: RTCIceCandidateInit[] = []
  for (const c of raw.slice(0, 64)) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    if (typeof r.candidate !== 'string' || r.candidate.length === 0 || r.candidate.length > 2048) continue
    const init: RTCIceCandidateInit = { candidate: r.candidate }
    if (typeof r.sdpMid === 'string') init.sdpMid = r.sdpMid
    if (typeof r.sdpMLineIndex === 'number' && Number.isInteger(r.sdpMLineIndex) && r.sdpMLineIndex >= 0) init.sdpMLineIndex = r.sdpMLineIndex
    if (typeof r.usernameFragment === 'string') init.usernameFragment = r.usernameFragment
    if (init.sdpMid === undefined && init.sdpMLineIndex === undefined) init.sdpMLineIndex = 0 // max-bundle: one transport
    out.push(init)
  }
  return out
}

/** Peer ids / jids on the wire (same rule as the room's peer ids). */
const WIRE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Upper bound for viewer counts received from upstream (display only). */
const MAX_VIEWERS_SHOWN = 10_000

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOr = (v: unknown, d: number): number => (isNum(v) ? v : d)
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)

function parseSettings(v: unknown): StreamSettings | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  const resolution = r.resolution === 'native' || r.resolution === 2160 || r.resolution === 1440 || r.resolution === 1080 || r.resolution === 720 ? r.resolution : d.resolution
  const fps = r.fps === 30 || r.fps === 60 || r.fps === 120 ? r.fps : d.fps
  const codec = r.codec === 'auto' || isCodecName(r.codec) ? r.codec : d.codec
  const content = r.content === 'motion' || r.content === 'balanced' || r.content === 'detail' ? r.content : d.content
  return {
    resolution,
    fps,
    bitrateKbps: Math.max(0, Math.min(200_000, numOr(r.bitrateKbps, 0))),
    codec,
    content,
    audio: typeof r.audio === 'boolean' ? r.audio : d.audio,
  }
}

/** Parses + validates one data-channel message. Returns null for anything malformed or unknown. */
/** Why the sender's encoder holds back (getStats qualityLimitationReason), for the watcher's stats panel. */
function limOf(reason: string): 'cpu' | 'bandwidth' | 'other' | 'none' {
  return reason === 'cpu' || reason === 'bandwidth' || reason === 'other' ? reason : 'none'
}

export function parseCtl(data: unknown): CtlMessage | null {
  if (typeof data !== 'string' || data.length > 16_384) return null
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  switch (r.t) {
    case 'info': {
      const settings = parseSettings(r.settings)
      if (!settings) return null
      return {
        t: 'info',
        hostName: sanitizeName(r.hostName),
        settings,
        viewers: Math.min(MAX_VIEWERS_SHOWN, Math.max(0, Math.round(numOr(r.viewers, 0)))),
        codec: isCodecName(r.codec) ? r.codec : 'H264',
        hops: Math.max(1, Math.round(numOr(r.hops, 1))),
      }
    }
    case 'tx':
      return {
        t: 'tx',
        encodeMs: numOrNull(r.encodeMs),
        encoder: typeof r.encoder === 'string' ? r.encoder.slice(0, 200) : '',
        hw: typeof r.hw === 'boolean' ? r.hw : null,
        kbps: Math.max(0, numOr(r.kbps, 0)),
        upstreamLatencyMs: Math.max(0, numOr(r.upstreamLatencyMs, 0)),
        ...(r.lim === 'cpu' || r.lim === 'bandwidth' || r.lim === 'other' || r.lim === 'none' ? { lim: r.lim } : {}),
        ...(typeof r.fps === 'number' && Number.isFinite(r.fps) ? { fps: Math.max(0, Math.min(500, Math.round(r.fps))) } : {}),
      }
    case 'paused':
      return typeof r.paused === 'boolean' ? { t: 'paused', paused: r.paused } : null
    case 'kick':
      return { t: 'kick' }
    case 'bye':
      return { t: 'bye' }
    case 'hello':
      return { t: 'hello', name: sanitizeName(r.name) }
    case 'expect':
      return typeof r.id === 'string' && WIRE_ID_RE.test(r.id) && typeof r.jid === 'string' && WIRE_ID_RE.test(r.jid)
        ? { t: 'expect', id: r.id, jid: r.jid }
        : null
    case 'rx':
      return {
        t: 'rx',
        fps: Math.max(0, numOr(r.fps, 0)),
        latencyMs: numOrNull(r.latencyMs),
        lossPct: Math.max(0, Math.min(100, numOr(r.lossPct, 0))),
        width: Math.max(0, Math.round(numOr(r.width, 0))),
        height: Math.max(0, Math.round(numOr(r.height, 0))),
        // Honest values never exceed MAX_RELAY_CHILDREN: only hop-1 watchers relay and a relay takes at most 3.
        children: Math.min(MAX_RELAY_CHILDREN, Math.max(0, Math.round(numOr(r.children, 0)))),
        descendants: Math.min(MAX_RELAY_CHILDREN, Math.max(0, Math.round(numOr(r.descendants, 0)))),
        canRelay: r.canRelay === true,
      }
    default:
      return null
  }
}

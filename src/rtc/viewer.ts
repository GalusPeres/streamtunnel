// ViewerSession: watches one tunnel member's stream ("origin"). Join loop, offer/answer (the watcher never offers),
// reconnect logic, stats + rx reporting and an optional embedded relay HostSession that re-shares the received
// stream to children (shared room).
//
// Signal ownership: never touches room.onSignal — the TunnelSession routes messages through handleSignal() and
// tells us about the origin's presence (nudge) and disappearance (originGone).
import type {
  CodecName,
  ConnType,
  CtlMessage,
  HostInfo,
  InboundStats,
  ISignalingRoom,
  IViewerSession,
  LatencyMode,
  NetConfig,
  RejectReason,
  SignalBody,
  ViewerSessionOptions,
  ViewerState,
} from '../types.ts'
import { randomId } from '../core/crypto.ts'
import { hardwareDecoders } from './codecs.ts'
import { HostSession, MAX_RELAY_CHILDREN, parseCandidates, parseCtl, sanitizeName } from './host.ts'
import { StatsSampler } from './stats.ts'
import { createPeerConnection, tuneReceiver, waitIceGathering } from './tuning.ts'

const JOIN_INTERVAL_MS = 2000
const NUDGE_THROTTLE_MS = 500
const REDIRECT_TIMEOUT_MS = 8000
const CONNECT_TIMEOUT_MS = 20_000
const DISCONNECT_GRACE_MS = 5000
const MAX_FAILED_ATTEMPTS = 4
const STATS_MS = 1000
const GATHER_MS = 800
const ICE_BATCH_MS = 300
const ANSWER_RESEND_MS = 2500
const MAX_EARLY_ICE_SIDS = 4
const MAX_BUFFERED_ICE = 128
const MAX_LATE_ICE = 64
const RELAY_MAX_CHILDREN = MAX_RELAY_CHILDREN

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>
type Terminal = 'ended' | 'kicked' | 'rejected' | 'failed'
type TxMessage = Extract<CtlMessage, { t: 'tx' }>

/** One connection attempt to an upstream (origin or relay), identified by the upstream's sid. */
interface Link {
  sid: string
  jid: string
  /** upstream peer id (sender of the offer) */
  from: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  dcQueue: string[]
  answerSdp: string | null
  answerSent: boolean
  remoteSet: boolean
  pendingIce: RTCIceCandidateInit[]
  lateLocalIce: RTCIceCandidateInit[]
  iceOut: RTCIceCandidateInit[]
  iceTimer: Timer | null
  answerTimer: Interval | null
  connectTimer: Timer | null
  disconnectTimer: Timer | null
  everConnected: boolean
  sampler: StatsSampler | null
  videoTrack: MediaStreamTrack | null
  audioTrack: MediaStreamTrack | null
  videoReceiver: RTCRtpReceiver | null
  audioReceiver: RTCRtpReceiver | null
  closed: boolean
}

export class ViewerSession implements IViewerSession {
  onState: (state: ViewerState, detail?: string) => void = () => {}
  onVideo: (stream: MediaStream) => void = () => {}
  onAudio: (stream: MediaStream) => void = () => {}
  onHostInfo: (info: HostInfo) => void = () => {}
  /** sender-side info of the link we receive from (ctl 'tx', every ~2 s while connected) */
  onHostTx: (tx: TxMessage) => void = () => {}
  onStats: (stats: InboundStats) => void = () => {}
  /** member id whose stream this session watches */
  readonly origin: string

  private readonly room: ISignalingRoom
  private readonly name: string
  private readonly net: NetConfig
  private readonly allowRelay: boolean
  /** display name of the origin as the tunnel knows it (fallback until the offer / info carries one) */
  private readonly originName: string
  private latencyMode: LatencyMode

  private st: ViewerState = 'waiting'
  private stDetail: string | undefined
  /** start() called and no terminal state reached */
  private running = false
  /** stop() called — the session is dead for good */
  private disposed = false
  private startGen = 0
  private dec: CodecName[] | null = null

  /** current join attempt id (stable across join re-sends) */
  private jid = ''
  /** relay id after a redirect; null = talk to the origin */
  private target: string | null = null
  private link: Link | null = null
  private failures = 0
  private joinTimer: Interval | null = null
  private redirectTimer: Timer | null = null
  private statsTimer: Interval | null = null
  private statsBusy = false
  private lastJoinAt = 0
  /** trickle candidates that arrived before their offer, per sid */
  private readonly earlyIce = new Map<string, { from: string; c: RTCIceCandidateInit[] }>()

  private hostInfo: HostInfo | null = null
  private hostEncodeMs: number | null = null
  private upstreamLatencyMs = 0
  private lastLatency: number | null = null
  private lastConnType: ConnType = 'unknown'

  private relay: HostSession | null = null
  private relaySettingsKey = ''
  private relayLinkSid: string | null = null

  /** `originName` is an optional extra (not part of ViewerSessionOptions) the TunnelSession passes. */
  constructor(opts: ViewerSessionOptions & { originName?: string }) {
    if (typeof opts.origin !== 'string' || !opts.origin) throw new TypeError('ViewerSession: origin required')
    this.origin = opts.origin
    this.room = opts.room
    this.name = opts.name
    this.net = opts.net
    this.allowRelay = opts.allowRelay !== false
    this.latencyMode = opts.latencyMode ?? 'lowest'
    this.originName = typeof opts.originName === 'string' ? opts.originName.slice(0, 40) : ''
  }

  // ───────────────────────── public API ─────────────────────────

  /** Starts (or, after failed/rejected/kicked, restarts) joining the origin. No-op after stop(). */
  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.failures = 0
    this.jid = '' // no joins until the decoder probe resolved and beginAttempt() created a fresh jid
    this.target = null
    this.hostInfo = null
    this.setState('waiting', undefined, true)
    const gen = ++this.startGen
    hardwareDecoders()
      .catch((): CodecName[] => [])
      .then((dec) => {
        if (this.disposed || !this.running || gen !== this.startGen) return
        this.dec = dec
        this.beginAttempt()
      })
  }

  state(): ViewerState {
    return this.st
  }

  setLatencyMode(mode: LatencyMode): void {
    this.latencyMode = mode
    const link = this.link
    if (!link || link.closed) return
    if (link.videoReceiver) tuneReceiver(link.videoReceiver, mode)
    if (link.audioReceiver) tuneReceiver(link.audioReceiver, mode)
  }

  relayChildren(): number {
    return this.relay ? this.relay.connectedCount() : 0
  }

  /**
   * Not part of IViewerSession: true while we receive directly from the origin over a connected link. The tunnel
   * does not expire the origin's membership meanwhile (the media link proves it is alive even if its signaling
   * is temporarily unreachable).
   */
  upstreamAlive(): boolean {
    const link = this.link
    return !!link && !link.closed && link.everConnected && link.from === this.origin && link.pc.connectionState === 'connected'
  }

  /** The origin announced itself (presence) — if we wait for an offer, send the join now instead of on the next tick. */
  nudge(): void {
    if (!this.running || this.link || this.target !== null || this.dec === null || !this.jid) return
    if (Date.now() - this.lastJoinAt < NUDGE_THROTTLE_MS) return
    this.sendJoin()
  }

  /** The origin stopped sharing or left the tunnel → 'ended' (our relay children end too). */
  originGone(): void {
    this.finish('ended')
  }

  stop(): void {
    if (this.disposed) return
    this.disposed = true
    const wasRunning = this.running
    this.running = false
    this.startGen++
    const link = this.link
    if (link && !link.closed) {
      // Authenticated goodbye over the data channel (the sender ignores signaling byes for live connections) …
      this.sendCtl(link, { t: 'bye' })
      // … plus the signaling one for a connection that is still being set up.
      this.send({ t: 'bye', sid: link.sid }, link.from)
    } else if (wasRunning && this.jid) {
      // Still waiting (approval / offer in flight): let the sender drop our pending request or half-open peer now.
      this.send({ t: 'bye' }, this.target ?? this.origin)
    }
    this.clearJoinTimers()
    this.stopStats()
    // Children reconnect through the origin; the stream itself did not end.
    this.dropRelay('release')
    if (link) this.closeLink(link)
    this.earlyIce.clear()
  }

  /**
   * Routes one signaling message (incl. those for our embedded relay's children). Returns true if consumed.
   * Joins we do not relay for are NOT consumed — the tunnel answers them.
   */
  handleSignal(from: string, body: SignalBody): boolean {
    if (this.disposed || !body || typeof body !== 'object') return false
    // Messages for our relay's children (join for our origin / answer / ice / bye with their sid) go to the relay.
    if (this.relay && this.relay.handleSignal(from, body)) return true
    switch (body.t) {
      case 'offer':
        return this.onOffer(from, body)
      case 'ice':
        return this.onIce(from, body)
      case 'redirect':
        return this.onRedirect(from, body)
      case 'reject':
        return this.onReject(from, body)
      default:
        return false
    }
  }

  // ───────────────────────── signaling ─────────────────────────

  /** The peer we currently talk to: the relay after a redirect, else the origin. */
  private upstreamId(): string {
    return this.target ?? this.origin
  }

  /** New attempt to the origin with a fresh jid. */
  private beginAttempt(): void {
    this.clearJoinTimers()
    this.earlyIce.clear()
    this.jid = randomId(8)
    this.target = null
    this.sendJoin()
    this.joinTimer = setInterval(() => this.sendJoin(), JOIN_INTERVAL_MS)
  }

  private sendJoin(): void {
    if (!this.running || this.dec === null || this.link || !this.jid) return
    this.lastJoinAt = Date.now()
    this.send({ t: 'join', jid: this.jid, origin: this.origin, name: this.name, dec: this.dec, relay: this.allowRelay }, this.upstreamId())
  }

  private onRedirect(from: string, b: Extract<SignalBody, { t: 'redirect' }>): boolean {
    if (from !== this.origin) return false // only the origin redirects
    if (!this.running || this.link) return true
    if (typeof b.jid !== 'string' || typeof b.relay !== 'string' || !b.relay) return true
    if (b.jid !== this.jid || this.target !== null) return true // stale, or already following an earlier redirect
    if (b.relay === this.room.selfId || b.relay === from) return true
    this.target = b.relay
    const jid = this.jid
    const relayId = b.relay
    if (this.joinTimer) clearInterval(this.joinTimer)
    this.sendJoin()
    this.joinTimer = setInterval(() => this.sendJoin(), JOIN_INTERVAL_MS)
    if (this.redirectTimer) clearTimeout(this.redirectTimer)
    this.redirectTimer = setTimeout(() => {
      this.redirectTimer = null
      if (!this.running || this.link || this.jid !== jid || this.target !== relayId) return
      this.attemptFailed() // relay never answered → back to the origin
    }, REDIRECT_TIMEOUT_MS)
    return true
  }

  private onReject(from: string, b: Extract<SignalBody, { t: 'reject' }>): boolean {
    if (typeof b.jid !== 'string' || b.jid !== this.jid) return false
    // Only the peer we currently ask may refuse us (a late answer from the origin after a redirect is ignored).
    if (from !== this.upstreamId()) return from === this.origin
    if (!this.running) return true
    const reason: RejectReason | null =
      b.reason === 'full' || b.reason === 'locked' || b.reason === 'kicked' || b.reason === 'denied' ? b.reason : null
    if (!reason) return true
    // Once a link exists only its authenticated data channel (ctl 'kick' / 'bye') can end it.
    if (this.link) return true
    if (reason === 'kicked') {
      this.finish('kicked', 'kicked')
      return true
    }
    if (this.target !== null && reason === 'full') {
      this.attemptFailed() // relay is full → try the origin again
      return true
    }
    this.finish('rejected', reason)
    return true
  }

  private onIce(from: string, b: Extract<SignalBody, { t: 'ice' }>): boolean {
    if (typeof b.sid !== 'string' || !b.sid || b.sid.length > 64) return false
    const link = this.link
    if (link && link.sid === b.sid) {
      if (from !== link.from || link.closed) return false
      for (const c of parseCandidates(b.c)) {
        if (link.remoteSet) link.pc.addIceCandidate(c).catch(() => {})
        else if (link.pendingIce.length < MAX_BUFFERED_ICE) link.pendingIce.push(c)
      }
      return true
    }
    // Candidates can overtake their offer (different brokers): keep a few sids around — only from our upstream.
    if (!this.running || link || from !== this.upstreamId()) return false
    const cands = parseCandidates(b.c)
    if (cands.length === 0) return true
    let e = this.earlyIce.get(b.sid)
    if (!e) {
      if (this.earlyIce.size >= MAX_EARLY_ICE_SIDS) {
        const oldest = this.earlyIce.keys().next().value
        if (oldest !== undefined) this.earlyIce.delete(oldest)
      }
      e = { from, c: [] }
      this.earlyIce.set(b.sid, e)
    }
    if (e.from !== from) return true
    for (const c of cands) if (e.c.length < MAX_BUFFERED_ICE) e.c.push(c)
    return true
  }

  private onOffer(from: string, b: Extract<SignalBody, { t: 'offer' }>): boolean {
    if (typeof b.jid !== 'string' || typeof b.sid !== 'string' || typeof b.sdp !== 'string') return false
    if (b.jid !== this.jid || !this.jid) return false // offer for an older attempt (or not for us)
    if (from !== this.upstreamId()) return false // only the origin (or, after a redirect, the relay) may answer
    if (!this.running) return true
    if (!b.sid || b.sid.length > 64 || b.sdp.length === 0 || b.sdp.length > 60_000) return true

    const cur = this.link
    if (cur && !cur.closed) {
      if (cur.sid === b.sid && cur.from === from) {
        this.resendAnswer(cur) // the upstream re-sent its offer: it probably missed our answer
        return true
      }
      // Our link is already up: keep what we have.
      if (cur.from !== from || cur.everConnected) return true
      // Same upstream, new sid: it abandoned the previous pc → replace ours.
      this.closeLink(cur)
    }
    void this.applyOffer(from, b)
    return true
  }

  private async applyOffer(from: string, b: Extract<SignalBody, { t: 'offer' }>): Promise<void> {
    this.clearJoinTimers()
    let link: Link
    try {
      link = this.createLink(from, b.jid, b.sid)
    } catch {
      this.attemptFailed()
      return
    }
    this.link = link
    // New upstream (maybe the origin instead of a relay): its sender info arrives with its first ctl 'tx'.
    this.hostEncodeMs = null
    this.upstreamLatencyMs = 0
    this.setState('connecting')
    const offered = typeof b.hostName === 'string' ? b.hostName.slice(0, 40) : ''
    this.updateHostInfo({ hostName: offered || this.hostInfo?.hostName || this.originName, paused: false })

    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: b.sdp })
      if (link.closed) return
      link.remoteSet = true
      const early = this.earlyIce.get(b.sid)
      this.earlyIce.delete(b.sid)
      if (early && early.from === from) for (const c of early.c) link.pc.addIceCandidate(c).catch(() => {})
      for (const c of link.pendingIce.splice(0)) link.pc.addIceCandidate(c).catch(() => {})
      await link.pc.setLocalDescription()
      if (link.closed) return
      await waitIceGathering(link.pc, GATHER_MS)
      if (link.closed) return
      const sdp = link.pc.localDescription?.sdp
      if (!sdp) throw new Error('no local description')
      // Candidates gathered so far are inside the SDP; later ones are trickled.
      link.answerSdp = sdp
      link.answerSent = true
      this.send({ t: 'answer', sid: link.sid, sdp }, link.from)
      // Answers can get lost on the brokers: repeat until the connection is up (the sender ignores duplicates).
      link.answerTimer = setInterval(() => {
        if (link.closed || link.everConnected) {
          if (link.answerTimer) clearInterval(link.answerTimer)
          link.answerTimer = null
          return
        }
        this.resendAnswer(link)
      }, ANSWER_RESEND_MS)
    } catch {
      if (!link.closed && this.link === link) this.linkLost(link)
    }
  }

  private resendAnswer(link: Link): void {
    if (link.closed || !link.answerSent || !link.answerSdp) return
    this.send({ t: 'answer', sid: link.sid, sdp: link.answerSdp }, link.from)
    if (link.lateLocalIce.length > 0) this.send({ t: 'ice', sid: link.sid, c: link.lateLocalIce.slice() }, link.from)
  }

  // ───────────────────────── peer connection ─────────────────────────

  private createLink(from: string, jid: string, sid: string): Link {
    const { pc } = createPeerConnection(this.net)
    let dc: RTCDataChannel
    try {
      dc = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true })
    } catch (err) {
      pc.close()
      throw err
    }
    const link: Link = {
      sid,
      jid,
      from,
      pc,
      dc,
      dcQueue: [],
      answerSdp: null,
      answerSent: false,
      remoteSet: false,
      pendingIce: [],
      lateLocalIce: [],
      iceOut: [],
      iceTimer: null,
      answerTimer: null,
      connectTimer: null,
      disconnectTimer: null,
      everConnected: false,
      sampler: null,
      videoTrack: null,
      audioTrack: null,
      videoReceiver: null,
      audioReceiver: null,
      closed: false,
    }
    pc.ontrack = (e) => this.onTrack(link, e)
    pc.onicecandidate = (e) => {
      if (link.closed || !link.answerSent || !e.candidate || !e.candidate.candidate) return
      const c = e.candidate.toJSON()
      if (link.lateLocalIce.length < MAX_LATE_ICE) link.lateLocalIce.push(c)
      link.iceOut.push(c)
      if (!link.iceTimer) {
        link.iceTimer = setTimeout(() => {
          link.iceTimer = null
          if (link.closed || link.iceOut.length === 0) return
          this.send({ t: 'ice', sid: link.sid, c: link.iceOut.splice(0) }, link.from)
        }, ICE_BATCH_MS)
      }
    }
    pc.onconnectionstatechange = () => this.onLinkState(link)
    dc.onopen = () => {
      if (link.closed) return
      this.sendCtl(link, { t: 'hello', name: this.name })
      for (const data of link.dcQueue.splice(0)) {
        try { dc.send(data) } catch { /* ignore */ }
      }
    }
    dc.onmessage = (e) => this.onCtl(link, e.data)
    dc.onclose = () => {
      // Upstream closed its side (left / crashed / relay released us): reconnect without waiting for ICE timeouts.
      if (!link.closed && this.link === link && link.everConnected) this.linkLost(link)
    }
    link.connectTimer = setTimeout(() => {
      link.connectTimer = null
      if (!link.closed && this.link === link && !link.everConnected) this.linkLost(link)
    }, CONNECT_TIMEOUT_MS)
    return link
  }

  private onTrack(link: Link, e: RTCTrackEvent): void {
    if (link.closed || this.link !== link) return
    tuneReceiver(e.receiver, this.latencyMode)
    if (e.track.kind === 'video') {
      link.videoTrack = e.track
      link.videoReceiver = e.receiver
      const stream = new MediaStream([e.track])
      this.safe(() => this.onVideo(stream))
    } else if (e.track.kind === 'audio') {
      link.audioTrack = e.track
      link.audioReceiver = e.receiver
      const stream = new MediaStream([e.track])
      this.safe(() => this.onAudio(stream))
    }
  }

  private onLinkState(link: Link): void {
    if (link.closed || this.link !== link) return
    const s = link.pc.connectionState
    if (s === 'connected') {
      if (link.disconnectTimer) {
        clearTimeout(link.disconnectTimer)
        link.disconnectTimer = null
      }
      if (!link.everConnected) {
        link.everConnected = true
        this.failures = 0
        if (link.connectTimer) clearTimeout(link.connectTimer)
        if (link.answerTimer) clearInterval(link.answerTimer)
        link.connectTimer = null
        link.answerTimer = null
        link.sampler = new StatsSampler(link.pc)
        this.setState('connected')
        this.startStats()
        // Upstream reconnected: keep our children and feed them the new tracks.
        const relay = this.relay
        if (relay && this.relayLinkSid !== link.sid && link.videoTrack) {
          this.relayLinkSid = link.sid
          // replaceStream un-pauses; re-pause if the upstream told us meanwhile that it is paused.
          void relay.replaceStream(this.linkStream(link)).then(() => {
            if (this.relay === relay && this.hostInfo?.paused) relay.setPaused(true)
          })
        }
      } else if (this.st !== 'connected') {
        this.setState('connected')
      }
    } else if (s === 'disconnected') {
      if (!link.disconnectTimer) {
        link.disconnectTimer = setTimeout(() => {
          link.disconnectTimer = null
          if (!link.closed && this.link === link && link.pc.connectionState !== 'connected') this.linkLost(link)
        }, DISCONNECT_GRACE_MS)
      }
    } else if (s === 'failed') {
      this.linkLost(link)
    }
  }

  /** The current link died: retry through the origin with a new jid, or give up after too many failures. */
  private linkLost(link: Link): void {
    if (link.closed) return
    const wasConnected = link.everConnected
    this.closeLink(link)
    if (!this.running) return
    this.stopStats()
    if (this.relay) this.relay.setPaused(true) // children stay connected and see "paused"
    if (!wasConnected) {
      this.attemptFailed()
      return
    }
    this.setState('reconnecting')
    this.beginAttempt()
  }

  /** Counts a failed attempt (never reached 'connected'); 4 in a row → 'failed'. */
  private attemptFailed(): void {
    if (!this.running) return
    this.failures++
    if (this.failures >= MAX_FAILED_ATTEMPTS) {
      this.finish('failed')
      return
    }
    this.setState('reconnecting')
    this.beginAttempt()
  }

  private closeLink(link: Link): void {
    if (link.closed) return
    link.closed = true
    if (link.iceTimer) clearTimeout(link.iceTimer)
    if (link.answerTimer) clearInterval(link.answerTimer)
    if (link.connectTimer) clearTimeout(link.connectTimer)
    if (link.disconnectTimer) clearTimeout(link.disconnectTimer)
    link.iceTimer = link.connectTimer = link.disconnectTimer = null
    link.answerTimer = null
    link.pendingIce.length = 0
    link.dcQueue.length = 0
    link.pc.ontrack = null
    link.pc.onicecandidate = null
    link.pc.onconnectionstatechange = null
    link.dc.onopen = null
    link.dc.onmessage = null
    link.dc.onclose = null
    try { link.pc.close() } catch { /* ignore */ }
    if (this.link === link) this.link = null
  }

  // ───────────────────────── data channel ─────────────────────────

  private sendCtl(link: Link, msg: CtlMessage): void {
    if (link.closed) return
    const data = JSON.stringify(msg)
    if (link.dc.readyState === 'open') {
      try { link.dc.send(data) } catch { /* ignore */ }
    } else if (link.dc.readyState === 'connecting' && msg.t !== 'rx' && link.dcQueue.length < 16) {
      link.dcQueue.push(data)
    }
  }

  private onCtl(link: Link, data: unknown): void {
    if (link.closed || this.link !== link || !this.running) return
    const msg = parseCtl(data)
    if (!msg) return
    switch (msg.t) {
      case 'info': {
        this.updateHostInfo({ hostName: msg.hostName, settings: msg.settings, viewers: msg.viewers, codec: msg.codec, hops: msg.hops })
        if (this.relay) {
          const key = JSON.stringify(msg.settings)
          if (key !== this.relaySettingsKey) {
            this.relaySettingsKey = key
            void this.relay.updateSettings(msg.settings)
          }
          this.relay.updateUpstream(msg.hops, msg.hostName, msg.viewers)
        }
        return
      }
      case 'tx':
        this.hostEncodeMs = msg.encodeMs
        this.upstreamLatencyMs = msg.upstreamLatencyMs
        this.safe(() => this.onHostTx(msg))
        return
      case 'paused':
        this.updateHostInfo({ paused: msg.paused })
        if (this.relay) this.relay.setPaused(msg.paused)
        return
      case 'expect':
        // The origin vouches for a watcher it is about to redirect to us (only the origin talks to relays).
        if (this.relay && link.from === this.origin) this.relay.expect(msg.id, msg.jid)
        return
      case 'kick':
        this.finish('kicked', 'kicked')
        return
      case 'bye':
        this.finish('ended')
        return
      default:
        return
    }
  }

  // ───────────────────────── stats / relay ─────────────────────────

  private startStats(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => void this.statsTick(), STATS_MS)
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private hwHint(): boolean | null {
    const codec = this.hostInfo?.codec
    if (this.dec === null || !codec) return null
    return this.dec.includes(codec)
  }

  private async statsTick(): Promise<void> {
    const link = this.link
    if (this.statsBusy || !link || link.closed || !link.everConnected || !link.sampler) return
    this.statsBusy = true
    try {
      const st = await link.sampler.inbound(this.hwHint(), { hostEncodeMs: this.hostEncodeMs, upstreamLatencyMs: this.upstreamLatencyMs })
      if (!st || link.closed || this.link !== link || !this.running) return
      this.lastLatency = st.latencyMs
      this.lastConnType = st.connType
      this.maybeStartRelay(link)
      if (this.relay && st.width > 0 && st.height > 0) this.relay.setSourceSize(st.width, st.height)
      this.safe(() => this.onStats(st))
      const children = this.relay ? this.relay.connectedCount() : 0
      // Relays only exist at hop 1, so our children never relay further: descendants = children.
      this.sendCtl(link, {
        t: 'rx',
        fps: st.fps,
        latencyMs: st.latencyMs,
        lossPct: st.lossPct,
        width: st.width,
        height: st.height,
        children,
        descendants: children,
        canRelay: this.canRelay(),
      })
    } finally {
      this.statsBusy = false
    }
  }

  /**
   * Willing and able to take another child: relaying allowed, not on TURN, not in 'smooth' mode (our jitter
   * buffer would add its floor to every child) and a free slot counting children that are still connecting.
   */
  private canRelay(): boolean {
    if (!this.allowRelay || this.relay === null || this.latencyMode === 'smooth') return false
    if (this.lastConnType === 'relay' || this.lastConnType === 'unknown') return false
    return this.relay.slotCount() < RELAY_MAX_CHILDREN
  }

  /** Lazily start the embedded relay once we are a healthy direct watcher of the origin. */
  private maybeStartRelay(link: Link): void {
    if (this.relay || !this.allowRelay || !this.running || this.latencyMode === 'smooth') return
    if (this.lastConnType === 'relay' || this.lastConnType === 'unknown') return
    const info = this.hostInfo
    // Only the origin redirects, and only to its direct watchers → relaying makes sense at hop 1 only.
    if (!info || !info.settings || info.hops !== 1 || link.from !== this.origin || !link.videoTrack) return
    try {
      const relay = new HostSession({
        room: this.room,
        stream: this.linkStream(link),
        settings: info.settings,
        hostName: this.name,
        net: this.net,
        role: 'relay',
        origin: this.origin,
        maxDirect: RELAY_MAX_CHILDREN,
        hops: info.hops,
        originName: info.hostName,
        upstreamLatencyMs: () => this.lastLatency ?? 0,
      })
      relay.start()
      relay.updateUpstream(info.hops, info.hostName, info.viewers)
      if (info.paused) relay.setPaused(true)
      this.relay = relay
      this.relaySettingsKey = JSON.stringify(info.settings)
      this.relayLinkSid = link.sid
    } catch {
      /* relaying is optional */
    }
  }

  private dropRelay(mode: 'bye' | 'release'): void {
    const relay = this.relay
    if (!relay) return
    this.relay = null
    this.relayLinkSid = null
    if (mode === 'bye') relay.stop()
    else relay.release()
  }

  private linkStream(link: Link): MediaStream {
    const tracks: MediaStreamTrack[] = []
    if (link.videoTrack) tracks.push(link.videoTrack)
    if (link.audioTrack) tracks.push(link.audioTrack)
    return new MediaStream(tracks)
  }

  // ───────────────────────── state helpers ─────────────────────────

  private updateHostInfo(patch: Partial<HostInfo>): void {
    const prev: HostInfo = this.hostInfo ?? { hostName: this.originName ? sanitizeName(this.originName) : '', settings: null, viewers: 0, codec: null, hops: 1, paused: false }
    const next: HostInfo = { ...prev, ...patch }
    this.hostInfo = next
    this.safe(() => this.onHostInfo({ ...next }))
  }

  /** Terminal state: stop retrying. 'ended' forwards bye to our children, everything else lets them reconnect. */
  private finish(state: Terminal, detail?: string): void {
    if (!this.running) return
    this.running = false
    this.startGen++
    this.clearJoinTimers()
    this.stopStats()
    if (this.link) this.closeLink(this.link)
    this.earlyIce.clear()
    this.dropRelay(state === 'ended' ? 'bye' : 'release')
    this.setState(state, detail)
  }

  private clearJoinTimers(): void {
    if (this.joinTimer) clearInterval(this.joinTimer)
    if (this.redirectTimer) clearTimeout(this.redirectTimer)
    this.joinTimer = null
    this.redirectTimer = null
  }

  private setState(state: ViewerState, detail?: string, force = false): void {
    if (!force && state === this.st && detail === this.stDetail) return
    this.st = state
    this.stDetail = detail
    this.safe(() => this.onState(state, detail))
  }

  /** room.send that can never throw into a handler (room may already be closed). */
  private send(body: SignalBody, to?: string): void {
    try {
      this.room.send(body, to)
    } catch {
      /* signaling unavailable — retries/timeouts take care of it */
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

// Shared contracts between the signaling, RTC and UI layers.
// Keep this file free of runtime logic (types + tiny constants only).

/** Protocol version carried in every signaling envelope. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1

// ───────────────────────── Stream settings ─────────────────────────

/** Concrete video codecs we negotiate. */
export type CodecName = 'AV1' | 'H264' | 'VP9' | 'VP8'

/**
 * 'auto' = AV1 when the host has a hardware AV1 encoder and the viewer decodes AV1 in hardware, else H.264.
 * 'HEVC' is the native path's codec (WebView2 cannot send it over WebRTC): there it is the default anyway, on WebRTC
 * it means 'auto'. An explicit AV1 / VP9 / VP8 only reaches viewers that decode it in hardware.
 */
export type CodecPref = 'auto' | 'HEVC' | CodecName

/**
 * motion   = games/video (contentHint 'motion')
 * balanced = default (contentHint 'motion')
 * detail   = text/code (contentHint 'detail')
 * Every mode keeps resolution and frame rate fixed (degradationPreference 'maintain-framerate-and-resolution'):
 * a short link lowers only the bitrate.
 */
export type ContentMode = 'motion' | 'balanced' | 'detail'

/** Max capture height; 'native' = up to 3840x2160 without downscaling. */
export type ResolutionPref = 'native' | 2160 | 1440 | 1080 | 720

export type FpsPref = 30 | 60 | 120

export interface StreamSettings {
  resolution: ResolutionPref
  fps: FpsPref
  /** Max video bitrate per viewer in kbps; 0 = automatic (derived from resolution, fps and codec). */
  bitrateKbps: number
  codec: CodecPref
  content: ContentMode
  /** Request audio (system audio for screens, application audio for windows). */
  audio: boolean
}

export interface TurnServer {
  urls: string
  username?: string
  credential?: string
}

/** User-editable network configuration ("Erweitert"). */
export interface NetConfig {
  /**
   * wss:// MQTT-over-WebSocket broker URLs used for signaling.
   * Credentials may be embedded as userinfo, e.g. "wss://demo@demo.tbmq.io:443/mqtt".
   */
  brokers: string[]
  /** stun: URLs. */
  stun: string[]
  /** Optional TURN relays (none by default). */
  turn: TurnServer[]
}

// ───────────────────────── Signaling ─────────────────────────

/**
 * Bodies of messages exchanged over the encrypted signaling room ("tunnel").
 * There are no roles: every member is equal and may share a stream; any member may watch any stream.
 * Code naming: the member who shares a stream runs a "HostSession" (sender), a watcher runs a "ViewerSession".
 * Routing (see room.ts): `to` set → recipient's inbox topic; `to` unset → broadcast topic.
 */
export type SignalBody =
  /**
   * member → broadcast, every ~3 s and immediately on change: "I am in the tunnel" (+ what I share).
   * Members that send nothing for 12 s are considered gone.
   */
  | { t: 'presence'; name: string; live: LiveInfo | null; seq?: number }
  /** member → broadcast: leaving the tunnel now. */
  | { t: 'leave' }
  /**
   * watcher → sharer (`to` = origin) or watcher → relay (`to` = relay id), always addressed.
   * `origin` = id of the member whose stream is requested (a relay may also share its own stream).
   * Re-sent every ~2 s with the SAME jid until an offer/reject/redirect for this jid arrives.
   * A new jid is only created for a new connection attempt.
   */
  | { t: 'join'; jid: string; origin: string; name: string; dec: CodecName[]; relay: boolean; wk?: boolean }
  /** sharer/relay → watcher. One RTCPeerConnection per (watcher, jid); sid identifies it. */
  | { t: 'offer'; jid: string; sid: string; sdp: string; hostName: string }
  /** watcher → sharer/relay. */
  | { t: 'answer'; sid: string; sdp: string }
  /** both directions; batched trickle candidates for late candidates (SDP already carries the early ones). */
  | { t: 'ice'; sid: string; c: RTCIceCandidateInit[] }
  /** sharer/relay → watcher: join refused. */
  | { t: 'reject'; jid: string; reason: RejectReason }
  /** sharer → watcher: connect to this relay instead (send the same jid + origin to `relay`). */
  | { t: 'redirect'; jid: string; relay: string }
  /** sharer → broadcast (no sid): "my stream ended". watcher → sharer/relay (with sid): leaving this connection. */
  | { t: 'bye'; sid?: string; seq?: number }
  /**
   * Native path (docs/NATIVE-PATH.md §10). watcher → sharer (`to` = origin): watch over a native link. Re-sent every
   * 1 s with the SAME nid (cand may grow) until an 'nv' offer / wait / no for this nid arrives. `link` = the watcher's
   * link id, `key` = its ephemeral X25519 public key (64 hex digits).
   */
  | { t: 'nv'; k: 'join'; nid: string; origin: string; name: string; caps: NvViewerCaps; link: number; key: string; cand: NvCandidate[] }
  /** sharer → watcher: admitted; both ends probe now. `sid` names the link from here on ('nvice', 'bye'). */
  | { t: 'nv'; k: 'offer'; nid: string; sid: string; codec: NvCodec; link: number; key: string; cand: NvCandidate[]; hostName: string; fps: number; kbps: number; audio: boolean }
  /** sharer → watcher: the sharer has to approve first — keep waiting (re-sent with every join). */
  | { t: 'nv'; k: 'wait'; nid: string }
  /** sharer → watcher: no native link. 'unavailable' | 'busy' | 'full' → fall back to WebRTC; the rest end like 'reject'. */
  | { t: 'nv'; k: 'no'; nid: string; reason: NvNoReason }
  /** both directions: late candidates (server-reflexive) of a native link. */
  | { t: 'nvice'; sid: string; cand: NvCandidate[] }

/** What a sharing member announces in its presence. */
export interface LiveInfo {
  /** source label shown to others, e.g. the window title ("Forza Horizon 6") or "Bildschirm" */
  title: string
  width: number
  height: number
  fps: number
  /** stream carries audio */
  audio: boolean
  /** current number of watchers (direct + relayed) */
  viewers: number
  /** ms since epoch when sharing started */
  since: number
  /** the stream can be watched over the native path (docs/NATIVE-PATH.md); absent = WebRTC only */
  nv?: NvLive
}

export type RejectReason = 'full' | 'locked' | 'kicked' | 'denied'

// ───────────────────────── Native path (docs/NATIVE-PATH.md) ─────────────────────────

/** Video codec of the native path ('hevc' = HEVC Main, 'h264' = H.264 High). */
export type NvCodec = 'hevc' | 'h264'

/** One UDP candidate of a native link: `a` = "ip:port" | "[v6]:port", `k` = interface address or STUN-reflexive. */
export interface NvCandidate {
  a: string
  k: 'host' | 'srflx'
}

/** In a sharer's presence: this share can be watched natively. */
export interface NvLive {
  /** stm protocol version of the sharer, and the oldest one it talks to */
  v: number
  min: number
  /** codecs the sharer encodes, best first */
  codecs: NvCodec[]
}

/** A watcher's native capabilities (in the 'nv' join). */
export interface NvViewerCaps {
  v: number
  min: number
  /** codecs the page decodes, best first ('hevc' only with hardware and not on WebKit) */
  dec: NvCodec[]
  /** the decoder recovers from reference-frame invalidation (false for every WebCodecs viewer for now) */
  rfi: boolean
  /** the page plays native PCM (AudioWorklet available) */
  audio: boolean
}

/** Why a sharer answers a native join with 'no'. */
export type NvNoReason = RejectReason | 'unavailable' | 'busy'

/** Wire envelope (encrypted as a whole; topic is AES-GCM additional data). */
export interface SignalEnvelope {
  /** protocol version */
  v: number
  /** random message id (dedupe across brokers) */
  id: string
  /** sender peer id */
  from: string
  /** recipient peer id; absent = broadcast / host inbox */
  to?: string
  /** sender wall clock (ms since epoch); messages outside ±10 min are dropped */
  ts: number
  body: SignalBody
}

export interface SignalingStatus {
  /** brokers with an established MQTT session */
  connected: number
  /** brokers configured */
  total: number
}

export interface ISignalingRoom {
  readonly selfId: string
  /** Canonical code without dash, e.g. "K7F3QX9MZD". */
  readonly code: string
  /**
   * Called for every fresh, deduplicated, decrypted message addressed to us (or broadcast), never our own.
   * Exactly one owner installs this: the TunnelSession (it dispatches to its sessions via handleSignal).
   */
  onSignal: (from: string, body: SignalBody) => void
  onStatus: (status: SignalingStatus) => void
  /** Publish to all connected brokers (queued ~15 s if none is connected). */
  send(body: SignalBody, to?: string): void
  status(): SignalingStatus
  close(): void
}

// ───────────────────────── Data channel (after connect) ─────────────────────────

export type CtlMessage =
  /** host/relay → viewer, on open and on change */
  | { t: 'info'; hostName: string; settings: StreamSettings; viewers: number; codec: CodecName; hops: number }
  /** host/relay → viewer every ~2 s: sender-side stats for this link */
  | { t: 'tx'; encodeMs: number | null; encoder: string; hw: boolean | null; kbps: number; upstreamLatencyMs: number; lim?: 'cpu' | 'bandwidth' | 'other' | 'none'; fps?: number }
  /** host/relay → viewer: capture paused (source ended / switching) or resumed */
  | { t: 'paused'; paused: boolean }
  /** host/relay → viewer: you were removed */
  | { t: 'kick' }
  /** host/relay → viewer: stream ended */
  | { t: 'bye' }
  /** viewer → host/relay, on open */
  | { t: 'hello'; name: string }
  /**
   * sharer → relay (over the relay's authenticated data channel): "I am about to redirect viewer `id` with
   * attempt `jid` to you" — relays only admit vouched viewers, so the sharer's lock/ban/approval also hold there.
   */
  | { t: 'expect'; id: string; jid: string }
  /** viewer → host/relay every ~2 s: what the viewer experiences + its relay load */
  | {
      t: 'rx'
      fps: number
      latencyMs: number | null
      lossPct: number
      width: number
      height: number
      /** direct children this viewer currently relays to */
      children: number
      /** all viewers below this one in the tree */
      descendants: number
      /** willing and able to relay (allowRelay setting + not itself on a TURN relay) */
      canRelay: boolean
    }

// ───────────────────────── Stats ─────────────────────────

/** host candidates on both ends | srflx/prflx (P2P through NAT) | relay (TURN) */
export type ConnType = 'lan' | 'p2p' | 'relay' | 'unknown'

export interface OutboundStats {
  bitrateKbps: number
  fps: number
  width: number
  height: number
  /** e.g. "AV1", "H264" */
  codec: string
  /** encoderImplementation, e.g. "MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)" */
  encoder: string
  /** true = hardware encoder, false = software, null = unknown */
  hw: boolean | null
  /** average encode time per frame over the last interval */
  encodeMs: number | null
  /** 'none' | 'cpu' | 'bandwidth' | 'other' */
  qualityLimitation: string
  rttMs: number | null
  connType: ConnType
  /** candidate-pair availableOutgoingBitrate in kbps */
  availableKbps: number | null
  audioKbps: number
}

export interface InboundStats {
  bitrateKbps: number
  fps: number
  width: number
  height: number
  codec: string
  /** decoderImplementation if exposed (often hidden for viewers), else '' */
  decoder: string
  /** hardware decode: from stats if exposed, else from MediaCapabilities; null = unknown */
  hw: boolean | null
  rttMs: number | null
  /** average time frames spend in the jitter buffer over the last interval */
  jitterBufferMs: number | null
  /** average decode time per frame over the last interval */
  decodeMs: number | null
  /** packet loss over the last interval, 0..100 */
  lossPct: number
  framesDropped: number
  freezeCount: number
  connType: ConnType
  /** estimated glass-to-glass latency (host encode + network + buffering + decode + render + upstream hops), ms */
  latencyMs: number | null
  audioKbps: number
  /** 'native' = stm link (docs/NATIVE-PATH.md); absent / 'webrtc' = the WebRTC path */
  transport?: 'native' | 'webrtc'
}

// ───────────────────────── Sessions ─────────────────────────

export type ViewerConnState = 'pending' | 'connecting' | 'connected' | 'failed'

export interface ViewerInfo {
  /** viewer peer id */
  id: string
  name: string
  /** 'pending' = waiting for host approval */
  state: ViewerConnState
  connectedAt: number | null
  /** negotiated video codec for this viewer */
  codec: CodecName | null
  /** host-side sender stats for this viewer */
  tx: OutboundStats | null
  /** what the viewer reports back over the data channel */
  rx: Extract<CtlMessage, { t: 'rx' }> | null
  /** watches over the native path (docs/NATIVE-PATH.md); absent = WebRTC */
  native?: boolean
}

export interface HostSessionOptions {
  room: ISignalingRoom
  stream: MediaStream
  settings: StreamSettings
  /** display name of the sharer (root) — relays pass the origin's name via originName */
  hostName: string
  net: NetConfig
  /**
   * 'host'  = the member who shares this stream (root of its tree): answers joins for origin === own id,
   *           may redirect to relays.
   * 'relay' = a watcher re-sharing a received stream: answers only vouched joins for that origin, never redirects.
   * Neither role installs room.onSignal — the TunnelSession dispatches via handleSignal().
   */
  role?: 'host' | 'relay'
  /** id of the member whose stream this session sends. Default: room.selfId (role 'host'). Required for 'relay'. */
  origin?: string
  /** Max direct viewers before redirecting new ones to relays (root) or rejecting (relay). Default 4 (root) / 3 (relay). */
  maxDirect?: number
  /** Optional total upload cap in kbps shared by direct viewers; 0 = unlimited. */
  uploadLimitKbps?: number
  /** Ask before admitting a new viewer (root only). Default false. */
  requireApproval?: boolean
  /** relay only: hop count of this relay (1 = directly below the sharer) */
  hops?: number
  /** relay only: the origin's display name to show to children */
  originName?: string
  /** relay only: latency from origin to this relay, forwarded in 'tx' */
  upstreamLatencyMs?: () => number
}

export interface IHostSession {
  /** id of the member whose stream this session sends */
  readonly origin: string
  onViewersChanged: (viewers: ViewerInfo[]) => void
  /** root + requireApproval: called once per new viewer; call allow(true/false). */
  onJoinRequest: (viewer: { id: string; name: string }, allow: (ok: boolean) => void) => void
  /** Non-fatal notices for the UI, e.g. software-encoder fallback. German text. */
  onNotice: (message: string) => void
  /** start answering joins */
  start(): void
  /** Routes one signaling message; returns true if it belonged to this session (join for our origin, or our sids). */
  handleSignal(from: string, body: SignalBody): boolean
  viewers(): ViewerInfo[]
  /** connected direct viewers */
  connectedCount(): number
  /** viewers reached through relays (sum of reported descendants) */
  relayedCount(): number
  /** remove a viewer from this stream and refuse it for the rest of the session */
  kick(viewerId: string): void
  setLocked(locked: boolean): void
  isLocked(): boolean
  /** Live update: bitrate / fps / resolution / content mode apply without reconnect. Codec applies to new viewers. */
  updateSettings(settings: StreamSettings): Promise<void>
  /** Switch the shared screen/window without reconnecting viewers (replaceTrack). Does not stop old tracks. */
  replaceStream(stream: MediaStream): Promise<void>
  /** Tell viewers the picture is paused (e.g. capture ended) or resumed. */
  setPaused(paused: boolean): void
  /** End the stream: ctl bye to every viewer, broadcast {t:'bye'} (root), close all connections. Does NOT stop capture tracks or close the room. */
  stop(): void
}

export type ViewerState =
  /** request sent, the sharer has not answered yet */
  | 'waiting'
  /** offer received, ICE/DTLS in progress */
  | 'connecting'
  | 'connected'
  /** connection lost, retrying automatically */
  | 'reconnecting'
  /** the member stopped sharing or left the tunnel */
  | 'ended'
  /** removed from this stream by the sharer */
  | 'kicked'
  /** sharer refused (full/locked/denied) — detail carries the RejectReason */
  | 'rejected'
  /** could not establish P2P after several attempts (likely strict NAT/firewall without TURN) */
  | 'failed'

export interface HostInfo {
  /** sharer's display name */
  hostName: string
  settings: StreamSettings | null
  viewers: number
  codec: CodecName | null
  /** 1 = direct from the sharer, 2+ = through relays */
  hops: number
  paused: boolean
}

export type LatencyMode = 'lowest' | 'smooth'

export interface ViewerSessionOptions {
  room: ISignalingRoom
  name: string
  net: NetConfig
  /** id of the member whose stream to watch */
  origin: string
  /** Allow the sharer to route other watchers through us. Default true. */
  allowRelay?: boolean
  /** 'lowest' = jitterBufferTarget 0; 'smooth' = ~120 ms buffer. Default 'lowest'. */
  latencyMode?: LatencyMode
}

export interface IViewerSession {
  /** member id whose stream this session watches */
  readonly origin: string
  onState: (state: ViewerState, detail?: string) => void
  /** Video-only stream (render in <video>). Called again after every reconnect. */
  onVideo: (stream: MediaStream) => void
  /** Audio-only stream (render in <audio>), separate so A/V sync never delays video. */
  onAudio: (stream: MediaStream) => void
  /** Canvas of the low-latency path (Parsec-style); null = show the <video>. Optional for older sessions. */
  onRenderer?: (view: HTMLElement | null) => void
  onHostInfo: (info: HostInfo) => void
  /** sender-side stats of the link we receive from (encoder, encode time) */
  onHostTx: (tx: Extract<CtlMessage, { t: 'tx' }>) => void
  onStats: (stats: InboundStats) => void
  start(): void
  /** Routes one signaling message (incl. those for our embedded relay); returns true if consumed. */
  handleSignal(from: string, body: SignalBody): boolean
  /** The origin announced itself (presence) — if waiting, send the join now instead of on the next tick. */
  nudge(): void
  /** The origin stopped sharing or left the tunnel → state 'ended'. */
  originGone(reason?: string): void
  state(): ViewerState
  setLatencyMode(mode: LatencyMode): void
  /** Number of viewers we currently relay to. */
  relayChildren(): number
  stop(): void
}

// ───────────────────────── Tunnel ─────────────────────────

export interface TunnelMember {
  id: string
  name: string
  /** this is us */
  self: boolean
  /** what the member currently shares, null = not sharing */
  live: LiveInfo | null
  /** ms since epoch of the last presence (Date.now() for self) */
  lastSeen: number
}

export interface ShareOptions {
  /** default 4 */
  maxDirect?: number
  /** kbps, 0 = unlimited */
  uploadLimitKbps?: number
  requireApproval?: boolean
}

export interface TunnelSessionOptions {
  room: ISignalingRoom
  name: string
  net: NetConfig
  /** default true */
  allowRelay?: boolean
  /** default 'lowest' */
  latencyMode?: LatencyMode
}

/**
 * One tunnel = one room code. Owns room.onSignal, keeps the member list (presence), lets us share our own
 * stream (at most one at a time) and watch one member's stream at a time; dispatches signaling to them.
 */
export interface ITunnelSession {
  /** member list changed (join/leave/live state/viewer counts); sorted: live members first, then by name; self included */
  onMembers: (members: TunnelMember[]) => void
  /** non-fatal notices (German), e.g. from the sharing session */
  onNotice: (message: string) => void
  /** start presence (broadcast now + every 3 s) and member tracking */
  start(): void
  members(): TunnelMember[]
  setName(name: string): void
  /** Start sharing a stream (from captureScreen / makeTestStream). Throws if already sharing. */
  share(stream: MediaStream, settings: StreamSettings, title: string, opts?: ShareOptions): IHostSession
  /** our current sharing session, if any */
  sharing(): IHostSession | null
  /** update the title others see (e.g. after switching the source) */
  setLiveTitle(title: string): void
  /** stop our stream (viewers get 'ended'); capture tracks are NOT stopped */
  stopSharing(): void
  /** Watch a member's stream; replaces the current watch. Throws for self or a member that is not live. */
  watch(memberId: string): IViewerSession
  watching(): IViewerSession | null
  stopWatching(): void
  /** stop sharing + watching, broadcast {t:'leave'}; the caller closes the room afterwards (~300 ms later) */
  leave(): void
}

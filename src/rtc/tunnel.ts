// TunnelSession: one tunnel = one room code with equal members (no host). Owns room.onSignal, keeps the member
// list from presence broadcasts, runs our own sharing session (HostSession, at most one) and our current watch
// (ViewerSession, at most one) and dispatches signaling to them (ARCHITECTURE.md §9).
import type {
  IHostSession,
  ISignalingRoom,
  ITunnelSession,
  IViewerSession,
  LatencyMode,
  LiveInfo,
  NetConfig,
  ShareOptions,
  SignalBody,
  StreamSettings,
  TunnelMember,
  TunnelSessionOptions,
} from '../types.ts'
import { HostSession, sanitizeName } from './host.ts'
import { ViewerSession } from './viewer.ts'

/** Timing knobs (defaults per §9.2); overridable for tests. */
export interface TunnelTiming {
  /** periodic presence broadcast */
  presenceMs: number
  /** minimum gap between two presence broadcasts (changes are coalesced) */
  presenceMinGapMs: number
  /** members without presence for this long are gone */
  expireMs: number
  /** housekeeping interval (expiry, change detection) */
  tickMs: number
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = { presenceMs: 3000, presenceMinGapMs: 1000, expireMs: 12_000, tickMs: 1000 }

/** Members kept at most (a flood of fake ids beyond it is ignored). */
const MAX_MEMBERS = 64
const MAX_TITLE = 80
const MAX_VIEWERS = 10_000
/** Budget for 'reject full' replies to joins that are not for us. */
const REJECT_RATE_PER_SEC = 2
const REJECT_BURST = 4

interface MemberEntry {
  id: string
  name: string
  live: LiveInfo | null
  /** Date.now() of the last presence */
  lastSeen: number
  /** monotonic time of the last presence (expiry; shifted forward while our signaling was offline) */
  seenAt: number
}

/** Title from untrusted input: no control characters, max 80 chars. */
function sanitizeTitle(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_TITLE)
}

const clampInt = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0

/** Validates a LiveInfo from the wire; null for "not sharing" or anything malformed. */
export function parseLiveInfo(v: unknown): LiveInfo | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  return {
    title: sanitizeTitle(r.title),
    width: clampInt(r.width, 16_384),
    height: clampInt(r.height, 16_384),
    fps: clampInt(r.fps, 1000),
    audio: r.audio === true,
    viewers: clampInt(r.viewers, MAX_VIEWERS),
    since: typeof r.since === 'number' && Number.isFinite(r.since) && r.since > 0 ? r.since : 0,
  }
}

const now = (): number => performance.now()

export class TunnelSession implements ITunnelSession {
  onMembers: (members: TunnelMember[]) => void = () => {}
  onNotice: (message: string) => void = () => {}

  private readonly room: ISignalingRoom
  private readonly net: NetConfig
  private readonly allowRelay: boolean
  private readonly latencyMode: LatencyMode
  private readonly timing: TunnelTiming
  private name: string

  private readonly memberMap = new Map<string, MemberEntry>()
  private host: HostSession | null = null
  private share_: { title: string; since: number } | null = null
  private viewer: ViewerSession | null = null

  private started = false
  private left = false
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private lastPresenceAt = -Infinity
  private lastPresenceKey = ''
  private lastMembersKey = ''
  /** monotonic time our signaling went offline (no broker connected); null = online */
  private offlineSince: number | null = null
  private rejectTokens = REJECT_BURST
  private rejectRefill = 0

  /** `timing` is an optional extra (not part of TunnelSessionOptions), for tests. */
  constructor(opts: TunnelSessionOptions & { timing?: Partial<TunnelTiming> }) {
    this.room = opts.room
    this.net = opts.net
    this.name = sanitizeName(opts.name)
    this.allowRelay = opts.allowRelay !== false
    this.latencyMode = opts.latencyMode ?? 'lowest'
    this.timing = { ...DEFAULT_TUNNEL_TIMING, ...(opts.timing ?? {}) }
  }

  // ───────────────────────── public API ─────────────────────────

  start(): void {
    if (this.started || this.left) return
    this.started = true
    this.room.onSignal = (from: string, body: SignalBody, broadcast?: boolean) => this.dispatch(from, body, broadcast)
    this.sendPresenceNow()
    this.tickTimer = setInterval(() => this.tick(), this.timing.tickMs)
    this.emitMembers()
  }

  members(): TunnelMember[] {
    const list: TunnelMember[] = [{ id: this.room.selfId, name: this.name, self: true, live: this.selfLive(), lastSeen: Date.now() }]
    for (const m of this.memberMap.values()) {
      list.push({ id: m.id, name: m.name, self: false, live: m.live ? { ...m.live } : null, lastSeen: m.lastSeen })
    }
    list.sort((a, b) => {
      if (!!a.live !== !!b.live) return a.live ? -1 : 1
      const byName = a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
      return byName !== 0 ? byName : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return list
  }

  setName(name: string): void {
    const n = sanitizeName(name)
    if (n === this.name) return
    this.name = n
    this.requestPresence()
    this.emitMembers()
  }

  share(stream: MediaStream, settings: StreamSettings, title: string, opts: ShareOptions = {}): IHostSession {
    if (this.left) throw new Error('Du hast den Tunnel bereits verlassen.')
    if (this.host) throw new Error('Du teilst bereits.')
    const host = new HostSession({
      room: this.room,
      stream,
      settings,
      hostName: this.name,
      net: this.net,
      role: 'host',
      origin: this.room.selfId,
      maxDirect: opts.maxDirect ?? 4,
      uploadLimitKbps: opts.uploadLimitKbps ?? 0,
      requireApproval: opts.requireApproval === true,
    })
    host.onNotice = (message) => this.notice(message)
    host.start()
    this.host = host
    this.share_ = { title: sanitizeTitle(title), since: Date.now() }
    this.requestPresence()
    this.emitMembers()
    return host
  }

  sharing(): IHostSession | null {
    return this.host
  }

  setLiveTitle(title: string): void {
    if (!this.share_) return
    const t = sanitizeTitle(title)
    if (t === this.share_.title) return
    this.share_.title = t
    this.requestPresence()
    this.emitMembers()
  }

  stopSharing(): void {
    const host = this.host
    if (!host) return
    this.host = null
    this.share_ = null
    host.stop() // broadcasts the sid-less bye ("my stream ended"); watchers end via ctl bye / originGone
    this.requestPresence()
    this.emitMembers()
  }

  /**
   * Watch a member's stream (replaces the current watch). The session's start() runs in a microtask, so callbacks
   * assigned right after this call also receive the initial 'waiting' state.
   */
  watch(memberId: string): IViewerSession {
    if (this.left) throw new Error('Du hast den Tunnel bereits verlassen.')
    if (memberId === this.room.selfId) throw new Error('Du kannst deinen eigenen Stream nicht ansehen.')
    const m = this.memberMap.get(memberId)
    if (!m || !m.live) throw new Error('Dieses Mitglied teilt gerade nichts.')
    this.stopWatching()
    const v = new ViewerSession({
      room: this.room,
      name: this.name,
      net: this.net,
      origin: memberId,
      allowRelay: this.allowRelay,
      latencyMode: this.latencyMode,
      originName: m.name,
    })
    this.viewer = v
    queueMicrotask(() => {
      if (this.viewer === v && !this.left) v.start()
    })
    return v
  }

  watching(): IViewerSession | null {
    return this.viewer
  }

  stopWatching(): void {
    const v = this.viewer
    if (!v) return
    this.viewer = null
    v.stop()
  }

  leave(): void {
    if (this.left) return
    const host = this.host
    const viewer = this.viewer
    this.host = null
    this.share_ = null
    this.viewer = null
    host?.stop()
    viewer?.stop()
    this.left = true
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.tickTimer = null
    this.presenceTimer = null
    if (this.started) this.send({ t: 'leave' })
    if (this.started) this.room.onSignal = () => {}
    this.memberMap.clear()
  }

  // ───────────────────────── dispatch (§9.5) ─────────────────────────

  /** `broadcast`: true/false from SignalingRoom (arrival topic), undefined if the room does not tell. */
  private dispatch(from: string, body: SignalBody, broadcast?: boolean): void {
    if (this.left || !body || typeof body !== 'object' || typeof body.t !== 'string' || from === this.room.selfId) return
    try {
      switch (body.t) {
        case 'presence':
          this.onPresence(from, body)
          return
        case 'leave':
          this.removeMember(from)
          return
        case 'join':
          this.onJoin(from, body)
          return
        case 'bye':
          if (typeof body.sid === 'string') {
            this.route(from, body)
            return
          }
          // Addressed sid-less bye = a watcher leaving before its connection was up (ours or our relay's).
          if (broadcast !== true) {
            if (this.route(from, body) || broadcast === false) return
          }
          // Broadcast sid-less bye = "my stream ended".
          this.onStreamEnded(from)
          return
        default:
          this.route(from, body)
      }
    } catch (err) {
      console.error('[tunnel] dispatch failed', err)
    }
  }

  /** Everything addressed to a session: our sharing session first, then our watch (incl. its relay). */
  private route(from: string, body: SignalBody): boolean {
    if (this.host && this.host.handleSignal(from, body)) return true
    return !!this.viewer && this.viewer.handleSignal(from, body)
  }

  private onJoin(from: string, body: Extract<SignalBody, { t: 'join' }>): void {
    if (typeof body.origin !== 'string' || typeof body.jid !== 'string' || !body.jid || body.jid.length > 64) return
    if (body.origin === this.room.selfId) {
      // Not sharing (any more): stay silent — our presence (live: null) / bye ends the joiner's attempt.
      if (this.host) this.host.handleSignal(from, body)
      return
    }
    if (this.viewer && this.viewer.handleSignal(from, body)) return // our embedded relay took it
    // A redirected watcher reached us but we do not relay that stream (any more) → it falls back to the origin.
    if (this.takeRejectToken()) this.send({ t: 'reject', jid: body.jid, reason: 'full' }, from)
  }

  private onPresence(from: string, body: Extract<SignalBody, { t: 'presence' }>): void {
    let m = this.memberMap.get(from)
    const isNew = !m
    if (!m) {
      if (this.memberMap.size >= MAX_MEMBERS) return
      m = { id: from, name: '', live: null, lastSeen: 0, seenAt: 0 }
      this.memberMap.set(from, m)
    }
    m.name = sanitizeName(body.name)
    m.live = parseLiveInfo(body.live)
    m.lastSeen = Date.now()
    m.seenAt = now()
    const v = this.viewer
    if (v && v.origin === from) {
      if (m.live === null) v.originGone()
      else v.nudge()
    }
    this.emitMembers()
    // A newcomer does not know us yet: announce ourselves now instead of on the next periodic tick.
    if (isNew) this.requestPresence()
  }

  private removeMember(id: string): void {
    const had = this.memberMap.delete(id)
    if (this.viewer && this.viewer.origin === id) this.viewer.originGone()
    if (had) this.emitMembers()
  }

  private onStreamEnded(id: string): void {
    const m = this.memberMap.get(id)
    if (m && m.live) {
      m.live = null
      this.emitMembers()
    }
    if (this.viewer && this.viewer.origin === id) this.viewer.originGone()
  }

  // ───────────────────────── presence / housekeeping ─────────────────────────

  private tick(): void {
    if (this.left) return
    const t = now()
    // While no broker is connected nobody's presence can reach us: freeze expiry instead of dropping everyone.
    let online = true
    try {
      online = this.room.status().connected > 0
    } catch {
      /* treat as online */
    }
    if (!online) {
      this.offlineSince ??= t
    } else {
      if (this.offlineSince !== null) {
        const shift = t - this.offlineSince
        for (const m of this.memberMap.values()) m.seenAt += shift
        this.offlineSince = null
      }
      for (const m of [...this.memberMap.values()]) {
        if (t - m.seenAt <= this.timing.expireMs) continue
        // The member we watch directly is provably alive while its media link is up (its signaling may be down).
        if (this.viewer && this.viewer.origin === m.id && this.viewer.upstreamAlive()) continue
        this.removeMember(m.id)
      }
    }
    if (t - this.lastPresenceAt >= this.timing.presenceMs || this.presenceKey() !== this.lastPresenceKey) this.requestPresence()
    this.emitMembers() // catches our own viewer-count changes
  }

  /** Presence now, or as soon as the minimum gap allows (coalesces bursts of changes). */
  private requestPresence(): void {
    if (!this.started || this.left) return
    const wait = this.lastPresenceAt + this.timing.presenceMinGapMs - now()
    if (wait <= 0) {
      this.sendPresenceNow()
      return
    }
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      this.sendPresenceNow()
    }, wait)
  }

  private sendPresenceNow(): void {
    if (!this.started || this.left) return
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.presenceTimer = null
    const live = this.selfLive()
    this.lastPresenceAt = now()
    this.lastPresenceKey = JSON.stringify([this.name, live])
    this.send({ t: 'presence', name: this.name, live })
  }

  private presenceKey(): string {
    return JSON.stringify([this.name, this.selfLive()])
  }

  /** What we announce while sharing (null = not sharing). */
  private selfLive(): LiveInfo | null {
    const host = this.host
    const share = this.share_
    if (!host || !share) return null
    const stream = host.currentStream()
    const settings = host.currentSettings()
    const video = stream.getVideoTracks()[0]
    let s: MediaTrackSettings = {}
    try { s = video?.getSettings() ?? {} } catch { /* ignore */ }
    const trackFps = typeof s.frameRate === 'number' && s.frameRate > 0 ? s.frameRate : 0
    const audioTrack = stream.getAudioTracks()[0]
    return {
      title: share.title,
      width: clampInt(s.width, 16_384),
      height: clampInt(s.height, 16_384),
      fps: Math.round(trackFps > 0 ? Math.min(settings.fps, trackFps) : settings.fps),
      audio: settings.audio && !!audioTrack && audioTrack.readyState === 'live',
      viewers: Math.min(MAX_VIEWERS, host.connectedCount() + host.relayedCount()),
      since: share.since,
    }
  }

  private emitMembers(): void {
    if (this.left) return
    const list = this.members()
    const key = JSON.stringify(list.map((m) => [m.id, m.name, m.live]))
    if (key === this.lastMembersKey) return
    this.lastMembersKey = key
    try {
      this.onMembers(list)
    } catch (err) {
      console.error('[tunnel] onMembers handler failed', err)
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  private takeRejectToken(): boolean {
    const t = now()
    this.rejectTokens = Math.min(REJECT_BURST, this.rejectTokens + ((t - this.rejectRefill) * REJECT_RATE_PER_SEC) / 1000)
    this.rejectRefill = t
    if (this.rejectTokens < 1) return false
    this.rejectTokens -= 1
    return true
  }

  /** room.send that never throws (room may already be closed). */
  private send(body: SignalBody, to?: string): void {
    try {
      this.room.send(body, to)
    } catch {
      /* signaling unavailable — periodic presence / retries take care of it */
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

// Encrypted signaling room on top of several public MQTT brokers at once.
//
// Every message is sealed once (AES-GCM, key + topic derived from the room code, the FULL destination topic as
// AAD) and published to every connected broker; receivers decrypt with the topic it arrived on, validate and
// deduplicate by message id, so each message is delivered exactly once as long as at least one broker carries it.
//
// Topics (B = derived base topic). There are no roles: every tunnel member subscribes to both.
//   B/p/<peerId> peer inbox — every addressed message (joins, offers, answers, ICE, rejects, redirects, byes)
//   B/b          broadcast  — only 'presence', 'leave' and the sharer's sid-less 'bye' ("my stream ended")
//
// The receive side mirrors the send-side routing: a message is only accepted on the topic send() would have used
// for it (to → B/p/<to>, else B/b), so a ciphertext can neither be replayed onto another sub-topic (AAD) nor be
// re-addressed (topic check), and each topic only carries the body types that belong there.
import type { ISignalingRoom, SignalBody, SignalEnvelope, SignalingStatus } from '../types.ts'
import { PROTOCOL_VERSION } from '../types.ts'
import { normalizeCode } from '../core/code.ts'
import { deriveRoomKeys, randomId, seal, unseal } from '../core/crypto.ts'
import { MAX_PAYLOAD_BYTES, MqttClient, parseBrokerUrl } from './mqtt.ts'
import type { MqttClientOptions, MqttStatus } from './mqtt.ts'

export interface RoomOptions {
  /** canonical code (normalizeCode output) */
  code: string
  /** our peer id (randomId() / deriveViewerId()) */
  selfId: string
  /** wss:// broker urls (userinfo = MQTT username/password) */
  brokers: string[]
  /** Advanced / tests: options for every MQTT client (timeouts, WebSocket factory). */
  mqtt?: MqttClientOptions
}

/** Counters for debugging and tests. */
export interface RoomDiagnostics {
  brokers: Array<{
    /** endpoint without credentials */
    url: string
    status: MqttStatus
    /** messages received from this broker (before decryption / dedupe) */
    received: number
    /** messages this broker delivered first (i.e. that reached onSignal through it) */
    firstDeliveries: number
    /** the flood guard dropped packets from this broker within the last second */
    ignored: boolean
    /** packets dropped by the flood guard (decrypt budget / backlog exhausted) */
    throttled: number
    /** packets that failed authentication (wrong key, wrong topic, junk) */
    junk: number
    lastError: string
  }>
  /** messages handed to onSignal */
  delivered: number
  /** valid copies dropped because the id was already seen */
  duplicates: number
  /** undecryptable / malformed / foreign-addressed / wrong-topic messages */
  dropped: number
  /** authentic messages dropped because the sender's clock is off by more than MAX_CLOCK_SKEW_MS */
  clockSkewDrops: number
  /** sender clock − our clock (ms) of the last authentic message that was off by more than a minute; null = none */
  lastSkewMs: number | null
  /** messages published (each to all connected brokers) */
  sent: number
  /** messages currently waiting for a broker */
  queued: number
}

/** Messages kept while no broker is connected. */
export const QUEUE_MAX = 50
export const QUEUE_TTL_MS = 15_000
/** Larger incoming payloads are dropped unread. */
export const MAX_INCOMING_BYTES = 64 * 1024
/**
 * Authentic envelopes whose timestamp is further off are dropped (reported via onClockSkew / diagnostics).
 * Deliberately wide: replays inside a session are caught by the id LRU and every tunnel uses a fresh code
 * (fresh key + topic), so this only has to stop ancient replays — while machines whose clock is hours off
 * (dual boot with the RTC in UTC, manually set clocks) must keep working.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 3600_000
/** Offsets above this are remembered as lastSkewMs (diagnostics only; such messages are still delivered). */
export const CLOCK_SKEW_NOTE_MS = 60_000
const CLOCK_SKEW_NOTIFY_INTERVAL_MS = 10_000
export const DEDUPE_CAPACITY = 4096
/**
 * Flood guard — never mutes a broker: per broker a token bucket of decrypt attempts. Packets that authenticate give
 * their token back, so only junk drains the bucket; beyond it (or with too many decrypts pending) the excess
 * packets are dropped while everything else keeps flowing. Legit signaling is < 10 msg/s and sent over every
 * broker with retries, so a dropped copy costs nothing.
 */
export const DECRYPT_RATE_PER_SEC = 400
export const DECRYPT_BURST = 800
export const MAX_PENDING_DECODES = 256

/** Peer ids end up in MQTT topics: no '/', '+', '#'. randomId() output always matches. */
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** IV + GCM tag */
const MIN_SEALED_BYTES = 28

/** Body types that travel on the broadcast topic (everything else must be addressed). */
export function isBroadcastBody(body: { t: string; sid?: unknown }): boolean {
  return body.t === 'presence' || body.t === 'leave' || (body.t === 'bye' && body.sid === undefined)
}

/** Body types that may travel to an inbox (a sid-less 'bye' is both: also a watcher leaving before its offer). */
export function isAddressedBody(body: { t: string }): boolean {
  return body.t !== 'presence' && body.t !== 'leave'
}

interface BrokerLink {
  client: MqttClient
  status: MqttStatus
  /** decrypt budget (token bucket) */
  tokens: number
  lastRefill: number
  /** decrypts queued or running for this broker */
  pending: number
  /** per broker, so a flooding broker cannot delay the others */
  rxChain: Promise<void>
  received: number
  firstDeliveries: number
  throttled: number
  throttledAt: number
  junk: number
}

interface QueuedMessage {
  topic: string
  data: Uint8Array
  createdAt: number
  sentTo: Set<BrokerLink>
}

/** Checks the decrypted envelope shape (not the timestamp window). Returns null if anything is off. */
export function parseEnvelope(value: unknown): SignalEnvelope | null {
  if (typeof value !== 'object' || value === null) return null
  const env = value as Record<string, unknown>
  if (env.v !== PROTOCOL_VERSION) return null
  if (typeof env.id !== 'string' || !MESSAGE_ID_RE.test(env.id)) return null
  if (typeof env.from !== 'string' || !PEER_ID_RE.test(env.from)) return null
  if (env.to !== undefined && (typeof env.to !== 'string' || !PEER_ID_RE.test(env.to))) return null
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null
  const body = env.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  if (typeof (body as Record<string, unknown>).t !== 'string') return null
  return value as SignalEnvelope
}

/** Shape check + timestamp within ±MAX_CLOCK_SKEW_MS of `now`. Returns null if anything is off. */
export function validateEnvelope(value: unknown, now: number = Date.now()): SignalEnvelope | null {
  const env = parseEnvelope(value)
  if (!env || Math.abs(now - env.ts) > MAX_CLOCK_SKEW_MS) return null
  return env
}

export class SignalingRoom implements ISignalingRoom {
  /**
   * Third argument (not part of ISignalingRoom, safe to ignore): true = the message arrived on the broadcast topic,
   * false = it was addressed to us. Lets the tunnel tell a sharer's broadcast "stream ended" bye from a watcher's
   * addressed sid-less bye.
   */
  onSignal: (from: string, body: SignalBody, broadcast?: boolean) => void = () => {}
  onStatus: (status: SignalingStatus) => void = () => {}
  /**
   * Not part of ISignalingRoom: an authentic message was dropped because the sender's clock differs from ours by
   * more than MAX_CLOCK_SKEW_MS (offset = sender − us, in ms). Called at most every 10 s.
   */
  onClockSkew: (offsetMs: number) => void = () => {}

  private readonly _selfId: string
  private readonly _code: string
  private readonly key: CryptoKey
  private readonly base: string
  private readonly broadcastTopic: string
  private readonly ownTopic: string
  private readonly subscribed: Set<string>
  private readonly links: BrokerLink[]
  private readonly queue: QueuedMessage[] = []
  /** insertion-ordered set used as LRU of recently seen message ids */
  private readonly seen = new Set<string>()
  private txChain: Promise<void> = Promise.resolve()
  private closed = false
  private lastConnected = 0
  private delivered = 0
  private duplicates = 0
  private dropped = 0
  private sent = 0
  private clockSkewDrops = 0
  private lastSkewMs: number | null = null
  private lastSkewNotify = -Infinity
  private floodWarned = false

  private constructor(opts: { selfId: string; code: string; key: CryptoKey; base: string; clients: MqttClient[] }) {
    this._selfId = opts.selfId
    this._code = opts.code
    this.key = opts.key
    this.base = opts.base
    this.broadcastTopic = `${opts.base}/b`
    this.ownTopic = `${opts.base}/p/${opts.selfId}`
    this.subscribed = new Set([this.ownTopic, this.broadcastTopic])
    const now = performance.now()
    this.links = opts.clients.map((client) => ({
      client,
      status: client.status,
      tokens: DECRYPT_BURST,
      lastRefill: now,
      pending: 0,
      rxChain: Promise.resolve(),
      received: 0,
      firstDeliveries: 0,
      throttled: 0,
      throttledAt: -Infinity,
      junk: 0,
    }))
  }

  /** Derives keys (PBKDF2), connects to all brokers, subscribes. Resolves once keys are derived (does not wait for brokers). */
  static async open(opts: RoomOptions): Promise<SignalingRoom> {
    const code = typeof opts?.code === 'string' ? normalizeCode(opts.code) : null
    if (!code) throw new Error('Ungültiger Code.')
    if (typeof opts.selfId !== 'string' || !PEER_ID_RE.test(opts.selfId)) throw new TypeError('SignalingRoom: invalid selfId')

    // Validate and deduplicate broker URLs before the (slow) key derivation.
    const clients: MqttClient[] = []
    const seenEndpoints = new Set<string>()
    for (const url of Array.isArray(opts.brokers) ? opts.brokers : []) {
      try {
        const ep = parseBrokerUrl(url)
        const id = `${ep.wsUrl}\n${ep.username ?? ''}\n${ep.password ?? ''}`
        if (seenEndpoints.has(id)) continue
        seenEndpoints.add(id)
        clients.push(new MqttClient(url.trim(), opts.mqtt))
      } catch {
        console.warn('[room] ignoring invalid broker URL:', url)
      }
    }
    if (clients.length === 0) throw new Error('Keine gültigen Signaling-Server konfiguriert (Erweitert → Broker).')

    const keys = await deriveRoomKeys(code)
    const room = new SignalingRoom({ selfId: opts.selfId, code, key: keys.key, base: keys.topic, clients })
    room.start()
    return room
  }

  get selfId(): string {
    return this._selfId
  }

  get code(): string {
    return this._code
  }

  send(body: SignalBody, to?: string): void {
    if (this.closed) return
    if (typeof body !== 'object' || body === null || typeof body.t !== 'string') throw new TypeError('SignalingRoom.send: invalid body')
    const dest = to ?? undefined
    if (dest !== undefined && (typeof dest !== 'string' || !PEER_ID_RE.test(dest))) throw new TypeError('SignalingRoom.send: invalid recipient id')
    // Broadcast-only bodies are never addressed and everything else is never broadcast (the receiver enforces both).
    if (dest === undefined ? !isBroadcastBody(body) : !isAddressedBody(body)) {
      throw new TypeError(`SignalingRoom.send: '${body.t}' ${dest === undefined ? 'must be addressed' : 'is broadcast-only'}`)
    }
    const topic = dest !== undefined ? `${this.base}/p/${dest}` : this.broadcastTopic
    const id = randomId(8)
    const ts = Date.now()
    const env: SignalEnvelope =
      dest !== undefined ? { v: PROTOCOL_VERSION, id, from: this._selfId, to: dest, ts, body } : { v: PROTOCOL_VERSION, id, from: this._selfId, ts, body }
    // Periodic / refusal traffic may be dropped first when a broker connection is congested (never offers/ICE).
    const low = body.t === 'presence' || body.t === 'reject'
    // Chained so messages leave in call order even though sealing is async.
    this.txChain = this.txChain.then(async () => {
      let data: Uint8Array
      try {
        // AAD = the destination topic: the ciphertext only authenticates on the one topic it is published to.
        data = await seal(this.key, env, topic)
      } catch (err) {
        console.warn('[room] could not encrypt message', err)
        return
      }
      if (data.length > MAX_PAYLOAD_BYTES) {
        console.warn(`[room] dropping oversized '${body.t}' message (${data.length} bytes)`)
        return
      }
      this.dispatch(topic, data, low)
    })
  }

  status(): SignalingStatus {
    let connected = 0
    for (const l of this.links) if (l.status === 'connected') connected++
    return { connected, total: this.links.length }
  }

  /** Closes all broker connections. Messages already passed to send() are still flushed first. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    const finish = (): void => {
      for (const l of this.links) l.client.close()
    }
    this.txChain.then(finish, finish)
  }

  diagnostics(): RoomDiagnostics {
    const now = performance.now()
    return {
      brokers: this.links.map((l) => ({
        url: l.client.endpointUrl,
        status: l.status,
        received: l.received,
        firstDeliveries: l.firstDeliveries,
        ignored: now - l.throttledAt < 1000,
        throttled: l.throttled,
        junk: l.junk,
        lastError: l.client.lastError,
      })),
      delivered: this.delivered,
      duplicates: this.duplicates,
      dropped: this.dropped,
      clockSkewDrops: this.clockSkewDrops,
      lastSkewMs: this.lastSkewMs,
      sent: this.sent,
      queued: this.queue.length,
    }
  }

  // ── internals ──

  private start(): void {
    for (const link of this.links) {
      const client = link.client
      for (const topic of this.subscribed) client.subscribe(topic)
      client.onStatus = (s) => this.handleClientStatus(link, s)
      client.onMessage = (topic, payload) => this.handleRaw(link, topic, payload)
      client.connect()
    }
  }

  private handleClientStatus(link: BrokerLink, status: MqttStatus): void {
    link.status = status
    if (this.closed) return
    if (status === 'connected') this.flushQueue(link)
    const st = this.status()
    if (st.connected === this.lastConnected) return
    this.lastConnected = st.connected
    try {
      this.onStatus(st)
    } catch (err) {
      console.error('[room] onStatus handler failed', err)
    }
  }

  private dispatch(topic: string, data: Uint8Array, low: boolean): void {
    let published = 0
    for (const link of this.links) {
      if (link.status === 'connected' && link.client.publish(topic, data, low)) published++
    }
    if (published > 0) {
      this.sent++
      return
    }
    if (this.closed) return
    // No broker reachable right now: keep it briefly and hand it to brokers as they connect.
    const now = Date.now()
    this.pruneQueue(now)
    if (this.queue.length >= QUEUE_MAX) this.queue.shift()
    this.queue.push({ topic, data, createdAt: now, sentTo: new Set() })
  }

  /** Publishes queued messages to a broker that just connected (each message at most once per broker). */
  private flushQueue(link: BrokerLink): void {
    if (this.queue.length === 0) return
    this.pruneQueue(Date.now())
    for (const msg of this.queue) {
      if (msg.sentTo.has(link)) continue
      if (!link.client.publish(msg.topic, msg.data)) break
      if (msg.sentTo.size === 0) this.sent++
      msg.sentTo.add(link)
    }
    this.pruneQueue(Date.now())
  }

  private pruneQueue(now: number): void {
    let write = 0
    for (const msg of this.queue) {
      if (now - msg.createdAt > QUEUE_TTL_MS || msg.sentTo.size >= this.links.length) continue
      this.queue[write++] = msg
    }
    this.queue.length = write
  }

  private handleRaw(link: BrokerLink, topic: string, payload: Uint8Array): void {
    if (this.closed) return
    link.received++
    // Cheap checks first: they cost nothing and never count against the decrypt budget.
    if (payload.length > MAX_INCOMING_BYTES || payload.length < MIN_SEALED_BYTES || !this.subscribed.has(topic)) {
      this.dropped++
      return
    }
    if (link.pending >= MAX_PENDING_DECODES || !this.takeToken(link)) {
      // Flood: drop this one copy only. Authentic traffic also arrives over the other brokers and is retried.
      link.throttled++
      link.throttledAt = performance.now()
      if (!this.floodWarned) {
        this.floodWarned = true
        console.warn(`[room] flood from ${link.client.endpointUrl} — dropping excess packets`)
      }
      return
    }
    link.pending++
    // Serialized so messages from one broker keep their order through the async decryption.
    link.rxChain = link.rxChain.then(() => this.decode(link, topic, payload))
  }

  /** Token bucket of decrypt attempts per broker. */
  private takeToken(link: BrokerLink): boolean {
    const now = performance.now()
    link.tokens = Math.min(DECRYPT_BURST, link.tokens + ((now - link.lastRefill) * DECRYPT_RATE_PER_SEC) / 1000)
    link.lastRefill = now
    if (link.tokens < 1) return false
    link.tokens -= 1
    return true
  }

  /** The topic an envelope must arrive on — the exact mirror of send()'s routing. */
  private topicFor(env: SignalEnvelope): string {
    return env.to !== undefined ? `${this.base}/p/${env.to}` : this.broadcastTopic
  }

  private async decode(link: BrokerLink, topic: string, payload: Uint8Array): Promise<void> {
    try {
      const raw = await unseal<unknown>(this.key, payload, topic)
      if (this.closed) return
      if (raw === null) {
        link.junk++
        this.dropped++
        return
      }
      link.tokens = Math.min(DECRYPT_BURST, link.tokens + 1) // authentic: the decrypt is not charged
      const env = parseEnvelope(raw)
      if (!env || env.from === this._selfId || topic !== this.topicFor(env)) {
        this.dropped++
        return
      }
      // Each topic only carries its own body types (e.g. no joins on the broadcast topic, no presence in an inbox).
      const broadcast = topic === this.broadcastTopic
      const b = env.body as { t: string; sid?: unknown }
      if (broadcast ? !isBroadcastBody(b) : !isAddressedBody(b)) {
        this.dropped++
        return
      }
      const skew = env.ts - Date.now()
      if (Math.abs(skew) > CLOCK_SKEW_NOTE_MS) this.lastSkewMs = Math.round(skew)
      if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
        this.clockSkewDrops++
        this.notifyClockSkew(skew)
        return
      }
      if (this.seen.has(env.id)) {
        // refresh LRU position
        this.seen.delete(env.id)
        this.seen.add(env.id)
        this.duplicates++
        return
      }
      this.remember(env.id)
      this.delivered++
      link.firstDeliveries++
      this.onSignal(env.from, env.body, broadcast)
    } catch (err) {
      console.error('[room] onSignal handler failed', err)
    } finally {
      link.pending--
    }
  }

  private notifyClockSkew(skew: number): void {
    const now = performance.now()
    if (now - this.lastSkewNotify < CLOCK_SKEW_NOTIFY_INTERVAL_MS) return
    this.lastSkewNotify = now
    console.warn(`[room] dropping authentic messages: the sender's clock is off by ${Math.round(skew / 60_000)} min`)
    try {
      this.onClockSkew(Math.round(skew))
    } catch (err) {
      console.error('[room] onClockSkew handler failed', err)
    }
  }

  private remember(id: string): void {
    this.seen.add(id)
    if (this.seen.size > DEDUPE_CAPACITY) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }
}

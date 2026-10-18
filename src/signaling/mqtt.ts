// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only) with auto-reconnect.
// Runs in WebView2 and Node 24 (global WebSocket). Encoding rules verified against the default public
// brokers (see docs/ARCHITECTURE.md §4.3):
//   * subprotocol 'mqtt', binaryType 'arraybuffer', URL userinfo → MQTT username/password
//   * CONNECT level 4, clean session, keepalive 30 s, client id "st" + 20 hex (new per connection)
//   * SUBSCRIBE fixed header 0x82 (not 0x80), QoS 0; re-subscribed after every (re)connect
//   * PUBLISH QoS 0 = 0x30 + topic + payload; incoming QoS>0 PUBLISH carries a 2-byte packet id
//   * one WS message may contain several MQTT packets or a fragment → buffering stream parser
//   * CONNACK timeout 4 s (HiveMQ silently hangs on ~25 % of connects), PINGREQ every 20 s,
//     reconnect if nothing arrives within 10 s after a ping
//   * exponential backoff 0.5 s → 15 s, ±20 % jitter
import { randomId } from '../core/crypto.ts'

export type MqttStatus = 'connecting' | 'connected' | 'disconnected'

/** Largest payload we publish (public brokers cap frames at ~64 KB). */
export const MAX_PAYLOAD_BYTES = 60 * 1024
/** Incoming packets with a larger body are skipped without buffering them. */
export const MAX_INCOMING_PACKET_BYTES = 64 * 1024 + 1024
/** Largest value the 4-byte remaining-length varint can carry. */
export const MAX_REMAINING_LENGTH = 268_435_455

/** The subset of the WebSocket API the client uses (lets tests inject a fake). */
export interface WebSocketLike {
  binaryType: string
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike

export interface MqttClientOptions {
  /** MQTT keepalive announced in CONNECT, seconds (default 30). */
  keepaliveSec?: number
  /** PINGREQ interval while connected (default 20 000 ms). */
  pingIntervalMs?: number
  /** Reconnect if no packet arrives within this time after a PINGREQ (default 10 000 ms). */
  pingTimeoutMs?: number
  /** Max time for the WebSocket handshake (TCP+TLS+upgrade) (default 10 000 ms). */
  openTimeoutMs?: number
  /** Max time between WebSocket open and CONNACK (default 4 000 ms). */
  connackTimeoutMs?: number
  /** First reconnect delay (default 500 ms); doubles per failed attempt. */
  backoffMinMs?: number
  /** Reconnect delay cap (default 15 000 ms). */
  backoffMaxMs?: number
  /** A connection must stay up this long before the backoff resets (default 10 000 ms). */
  stableAfterMs?: number
  /** Sustained publish rate per connection (default 8/s); excess is delayed, not dropped. */
  publishRatePerSec?: number
  /** Publish burst allowance (default 10). */
  publishBurst?: number
  /** Defaults to the global WebSocket. */
  createWebSocket?: WebSocketFactory
}

const WS_OPEN = 1
const MAX_OUT_QUEUE = 100
const EMPTY = new Uint8Array(0)
const PINGREQ = Uint8Array.of(0xc0, 0x00)
const DISCONNECT = Uint8Array.of(0xe0, 0x00)
const PACKET_CONNACK = 2
const PACKET_PUBLISH = 3
const PACKET_SUBACK = 9
const PACKET_PINGRESP = 13

const encoder = new TextEncoder()
const topicDecoder = new TextDecoder()

// ───────────────────────── Encoding ─────────────────────────

/** MQTT remaining length: 7 bits per byte, least significant group first, bit 7 = more bytes follow. */
export function encodeRemainingLength(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMAINING_LENGTH) throw new RangeError(`MQTT: remaining length out of range: ${n}`)
  const out: number[] = []
  let rest = n
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest > 0) byte |= 0x80
    out.push(byte)
  } while (rest > 0)
  return out
}

/**
 * Decodes a remaining length starting at `offset`. Returns null if more bytes are needed;
 * throws on a malformed (> 4 byte) varint.
 */
export function decodeRemainingLength(buf: Uint8Array, offset: number): { value: number; bytes: number } | null {
  let value = 0
  let mul = 1
  for (let i = 0; i < 4; i++) {
    if (offset + i >= buf.length) return null
    const byte = buf[offset + i]
    value += (byte & 0x7f) * mul
    if ((byte & 0x80) === 0) return { value, bytes: i + 1 }
    mul *= 128
  }
  throw new Error('MQTT: malformed remaining length')
}

function utf8Field(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  if (bytes.length > 0xffff) throw new RangeError('MQTT: string field too long')
  const out = new Uint8Array(2 + bytes.length)
  out[0] = bytes.length >> 8
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

function packet(header: number, parts: Uint8Array[]): Uint8Array {
  let bodyLength = 0
  for (const p of parts) bodyLength += p.length
  const rl = encodeRemainingLength(bodyLength)
  const out = new Uint8Array(1 + rl.length + bodyLength)
  out[0] = header
  out.set(rl, 1)
  let pos = 1 + rl.length
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}

export interface ConnectParams {
  clientId: string
  username?: string
  password?: string
  keepaliveSec: number
}

/** CONNECT: protocol "MQTT" level 4, clean session, optional username/password. */
export function encodeConnect(p: ConnectParams): Uint8Array {
  if (!p.clientId) throw new TypeError('MQTT: empty client id')
  // MQTT 3.1.1: a password requires a username.
  const username = p.username ?? (p.password !== undefined ? '' : undefined)
  let flags = 0x02
  if (username !== undefined) flags |= 0x80
  if (p.password !== undefined) flags |= 0x40
  const keepalive = Math.max(0, Math.min(0xffff, Math.round(p.keepaliveSec)))
  const variableHeader = Uint8Array.of(0, 4, 0x4d, 0x51, 0x54, 0x54, 4, flags, keepalive >> 8, keepalive & 0xff)
  const parts: Uint8Array[] = [variableHeader, utf8Field(p.clientId)]
  if (username !== undefined) parts.push(utf8Field(username))
  if (p.password !== undefined) parts.push(utf8Field(p.password))
  return packet(0x10, parts)
}

/** SUBSCRIBE (fixed header 0x82!) with requested QoS 0 for every topic. */
export function encodeSubscribe(packetId: number, topics: string[]): Uint8Array {
  if (topics.length === 0) throw new TypeError('MQTT: SUBSCRIBE without topics')
  const parts: Uint8Array[] = [Uint8Array.of(packetId >> 8, packetId & 0xff)]
  for (const t of topics) parts.push(utf8Field(t), Uint8Array.of(0))
  return packet(0x82, parts)
}

/** PUBLISH QoS 0 (no packet id), single allocation. */
export function encodePublish(topic: string, payload: Uint8Array): Uint8Array {
  const t = encoder.encode(topic)
  if (t.length === 0 || t.length > 0xffff) throw new RangeError('MQTT: bad topic length')
  const bodyLength = 2 + t.length + payload.length
  const rl = encodeRemainingLength(bodyLength)
  const out = new Uint8Array(1 + rl.length + bodyLength)
  out[0] = 0x30
  out.set(rl, 1)
  let pos = 1 + rl.length
  out[pos++] = t.length >> 8
  out[pos++] = t.length & 0xff
  out.set(t, pos)
  out.set(payload, pos + t.length)
  return out
}

/** Parses a PUBLISH body; the returned payload is a copy (safe to keep). Null if malformed. */
export function parsePublish(header: number, body: Uint8Array): { topic: string; payload: Uint8Array } | null {
  if (body.length < 2) return null
  const topicLength = (body[0] << 8) | body[1]
  const qos = (header >> 1) & 3
  const payloadStart = 2 + topicLength + (qos > 0 ? 2 : 0)
  if (payloadStart > body.length || qos === 3) return null
  let topic: string
  try {
    topic = topicDecoder.decode(body.subarray(2, 2 + topicLength))
  } catch {
    return null
  }
  return { topic, payload: body.slice(payloadStart) }
}

// ───────────────────────── Stream parser ─────────────────────────

/**
 * Splits a byte stream into MQTT packets. Feed it every WebSocket message; it buffers fragments and
 * emits each complete packet. The body handed to `onPacket` is a view that is only valid during the
 * callback — copy it to keep it. Oversized packets are skipped without being buffered.
 */
export class MqttParser {
  /** growable buffer for fragments; bytes [0, len) are valid */
  private store: Uint8Array = EMPTY
  private len = 0
  private skip = 0
  private generation = 0
  private readonly onPacket: (header: number, body: Uint8Array) => void
  private readonly maxPacketBytes: number

  constructor(onPacket: (header: number, body: Uint8Array) => void, maxPacketBytes = MAX_INCOMING_PACKET_BYTES) {
    this.onPacket = onPacket
    this.maxPacketBytes = maxPacketBytes
  }

  /** Throws on a malformed stream (caller drops the connection). */
  push(chunk: Uint8Array): void {
    let data = chunk
    if (this.skip > 0) {
      if (data.length <= this.skip) {
        this.skip -= data.length
        return
      }
      data = data.subarray(this.skip)
      this.skip = 0
    }
    if (data.length === 0) return
    // Common case (nothing buffered): parse straight from the frame without copying.
    let buf: Uint8Array
    if (this.len === 0) buf = data
    else {
      this.reserve(this.len + data.length)
      this.store.set(data, this.len)
      this.len += data.length
      buf = this.store.subarray(0, this.len)
    }
    const generation = this.generation
    let pos = 0
    while (pos < buf.length) {
      const rl = decodeRemainingLength(buf, pos + 1)
      if (rl === null) break
      const start = pos + 1 + rl.bytes
      if (rl.value > this.maxPacketBytes) {
        const available = buf.length - start
        if (available >= rl.value) {
          pos = start + rl.value
          continue
        }
        this.skip = rl.value - available
        pos = buf.length
        break
      }
      const end = start + rl.value
      if (end > buf.length) break
      const header = buf[pos]
      pos = end
      this.onPacket(header, buf.subarray(start, end))
      if (generation !== this.generation) return // reset() from inside the callback
    }
    const rest = buf.length - pos
    if (rest === 0) {
      this.len = 0
      if (this.store.length > 4 * this.maxPacketBytes) this.store = EMPTY
    } else if (buf === data) {
      // Keep the fragment in our own buffer so the frame's ArrayBuffer is not retained.
      this.reserve(rest)
      this.store.set(data.subarray(pos), 0)
      this.len = rest
    } else if (pos > 0) {
      this.store.copyWithin(0, pos, this.len)
      this.len = rest
    }
  }

  /** Drops buffered data; a push() in progress stops after the current packet. */
  reset(): void {
    this.len = 0
    this.skip = 0
    this.generation++
  }

  private reserve(size: number): void {
    if (this.store.length >= size) return
    const next = new Uint8Array(Math.max(size, this.store.length * 2, 1024))
    next.set(this.store.subarray(0, this.len), 0)
    this.store = next
  }
}

// ───────────────────────── URL handling ─────────────────────────

export interface BrokerEndpoint {
  /** wss URL without userinfo / fragment */
  wsUrl: string
  username?: string
  password?: string
}

function decodeUserinfo(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Validates a broker URL and moves its userinfo into MQTT credentials. Throws TypeError if invalid. */
export function parseBrokerUrl(raw: string): BrokerEndpoint {
  if (typeof raw !== 'string') throw new TypeError('MQTT: broker URL must be a string')
  const u = new URL(raw.trim())
  // wss:// only: the app's CSP (connect-src … wss:) blocks ws://, and credentials must never travel in clear text.
  if (u.protocol !== 'wss:') throw new TypeError(`MQTT: unsupported broker URL scheme: ${u.protocol} (wss:// required)`)
  const username = u.username ? decodeUserinfo(u.username) : undefined
  const password = u.password ? decodeUserinfo(u.password) : undefined
  u.username = ''
  u.password = ''
  u.hash = ''
  return { wsUrl: u.toString(), username, password }
}

const defaultFactory: WebSocketFactory = (url, protocols) => {
  if (typeof WebSocket === 'undefined') throw new Error('WebSocket is not available')
  return new WebSocket(url, protocols) as unknown as WebSocketLike
}

// ───────────────────────── Client ─────────────────────────

type Timer = ReturnType<typeof setTimeout>

export class MqttClient {
  onMessage: (topic: string, payload: Uint8Array) => void = () => {}
  onStatus: (status: MqttStatus) => void = () => {}

  private readonly rawUrl: string
  private readonly endpoint: BrokerEndpoint
  private readonly createWebSocket: WebSocketFactory
  private readonly keepaliveSec: number
  private readonly pingIntervalMs: number
  private readonly pingTimeoutMs: number
  private readonly openTimeoutMs: number
  private readonly connackTimeoutMs: number
  private readonly backoffMinMs: number
  private readonly backoffMaxMs: number
  private readonly stableAfterMs: number
  private readonly publishRate: number
  private readonly publishBurst: number

  private readonly topics = new Set<string>()
  private readonly parser: MqttParser
  private ws: WebSocketLike | null = null
  private state: MqttStatus = 'disconnected'
  private connected = false
  private stopped = true
  private attempt = 0
  private connectedAt = 0
  private nextPacketId = 1
  /** handshake / CONNACK timeout */
  private stepTimer: Timer | undefined
  private reconnectTimer: Timer | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pongTimer: Timer | undefined
  private drainTimer: Timer | undefined
  private tokens = 0
  private lastRefill = 0
  /** rate-limited backlog; `low` entries (announcements, refusals) are evicted first when it overflows */
  private readonly outQueue: Array<{ pkt: Uint8Array; low: boolean }> = []
  private lastErrorText = ''

  /** Throws TypeError for an invalid / non-wss URL. */
  constructor(url: string, options: MqttClientOptions = {}) {
    this.rawUrl = url
    this.endpoint = parseBrokerUrl(url)
    this.createWebSocket = options.createWebSocket ?? defaultFactory
    this.keepaliveSec = options.keepaliveSec ?? 30
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000
    this.pingTimeoutMs = options.pingTimeoutMs ?? 10_000
    this.openTimeoutMs = options.openTimeoutMs ?? 10_000
    this.connackTimeoutMs = options.connackTimeoutMs ?? 4_000
    this.backoffMinMs = options.backoffMinMs ?? 500
    this.backoffMaxMs = options.backoffMaxMs ?? 15_000
    this.stableAfterMs = options.stableAfterMs ?? 10_000
    this.publishRate = Math.max(0.1, options.publishRatePerSec ?? 8)
    this.publishBurst = Math.max(1, options.publishBurst ?? 10)
    this.parser = new MqttParser((header, body) => this.handlePacket(header, body))
  }

  /** The URL as configured (may contain userinfo). */
  get url(): string {
    return this.rawUrl
  }

  /** WebSocket URL without credentials (safe to display). */
  get endpointUrl(): string {
    return this.endpoint.wsUrl
  }

  get status(): MqttStatus {
    return this.state
  }

  /** Last connection problem (diagnostics only, English). */
  get lastError(): string {
    return this.lastErrorText
  }

  /** Starts connecting; reconnects with backoff until close(). */
  connect(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  /** Remembered and re-sent after every reconnect. */
  subscribe(topic: string): void {
    if (typeof topic !== 'string' || topic.length === 0 || this.topics.has(topic)) return
    this.topics.add(topic)
    if (this.connected && this.ws) this.sendRaw(this.ws, encodeSubscribe(this.packetId(), [topic]))
  }

  /**
   * QoS 0 publish; returns false if not currently connected. Bursts beyond the rate limit are delayed briefly.
   * `low` = may be dropped first if the backlog overflows (it never evicts normal-priority packets).
   */
  publish(topic: string, payload: Uint8Array, low = false): boolean {
    const ws = this.ws
    if (!this.connected || !ws) return false
    if (payload.length > MAX_PAYLOAD_BYTES) return false
    let pkt: Uint8Array
    try {
      pkt = encodePublish(topic, payload)
    } catch {
      return false
    }
    this.refillTokens()
    if (this.outQueue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return this.sendRaw(ws, pkt)
    }
    if (this.outQueue.length >= MAX_OUT_QUEUE) {
      const lowIdx = this.outQueue.findIndex((q) => q.low)
      if (lowIdx >= 0) this.outQueue.splice(lowIdx, 1)
      else if (low) return true // full of important packets: drop this low-priority one instead
      else this.outQueue.shift()
    }
    this.outQueue.push({ pkt, low })
    this.scheduleDrain()
    return true
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.teardown(true)
    this.setStatus('disconnected')
  }

  // ── connection lifecycle ──

  private open(): void {
    this.reconnectTimer = undefined
    if (this.stopped) return
    this.setStatus('connecting')
    let ws: WebSocketLike
    try {
      ws = this.createWebSocket(this.endpoint.wsUrl, ['mqtt'])
      ws.binaryType = 'arraybuffer'
    } catch (err) {
      this.lastErrorText = `WebSocket: ${String(err)}`
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.connected = false
    this.parser.reset()
    this.stepTimer = setTimeout(() => this.fail(ws, 'WebSocket handshake timeout'), this.openTimeoutMs)
    ws.onopen = () => {
      if (this.ws !== ws) return
      clearTimeout(this.stepTimer)
      this.stepTimer = setTimeout(() => this.fail(ws, 'CONNACK timeout'), this.connackTimeoutMs)
      this.sendRaw(
        ws,
        encodeConnect({
          clientId: 'st' + randomId(10),
          username: this.endpoint.username,
          password: this.endpoint.password,
          keepaliveSec: this.keepaliveSec,
        }),
      )
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      const data = ev.data
      let bytes: Uint8Array
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      else {
        this.fail(ws, 'unexpected text frame')
        return
      }
      try {
        this.parser.push(bytes)
      } catch (err) {
        this.fail(ws, String(err))
      }
    }
    ws.onerror = () => this.fail(ws, 'WebSocket error')
    ws.onclose = () => this.fail(ws, 'WebSocket closed')
  }

  private handlePacket(header: number, body: Uint8Array): void {
    const ws = this.ws
    if (!ws) return
    // Any packet proves the connection is alive.
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
    }
    switch (header >> 4) {
      case PACKET_CONNACK: {
        if (this.connected || body.length < 2) {
          this.fail(ws, 'unexpected CONNACK')
          return
        }
        if (body[1] !== 0) {
          this.fail(ws, `CONNACK refused (rc=${body[1]})`)
          return
        }
        this.onConnack(ws)
        return
      }
      case PACKET_PUBLISH: {
        if (!this.connected) return
        const msg = parsePublish(header, body)
        if (!msg) return
        try {
          this.onMessage(msg.topic, msg.payload)
        } catch (err) {
          console.error('[mqtt] onMessage handler failed', err)
        }
        return
      }
      case PACKET_SUBACK: {
        for (let i = 2; i < body.length; i++) {
          if (body[i] === 0x80) {
            this.fail(ws, 'SUBSCRIBE refused by broker')
            return
          }
        }
        return
      }
      case PACKET_PINGRESP:
      default:
        return
    }
  }

  private onConnack(ws: WebSocketLike): void {
    clearTimeout(this.stepTimer)
    this.stepTimer = undefined
    this.connected = true
    this.connectedAt = Date.now()
    this.lastErrorText = ''
    this.tokens = this.publishBurst
    this.lastRefill = performance.now()
    // One SUBSCRIBE per topic (the form verified against all default brokers).
    for (const topic of this.topics) {
      if (!this.sendRaw(ws, encodeSubscribe(this.packetId(), [topic]))) return
    }
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs)
    this.setStatus('connected')
  }

  private ping(): void {
    const ws = this.ws
    if (!this.connected || !ws) return
    if (!this.sendRaw(ws, PINGREQ)) return
    if (this.pongTimer === undefined) this.pongTimer = setTimeout(() => this.fail(ws, 'PINGRESP timeout'), this.pingTimeoutMs)
  }

  /** Drops the current connection (if `ws` is still current) and schedules a reconnect. */
  private fail(ws: WebSocketLike, reason: string): void {
    if (this.ws !== ws) return
    this.lastErrorText = reason
    this.teardown(false)
    if (!this.stopped) this.scheduleReconnect()
  }

  private teardown(graceful: boolean): void {
    const ws = this.ws
    this.ws = null
    clearTimeout(this.stepTimer)
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
    clearTimeout(this.drainTimer)
    this.stepTimer = this.pingTimer = this.pongTimer = this.drainTimer = undefined
    const wasConnected = this.connected
    this.connected = false
    this.parser.reset()
    if (wasConnected && Date.now() - this.connectedAt >= this.stableAfterMs) this.attempt = 0
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      if (graceful && wasConnected && ws.readyState === WS_OPEN) {
        try {
          // Final flush ignores the rate limit; DISCONNECT tells the broker to drop the session cleanly.
          for (const q of this.outQueue) ws.send(q.pkt)
          ws.send(DISCONNECT)
        } catch {
          /* socket already gone */
        }
      }
      try {
        ws.close(1000)
      } catch {
        /* ignore */
      }
    }
    this.outQueue.length = 0
  }

  private scheduleReconnect(): void {
    this.setStatus('disconnected')
    if (this.stopped || this.reconnectTimer !== undefined) return
    const base = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** this.attempt)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.attempt = Math.min(this.attempt + 1, 30)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  // ── sending ──

  private sendRaw(ws: WebSocketLike, data: Uint8Array): boolean {
    try {
      ws.send(data)
      return true
    } catch (err) {
      this.fail(ws, `send failed: ${String(err)}`)
      return false
    }
  }

  private packetId(): number {
    const id = this.nextPacketId
    this.nextPacketId = id >= 0xffff ? 1 : id + 1
    return id
  }

  private refillTokens(): void {
    const now = performance.now()
    this.tokens = Math.min(this.publishBurst, this.tokens + ((now - this.lastRefill) * this.publishRate) / 1000)
    this.lastRefill = now
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined) return
    const waitMs = Math.max(0, ((1 - this.tokens) * 1000) / this.publishRate)
    this.drainTimer = setTimeout(() => this.drain(), Math.ceil(waitMs))
  }

  private drain(): void {
    this.drainTimer = undefined
    const ws = this.ws
    if (!this.connected || !ws) return
    this.refillTokens()
    while (this.outQueue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      const pkt = (this.outQueue.shift() as { pkt: Uint8Array }).pkt
      if (!this.sendRaw(ws, pkt)) return
    }
    if (this.outQueue.length > 0) this.scheduleDrain()
  }

  private setStatus(status: MqttStatus): void {
    if (this.state === status) return
    this.state = status
    try {
      this.onStatus(status)
    } catch (err) {
      console.error('[mqtt] onStatus handler failed', err)
    }
  }
}

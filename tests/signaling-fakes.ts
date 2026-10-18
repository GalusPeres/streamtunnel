// Test helpers: an in-memory MQTT 3.1.1 "broker" network and a fake WebSocket that talks real MQTT
// bytes to it. Used by signaling-mqtt.test.ts and signaling-room.test.ts (not a test file itself).
import { MqttParser, encodePublish, encodeRemainingLength } from '../src/signaling/mqtt.ts'
import type { WebSocketFactory, WebSocketLike } from '../src/signaling/mqtt.ts'

const dec = new TextDecoder()

export interface ConnectRecord {
  clientId: string
  username?: string
  password?: string
  keepalive: number
  flags: number
  protocols: string[]
  url: string
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls `cond` every 5 ms until true or the timeout expires (test helper only). */
export async function waitFor(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await delay(5)
  }
}

function readString(body: Uint8Array, pos: number): [string, number] {
  const len = (body[pos] << 8) | body[pos + 1]
  return [dec.decode(body.subarray(pos + 2, pos + 2 + len)), pos + 2 + len]
}

function pkt(header: number, body: number[]): Uint8Array {
  return Uint8Array.from([header, ...encodeRemainingLength(body.length), ...body])
}

export class FakeSocket implements WebSocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly url: string
  readonly protocols: string[]
  readonly broker: FakeBroker | undefined
  readonly createdAt = Date.now()
  closedByClient = false

  constructor(broker: FakeBroker | undefined, url: string, protocols: string[]) {
    this.broker = broker
    this.url = url
    this.protocols = protocols
    setTimeout(() => {
      if (this.readyState !== 0) return
      if (!broker || broker.down) {
        this.readyState = 3
        this.onerror?.()
        this.onclose?.()
        return
      }
      this.readyState = 1
      broker.attach(this)
      this.onopen?.()
    }, broker?.latencyMs ?? 0)
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: socket not open')
    const copy = data.slice()
    this.broker?.receive(this, copy)
  }

  close(): void {
    if (this.readyState >= 2) return
    this.closedByClient = true
    this.readyState = 3
    this.broker?.detach(this)
    setTimeout(() => this.onclose?.(), 0)
  }

  /** server → client */
  deliver(bytes: Uint8Array, latencyMs: number): void {
    const buf = bytes.slice().buffer
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data: buf })
    }, latencyMs)
  }

  /** server-side abrupt close */
  kill(): void {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.broker?.detach(this)
    setTimeout(() => this.onclose?.(), 0)
  }
}

interface Session {
  parser: MqttParser
  subs: Set<string>
  connected: boolean
}

export class FakeBroker {
  readonly url: string
  /** WebSocket connects fail (like DNS/TLS errors) */
  down = false
  /** 'ok' → CONNACK rc 0; 'hang' → never answer; number → CONNACK with that return code */
  connack: 'ok' | 'hang' | number = 'ok'
  answerPings = true
  latencyMs = 0
  readonly connects: ConnectRecord[] = []
  readonly subscribeHeaders: number[] = []
  readonly subscribedTopics: string[] = []
  readonly published: Array<{ topic: string; payload: Uint8Array }> = []
  pings = 0
  disconnects = 0
  private readonly sessions = new Map<FakeSocket, Session>()

  constructor(url: string) {
    this.url = url
  }

  get socketCount(): number {
    return this.sessions.size
  }

  attach(sock: FakeSocket): void {
    const session: Session = {
      parser: new MqttParser((h, body) => this.handle(sock, session, h, body.slice())),
      subs: new Set(),
      connected: false,
    }
    this.sessions.set(sock, session)
  }

  detach(sock: FakeSocket): void {
    this.sessions.delete(sock)
  }

  receive(sock: FakeSocket, data: Uint8Array): void {
    this.sessions.get(sock)?.parser.push(data)
  }

  /** Publish as if another client sent it. */
  inject(topic: string, payload: Uint8Array): void {
    this.route(topic, payload)
  }

  /** Close every connection from the server side. */
  killAll(): void {
    for (const sock of [...this.sessions.keys()]) sock.kill()
  }

  private route(topic: string, payload: Uint8Array): void {
    const frame = encodePublish(topic, payload)
    for (const [sock, s] of this.sessions) {
      if (!s.connected) continue
      for (const sub of s.subs) {
        if (sub === topic || (sub.endsWith('/#') && topic.startsWith(sub.slice(0, -1)))) {
          sock.deliver(frame, this.latencyMs)
          break
        }
      }
    }
  }

  private handle(sock: FakeSocket, s: Session, header: number, body: Uint8Array): void {
    const type = header >> 4
    if (type === 1) {
      let pos = 0
      const [proto, p1] = readString(body, pos)
      pos = p1
      const level = body[pos++]
      const flags = body[pos++]
      const keepalive = (body[pos] << 8) | body[pos + 1]
      pos += 2
      const [clientId, p2] = readString(body, pos)
      pos = p2
      let username: string | undefined
      let password: string | undefined
      if (flags & 0x80) [username, pos] = readString(body, pos)
      if (flags & 0x40) [password, pos] = readString(body, pos)
      this.connects.push({ clientId, username, password, keepalive, flags, protocols: sock.protocols, url: sock.url })
      if (proto !== 'MQTT' || level !== 4 || !clientId) {
        sock.deliver(pkt(0x20, [0, 2]), this.latencyMs)
        return
      }
      if (this.connack === 'hang') return
      const rc = this.connack === 'ok' ? 0 : this.connack
      if (rc === 0) s.connected = true
      sock.deliver(pkt(0x20, [0, rc]), this.latencyMs)
      return
    }
    if (!s.connected) return
    if (type === 8) {
      this.subscribeHeaders.push(header)
      if (header !== 0x82) {
        sock.kill() // real brokers close on a malformed SUBSCRIBE
        return
      }
      const id = [body[0], body[1]]
      let pos = 2
      const codes: number[] = []
      while (pos < body.length) {
        const [topic, next] = readString(body, pos)
        pos = next + 1
        s.subs.add(topic)
        this.subscribedTopics.push(topic)
        codes.push(0)
      }
      sock.deliver(pkt(0x90, [...id, ...codes]), this.latencyMs)
      return
    }
    if (type === 3) {
      const [topic, pos] = readString(body, 0)
      const payload = body.slice(pos)
      this.published.push({ topic, payload })
      this.route(topic, payload)
      return
    }
    if (type === 12) {
      this.pings++
      if (this.answerPings) sock.deliver(Uint8Array.of(0xd0, 0), this.latencyMs)
      return
    }
    if (type === 14) {
      this.disconnects++
      sock.kill()
    }
  }
}

export class FakeNet {
  readonly brokers = new Map<string, FakeBroker>()
  readonly sockets: FakeSocket[] = []

  add(url: string, latencyMs = 0): FakeBroker {
    const b = new FakeBroker(url)
    b.latencyMs = latencyMs
    this.brokers.set(url, b)
    return b
  }

  readonly factory: WebSocketFactory = (url, protocols) => {
    const sock = new FakeSocket(this.brokers.get(url), url, protocols)
    this.sockets.push(sock)
    return sock
  }

  socketsFor(url: string): FakeSocket[] {
    return this.sockets.filter((s) => s.url === url)
  }
}

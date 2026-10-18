// MQTT encoding, stream parser and client behaviour (against an in-memory fake broker).
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PAYLOAD_BYTES,
  MqttClient,
  MqttParser,
  decodeRemainingLength,
  encodeConnect,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
  parseBrokerUrl,
  parsePublish,
} from '../src/signaling/mqtt.ts'
import type { MqttClientOptions, MqttStatus } from '../src/signaling/mqtt.ts'
import { FakeNet, delay, waitFor } from './signaling-fakes.ts'

const enc = new TextEncoder()
const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)

// ───────────────────────── encoding ─────────────────────────

test('remaining length varint: boundaries encode/decode', () => {
  const cases: Array<[number, number]> = [
    [0, 1],
    [127, 1],
    [128, 2],
    [16383, 2],
    [16384, 3],
    [2097151, 3],
    [2097152, 4],
    [268435455, 4],
  ]
  for (const [n, len] of cases) {
    const v = encodeRemainingLength(n)
    assert.equal(v.length, len, `length of ${n}`)
    const d = decodeRemainingLength(Uint8Array.from([0x30, ...v]), 1)
    assert.deepEqual(d, { value: n, bytes: len })
    // incomplete varint → null (need more bytes)
    if (len > 1) assert.equal(decodeRemainingLength(Uint8Array.from([0x30, ...v.slice(0, len - 1)]), 1), null)
  }
  assert.deepEqual(encodeRemainingLength(128), [0x80, 0x01])
  assert.deepEqual(encodeRemainingLength(16384), [0x80, 0x80, 0x01])
  assert.throws(() => encodeRemainingLength(268435456), RangeError)
  assert.throws(() => encodeRemainingLength(-1), RangeError)
  assert.throws(() => encodeRemainingLength(1.5), RangeError)
  assert.throws(() => decodeRemainingLength(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01), 1), /malformed/)
})

test('CONNECT / SUBSCRIBE / PUBLISH byte layout', () => {
  // CONNECT with username only
  const c = encodeConnect({ clientId: 'st0', username: 'demo', keepaliveSec: 30 })
  assert.deepEqual(
    [...c],
    [0x10, 21, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x82, 0, 30, 0, 3, 0x73, 0x74, 0x30, 0, 4, 0x64, 0x65, 0x6d, 0x6f],
  )
  // no credentials → clean session only
  assert.equal(encodeConnect({ clientId: 'x', keepaliveSec: 30 })[9], 0x02)
  // username + password
  assert.equal(encodeConnect({ clientId: 'x', username: 'u', password: 'p', keepaliveSec: 30 })[9], 0xc2)
  // password without username → empty username is added (3.1.1 requires it)
  const pw = encodeConnect({ clientId: 'x', password: 'p', keepaliveSec: 30 })
  assert.equal(pw[9], 0xc2)
  assert.throws(() => encodeConnect({ clientId: '', keepaliveSec: 30 }))

  // SUBSCRIBE must use 0x82
  const s = encodeSubscribe(0x0102, ['a/b'])
  assert.deepEqual([...s], [0x82, 8, 0x01, 0x02, 0, 3, 0x61, 0x2f, 0x62, 0])

  // PUBLISH QoS0: 0x30, topic, payload, no packet id
  const p = encodePublish('t', Uint8Array.of(9, 8))
  assert.deepEqual([...p], [0x30, 5, 0, 1, 0x74, 9, 8])
  const big = encodePublish('topic', bytes(20000))
  assert.equal(big[0], 0x30)
  assert.deepEqual(decodeRemainingLength(big, 1), { value: 2 + 5 + 20000, bytes: 3 })
})

test('parsePublish: QoS0, QoS1 (packet id skipped), copies payload', () => {
  const body0 = encodePublish('a/b', Uint8Array.of(1, 2, 3)).subarray(2)
  const m0 = parsePublish(0x30, body0)
  assert.ok(m0)
  assert.equal(m0.topic, 'a/b')
  assert.deepEqual([...m0.payload], [1, 2, 3])
  body0[body0.length - 1] = 99
  assert.equal(m0.payload[2], 3, 'payload must be a copy')

  // QoS1: topic, 2-byte packet id, payload
  const body1 = Uint8Array.of(0, 1, 0x78, 0x12, 0x34, 7, 7)
  const m1 = parsePublish(0x32, body1)
  assert.ok(m1)
  assert.equal(m1.topic, 'x')
  assert.deepEqual([...m1.payload], [7, 7])
  assert.equal(parsePublish(0x30, Uint8Array.of(0)), null)
  assert.equal(parsePublish(0x30, Uint8Array.of(0, 9, 1)), null)
})

test('stream parser: 1 byte at a time, odd splits, coalesced', () => {
  const packets = [
    encodePublish('a', bytes(20000)),
    Uint8Array.of(0xd0, 0x00),
    encodePublish('b', bytes(5, 7)),
    Uint8Array.of(0x20, 0x02, 0x00, 0x00),
    encodePublish('c/d', new Uint8Array(0)),
    encodePublish('e', bytes(200, 3)),
  ]
  const all = new Uint8Array(packets.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of packets) {
    all.set(p, off)
    off += p.length
  }
  const splits: Array<(i: number) => number> = [() => 1, () => 3, () => 7, () => 1000, () => all.length, (i) => [1, 2, 5, 13, 4096][i % 5]]
  for (const step of splits) {
    const got: Uint8Array[] = []
    const parser = new MqttParser((h, body) => got.push(Uint8Array.from([h, ...encodeRemainingLength(body.length), ...body])))
    let i = 0
    for (let pos = 0, k = 0; pos < all.length; k++) {
      const n = step(k)
      parser.push(all.slice(pos, pos + n))
      pos += n
      i++
    }
    assert.equal(got.length, packets.length, `packet count (${i} chunks)`)
    got.forEach((g, j) => assert.deepEqual(g, packets[j], `packet ${j}`))
  }
})

test('stream parser: oversized packets are skipped without buffering, stream stays in sync', () => {
  const small1 = encodePublish('s1', bytes(10))
  const huge = encodePublish('huge', bytes(5000))
  const small2 = encodePublish('s2', bytes(20))
  const all = Uint8Array.from([...small1, ...huge, ...small2])
  for (const step of [1, 9, 333, all.length]) {
    const topics: string[] = []
    const parser = new MqttParser((h, body) => topics.push(parsePublish(h, body)?.topic ?? '?'), 1000)
    for (let pos = 0; pos < all.length; pos += step) parser.push(all.slice(pos, pos + step))
    assert.deepEqual(topics, ['s1', 's2'], `step ${step}`)
  }
})

test('stream parser: reset() inside the callback stops processing; malformed varint throws', () => {
  const got: number[] = []
  const parser: MqttParser = new MqttParser((h) => {
    got.push(h)
    parser.reset()
  })
  parser.push(Uint8Array.of(0xd0, 0, 0xd0, 0, 0xd0, 0))
  assert.deepEqual(got, [0xd0])
  parser.push(Uint8Array.of(0xc0, 0))
  assert.deepEqual(got, [0xd0, 0xc0])
  const bad = new MqttParser(() => {})
  assert.throws(() => bad.push(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01)))
})

test('parseBrokerUrl: userinfo becomes credentials, invalid URLs throw', () => {
  assert.deepEqual(parseBrokerUrl('wss://demo@demo.tbmq.io:443/mqtt'), { wsUrl: 'wss://demo.tbmq.io/mqtt', username: 'demo', password: undefined })
  assert.deepEqual(parseBrokerUrl(' wss://u%40x:p%3Aw@host:8884/mqtt#frag '), { wsUrl: 'wss://host:8884/mqtt', username: 'u@x', password: 'p:w' })
  assert.deepEqual(parseBrokerUrl('wss://test.mosquitto.org:8081/mqtt'), {
    wsUrl: 'wss://test.mosquitto.org:8081/mqtt',
    username: undefined,
    password: undefined,
  })
  assert.throws(() => parseBrokerUrl('https://example.com/mqtt'), TypeError)
  assert.throws(() => parseBrokerUrl('not a url'), TypeError)
  assert.throws(() => parseBrokerUrl(''), TypeError)
})

// ───────────────────────── client (fake broker) ─────────────────────────

const FAST: MqttClientOptions = { connackTimeoutMs: 80, openTimeoutMs: 200, backoffMinMs: 20, backoffMaxMs: 200 }

function track(c: MqttClient): MqttStatus[] {
  const log: MqttStatus[] = []
  c.onStatus = (s) => log.push(s)
  return log
}

test('client: CONNECT details, subscribe 0x82, publish/receive, close sends DISCONNECT', async () => {
  const net = new FakeNet()
  const broker = net.add('wss://b1.test/mqtt')
  const a = new MqttClient('wss://demo@b1.test/mqtt', { ...FAST, createWebSocket: net.factory })
  const b = new MqttClient('wss://us%40er:p%3Ass@b1.test/mqtt', { ...FAST, createWebSocket: net.factory })
  try {
    assert.equal(a.status, 'disconnected')
    assert.equal(a.publish('x', Uint8Array.of(1)), false, 'publish before connect')
    const log = track(a)
    const received: Array<[string, number[]]> = []
    b.onMessage = (t, p) => received.push([t, [...p]])
    b.subscribe('room/x')
    b.subscribe('room/x') // duplicate ignored
    a.connect()
    b.connect()
    assert.equal(a.status, 'connecting')
    await waitFor(() => a.status === 'connected' && b.status === 'connected', 2000, 'connect')
    assert.deepEqual(log, ['connecting', 'connected'])
    assert.equal(a.url, 'wss://demo@b1.test/mqtt')
    assert.equal(a.endpointUrl, 'wss://b1.test/mqtt')

    const ca = broker.connects[0]
    const cb = broker.connects[1]
    assert.equal(ca.url, 'wss://b1.test/mqtt', 'userinfo stripped from the WebSocket URL')
    assert.deepEqual(ca.protocols, ['mqtt'])
    assert.match(ca.clientId, /^st[0-9a-f]{20}$/)
    assert.equal(ca.keepalive, 30)
    assert.equal(ca.username, 'demo')
    assert.equal(ca.password, undefined)
    assert.equal(ca.flags, 0x82)
    assert.equal(cb.username, 'us@er')
    assert.equal(cb.password, 'p:ss')
    assert.notEqual(ca.clientId, cb.clientId)
    assert.ok(net.sockets.every((s) => s.binaryType === 'arraybuffer'))

    await waitFor(() => broker.subscribedTopics.length === 1, 1000, 'subscribe')
    assert.deepEqual(broker.subscribeHeaders, [0x82])

    assert.equal(a.publish('room/x', Uint8Array.of(1, 2, 3)), true)
    assert.equal(a.publish('room/other', Uint8Array.of(4)), true)
    assert.equal(a.publish('room/x', new Uint8Array(MAX_PAYLOAD_BYTES + 1)), false, 'oversized payload refused')
    assert.equal(a.publish('room/x', new Uint8Array(MAX_PAYLOAD_BYTES)), true)
    await waitFor(() => received.length === 2, 1000, 'messages')
    assert.deepEqual(received[0], ['room/x', [1, 2, 3]])
    assert.equal(received[1][1].length, MAX_PAYLOAD_BYTES)

    // subscribe while connected is sent immediately
    b.subscribe('room/y')
    await waitFor(() => broker.subscribedTopics.includes('room/y'), 1000, 'live subscribe')

    a.close()
    assert.equal(a.status, 'disconnected')
    assert.equal(broker.disconnects, 1)
    assert.equal(a.publish('room/x', Uint8Array.of(1)), false, 'publish after close')
    const sockets = net.sockets.length
    await delay(150)
    assert.equal(net.sockets.length, sockets, 'no reconnect after close()')
    assert.deepEqual(log, ['connecting', 'connected', 'disconnected'])
  } finally {
    a.close()
    b.close()
  }
})

test('client: re-subscribes after a dropped connection with a new client id', async () => {
  const net = new FakeNet()
  const broker = net.add('wss://b2.test/mqtt')
  const c = new MqttClient('wss://b2.test/mqtt', { ...FAST, createWebSocket: net.factory })
  const pub = new MqttClient('wss://b2.test/mqtt', { ...FAST, createWebSocket: net.factory })
  try {
    const log = track(c)
    const got: string[] = []
    c.onMessage = (_t, p) => got.push(new TextDecoder().decode(p))
    c.subscribe('t/1')
    c.subscribe('t/2')
    c.connect()
    pub.connect()
    await waitFor(() => c.status === 'connected' && pub.status === 'connected' && broker.subscribedTopics.length === 2, 2000, 'connect')
    broker.killAll()
    await waitFor(() => log.includes('disconnected'), 1000, 'drop detected')
    await waitFor(() => c.status === 'connected' && pub.status === 'connected', 2000, 'reconnect')
    await waitFor(() => broker.subscribedTopics.length === 4, 1000, 're-subscribe')
    assert.deepEqual(broker.subscribedTopics.slice(2).sort(), ['t/1', 't/2'])
    const ids = broker.connects.map((x) => x.clientId)
    assert.equal(new Set(ids).size, ids.length, 'fresh client id per connection')
    pub.publish('t/2', enc.encode('hallo'))
    await waitFor(() => got.length === 1, 1000, 'message after reconnect')
    assert.deepEqual(got, ['hallo'])
    assert.deepEqual(log.slice(0, 4), ['connecting', 'connected', 'disconnected', 'connecting'])
  } finally {
    c.close()
    pub.close()
  }
})

test('client: CONNACK timeout → retry; refused CONNACK reported', async () => {
  const net = new FakeNet()
  const broker = net.add('wss://b3.test/mqtt')
  broker.connack = 'hang'
  const c = new MqttClient('wss://b3.test/mqtt', { ...FAST, createWebSocket: net.factory })
  try {
    c.connect()
    await waitFor(() => broker.connects.length >= 2, 1000, 'second attempt after CONNACK timeout')
    assert.equal(c.status === 'connected', false)
    assert.match(c.lastError, /CONNACK timeout/)
    assert.ok(net.sockets[0].closedByClient, 'hung socket closed by the client')
    broker.connack = 5
    const n = broker.connects.length
    await waitFor(() => broker.connects.length > n && /rc=5/.test(c.lastError), 1500, 'refused CONNACK')
    broker.connack = 'ok'
    await waitFor(() => c.status === 'connected', 2000, 'connect after broker recovers')
    assert.equal(c.lastError, '')
  } finally {
    c.close()
  }
})

test('client: exponential backoff with jitter, capped', async () => {
  const net = new FakeNet() // no broker registered → every WebSocket fails immediately
  const c = new MqttClient('wss://nowhere.test/mqtt', { createWebSocket: net.factory, backoffMinMs: 50, backoffMaxMs: 400 })
  try {
    c.connect()
    await waitFor(() => net.sockets.length >= 7, 5000, 'reconnect attempts')
    c.close()
    const t = net.sockets.map((s) => s.createdAt)
    const gaps = t.slice(1).map((x, i) => x - t[i])
    const expected = [50, 100, 200, 400, 400, 400]
    gaps.slice(0, 6).forEach((g, i) => {
      assert.ok(g >= expected[i] * 0.8 - 5, `gap ${i} = ${g} ms, expected ≥ ${expected[i] * 0.8}`)
      assert.ok(g <= expected[i] * 1.2 + 80, `gap ${i} = ${g} ms, expected ≤ ${expected[i] * 1.2}`)
    })
    const n = net.sockets.length
    await delay(600)
    assert.equal(net.sockets.length, n, 'close() cancels the pending reconnect')
  } finally {
    c.close()
  }
})

test('client: PINGREQ keepalive; missing PINGRESP → reconnect', async () => {
  const net = new FakeNet()
  const broker = net.add('wss://b4.test/mqtt')
  const c = new MqttClient('wss://b4.test/mqtt', { ...FAST, pingIntervalMs: 40, pingTimeoutMs: 60, createWebSocket: net.factory })
  try {
    // lastError is cleared again by the next CONNACK, so capture it when the drop is reported
    const dropReasons: string[] = []
    c.onStatus = (s) => {
      if (s === 'disconnected') dropReasons.push(c.lastError)
    }
    c.connect()
    await waitFor(() => c.status === 'connected', 1000, 'connect')
    await delay(250)
    assert.ok(broker.pings >= 3, `pings sent: ${broker.pings}`)
    assert.equal(net.sockets.length, 1, 'answered pings keep the connection')
    assert.deepEqual(dropReasons, [])
    broker.answerPings = false
    await waitFor(() => net.sockets.length >= 2, 1000, 'reconnect after ping timeout')
    assert.deepEqual(dropReasons, ['PINGRESP timeout'])
    broker.answerPings = true
    await waitFor(() => c.status === 'connected', 1000, 'reconnected')
  } finally {
    c.close()
  }
})

test('client: publish bursts beyond the rate limit are delayed, in order, not dropped', async () => {
  const net = new FakeNet()
  net.add('wss://b5.test/mqtt')
  const a = new MqttClient('wss://b5.test/mqtt', { ...FAST, publishRatePerSec: 20, publishBurst: 3, createWebSocket: net.factory })
  const b = new MqttClient('wss://b5.test/mqtt', { ...FAST, createWebSocket: net.factory })
  try {
    const got: number[] = []
    b.onMessage = (_t, p) => got.push(p[0])
    b.subscribe('r')
    a.connect()
    b.connect()
    await waitFor(() => a.status === 'connected' && b.status === 'connected', 1000, 'connect')
    await delay(20)
    const t0 = Date.now()
    for (let i = 0; i < 10; i++) assert.equal(a.publish('r', Uint8Array.of(i)), true)
    await waitFor(() => got.length === 10, 3000, 'all messages')
    const elapsed = Date.now() - t0
    assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.ok(elapsed >= 300, `7 delayed messages at 20/s should take ≥ 350 ms, took ${elapsed}`)
  } finally {
    a.close()
    b.close()
  }
})

test('client: queued publishes are flushed by close() before DISCONNECT', async () => {
  const net = new FakeNet()
  const broker = net.add('wss://b6.test/mqtt')
  const a = new MqttClient('wss://b6.test/mqtt', { ...FAST, publishRatePerSec: 1, publishBurst: 1, createWebSocket: net.factory })
  try {
    a.connect()
    await waitFor(() => a.status === 'connected', 1000, 'connect')
    for (let i = 0; i < 4; i++) a.publish('q', Uint8Array.of(i))
    assert.equal(broker.published.length, 1)
    a.close()
    assert.deepEqual(
      broker.published.map((p) => p.payload[0]),
      [0, 1, 2, 3],
    )
    assert.equal(broker.disconnects, 1)
  } finally {
    a.close()
  }
})

test('client: invalid URL throws in the constructor', () => {
  assert.throws(() => new MqttClient('http://x.test/mqtt'), TypeError)
  assert.throws(() => new MqttClient('::::'), TypeError)
})

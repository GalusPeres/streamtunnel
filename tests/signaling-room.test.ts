// SignalingRoom against in-memory fake brokers: role-less routing (broadcast + own inbox), full-topic AAD,
// encryption, dedupe, queueing, guards.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECRYPT_BURST, MAX_CLOCK_SKEW_MS, SignalingRoom, validateEnvelope } from '../src/signaling/room.ts'
import type { RoomOptions } from '../src/signaling/room.ts'
import { deriveRoomKeys, randomId, seal, unseal } from '../src/core/crypto.ts'
import { formatCode, generateCode } from '../src/core/code.ts'
import { PROTOCOL_VERSION } from '../src/types.ts'
import type { SignalBody, SignalingStatus } from '../src/types.ts'
import { FakeNet, delay, waitFor } from './signaling-fakes.ts'

type Got = Array<{ from: string; body: SignalBody; broadcast: boolean | undefined }>

function setup(latencies = [0, 5, 15]): { net: FakeNet; urls: string[]; open: (o: Partial<RoomOptions> & Pick<RoomOptions, 'code'>) => Promise<SignalingRoom> } {
  const net = new FakeNet()
  const urls = latencies.map((l, i) => {
    const url = `wss://fake${i}.test/mqtt`
    net.add(url, l)
    return url
  })
  const open = (o: Partial<RoomOptions> & Pick<RoomOptions, 'code'>): Promise<SignalingRoom> =>
    SignalingRoom.open({
      selfId: randomId(),
      brokers: urls,
      ...o,
      mqtt: { createWebSocket: net.factory, connackTimeoutMs: 200, backoffMinMs: 20, backoffMaxMs: 200, publishRatePerSec: 1000, publishBurst: 1000, ...o.mqtt },
    })
  return { net, urls, open }
}

function collect(room: SignalingRoom): Got {
  const got: Got = []
  room.onSignal = (from, body, broadcast) => got.push({ from, body, broadcast })
  return got
}

const allConnected = (...rooms: SignalingRoom[]) => () => rooms.every((r) => r.status().connected === r.status().total)
const join = (jid: string, origin: string): SignalBody => ({ t: 'join', jid, origin, name: 'Anna', dec: ['AV1', 'H264'], relay: true })
const presence = (name: string): SignalBody => ({ t: 'presence', name, live: null })

test('room: routing, exactly-once delivery across 3 brokers, encrypted on the wire, full-topic AAD', async () => {
  const { net, urls, open } = setup()
  const code = generateCode()
  const a = await open({ code })
  const b = await open({ code })
  const c = await open({ code })
  try {
    const aGot = collect(a)
    const bGot = collect(b)
    const cGot = collect(c)
    assert.equal(a.code, code)
    assert.match(a.selfId, /^[0-9a-f]{16}$/)
    await waitFor(allConnected(a, b, c), 2000, 'brokers')
    assert.deepEqual(a.status(), { connected: 3, total: 3 })

    const { topic: B, key } = await deriveRoomKeys(code)
    for (const url of urls) {
      const subs = net.brokers.get(url)!.subscribedTopics
      for (const r of [a, b, c]) assert.ok(subs.includes(`${B}/p/${r.selfId}`), 'own inbox')
      assert.equal(subs.filter((t) => t === `${B}/b`).length, 3, 'everybody subscribes the broadcast topic')
      assert.ok(!subs.includes(`${B}/h`), 'no host inbox any more')
    }

    // b → a (addressed join), a → b (offer), a → broadcast (presence), b → a (answer)
    b.send(join('j1', a.selfId), a.selfId)
    a.send({ t: 'offer', jid: 'j1', sid: 's1', sdp: 'v=0\r\n'.repeat(500), hostName: 'Bob' }, b.selfId)
    a.send(presence('Bob'))
    b.send({ t: 'answer', sid: 's1', sdp: 'v=0' }, a.selfId)
    await waitFor(() => aGot.length >= 2 && bGot.length >= 2 && cGot.length >= 1, 2000, 'delivery')
    await delay(80) // let the slower brokers' copies arrive

    assert.deepEqual(
      aGot.map((m) => [m.from, m.body.t, m.broadcast]),
      [
        [b.selfId, 'join', false],
        [b.selfId, 'answer', false],
      ],
    )
    assert.deepEqual(
      bGot.map((m) => [m.from, m.body.t, m.broadcast]),
      [
        [a.selfId, 'offer', false],
        [a.selfId, 'presence', true],
      ],
    )
    // the third member only sees the broadcast, never the others' inboxes
    assert.deepEqual(
      cGot.map((m) => [m.body.t, m.broadcast]),
      [['presence', true]],
    )
    assert.deepEqual(aGot[0].body, join('j1', a.selfId))

    const ad = a.diagnostics()
    assert.equal(ad.delivered, 2)
    assert.equal(ad.duplicates, 4, 'two extra copies per message (3 brokers)')
    assert.equal(ad.brokers.length, 3)
    // join + answer + the echo of its own broadcast (dropped as own message)
    assert.ok(ad.brokers.every((x) => x.received === 3 && x.status === 'connected'))
    assert.equal(
      ad.brokers.reduce((n, x) => n + x.firstDeliveries, 0),
      2,
    )
    assert.equal(ad.brokers[0].url, 'wss://fake0.test/mqtt')

    // wire format: published once per broker, on the right topics, never in clear text
    const pubs = net.brokers.get(urls[0])!.published
    assert.deepEqual(
      pubs.map((p) => p.topic).sort(),
      [`${B}/p/${a.selfId}`, `${B}/p/${b.selfId}`, `${B}/b`, `${B}/p/${a.selfId}`].sort(),
    )
    const text = new TextDecoder('latin1')
    for (const p of pubs) {
      const s = text.decode(p.payload)
      assert.ok(!s.includes('join') && !s.includes('Anna') && !s.includes('v=0') && !s.includes(a.selfId), 'payload must be encrypted')
    }
    const offerPub = pubs.find((p) => p.topic === `${B}/p/${b.selfId}`)!
    const env = await unseal<Record<string, unknown>>(key, offerPub.payload, `${B}/p/${b.selfId}`)
    assert.ok(env)
    assert.equal(env.v, PROTOCOL_VERSION)
    assert.equal(env.from, a.selfId)
    assert.equal(env.to, b.selfId)
    assert.match(String(env.id), /^[0-9a-f]{16}$/)
    assert.ok(Math.abs(Date.now() - Number(env.ts)) < 5000)
    assert.equal(await unseal(key, offerPub.payload, B), null, 'AAD is the full topic, not the base topic')
    assert.equal(await unseal(key, offerPub.payload, `${B}/b`), null)
  } finally {
    a.close()
    b.close()
    c.close()
  }
})

test('room: wrong code receives nothing; formatted code joins the same room', async () => {
  const { open } = setup()
  const code = generateCode()
  let other = generateCode()
  while (other === code) other = generateCode()
  const a = await open({ code })
  const b = await open({ code: formatCode(code).toLowerCase() })
  const wrong = await open({ code: other })
  try {
    assert.equal(b.code, code)
    const aGot = collect(a)
    const bGot = collect(b)
    let wrongCount = 0
    wrong.onSignal = () => wrongCount++
    await waitFor(allConnected(a, b, wrong), 2000, 'brokers')
    b.send(join('j', a.selfId), a.selfId)
    a.send(presence('H'))
    await waitFor(() => aGot.length === 1 && bGot.length === 1, 2000, 'delivery')
    await delay(60)
    assert.equal(wrongCount, 0)
    assert.equal(wrong.diagnostics().brokers.reduce((n, x) => n + x.received, 0), 0)
  } finally {
    for (const r of [a, b, wrong]) r.close()
  }
})

test('room: drops forged, tampered, stale, wrong-version, foreign, wrong-topic and replayed messages', async () => {
  const { net, urls, open } = setup([0])
  const code = generateCode()
  const me = await open({ code })
  try {
    const got = collect(me)
    await waitFor(allConnected(me), 1000, 'broker')
    const { topic: B, key } = await deriveRoomKeys(code)
    const inbox = `${B}/p/${me.selfId}`
    const broker = net.brokers.get(urls[0])!
    const env = (over: Record<string, unknown> = {}) => ({ v: PROTOCOL_VERSION, id: randomId(), from: 'peer1', to: me.selfId, ts: Date.now(), body: join('x', me.selfId), ...over })
    const inject = async (value: unknown, topic = inbox, aad = topic, k = key) => broker.inject(topic, await seal(k, value, aad))

    const { key: wrongKey } = await deriveRoomKeys(generateCode())
    await inject(env(), inbox, inbox, wrongKey) // wrong key
    await inject(env(), inbox, B) // AAD = base topic (old format)
    await inject(env(), inbox, `${B}/b`) // sealed for another topic (replay)
    broker.inject(inbox, new TextEncoder().encode('{"v":1,"id":"a","from":"b","ts":0,"body":{"t":"join"}}')) // clear text
    broker.inject(inbox, new Uint8Array(10)) // too short
    broker.inject(inbox, new Uint8Array(64 * 1024 + 1)) // too large
    const good = await seal(key, env({ id: 'tampered1' }), inbox)
    good[20] ^= 1
    broker.inject(inbox, good)
    await inject(env({ v: PROTOCOL_VERSION + 1 }))
    await inject(env({ id: 5 }))
    await inject(env({ from: 'bad/id' }))
    await inject(env({ from: me.selfId })) // own id
    await inject(env({ to: 'someoneelse' })) // addressed to another peer (topic mismatch)
    await inject(env({ to: undefined })) // broadcast envelope on an inbox
    await inject(env({ body: { x: 1 } })) // body without t
    await inject(env({ body: ['join'] }))
    await inject(env({ body: presence('x') })) // broadcast-only body in an inbox
    await inject(env({ to: undefined }), `${B}/b`) // join on the broadcast topic
    await inject(env({ to: undefined, body: { t: 'bye', sid: 's' } }), `${B}/b`) // bye with sid on the broadcast topic
    await inject('just a string')
    await delay(50)
    assert.equal(got.length, 0)
    assert.equal(me.diagnostics().dropped, 19)

    // authentic but the clock is off by more than the allowed window
    await inject(env({ ts: Date.now() - MAX_CLOCK_SKEW_MS - 60_000 }))
    await inject(env({ ts: Date.now() + MAX_CLOCK_SKEW_MS + 60_000 }))
    await delay(30)
    assert.equal(got.length, 0)
    assert.equal(me.diagnostics().clockSkewDrops, 2)

    // hours of clock skew inside the window are fine
    await inject(env({ id: 'skewed', ts: Date.now() - 3 * 3600_000 }))
    await waitFor(() => got.length === 1, 1000, 'skewed but valid message')

    const replay = await seal(key, env({ id: 'once' }), inbox)
    broker.inject(inbox, replay)
    broker.inject(inbox, replay)
    broker.inject(`${B}/b`, replay) // AAD mismatch on another topic
    await waitFor(() => got.length === 2, 1000, 'valid message')
    await delay(30)
    assert.equal(got.length, 2)
    assert.equal(got[1].from, 'peer1')
    assert.equal(got[1].broadcast, false)
    assert.equal(me.diagnostics().duplicates, 1)

    // a valid broadcast presence
    await inject(env({ id: 'pres', to: undefined, body: presence('P') }), `${B}/b`)
    await waitFor(() => got.length === 3, 1000, 'broadcast')
    assert.deepEqual([got[2].body.t, got[2].broadcast], ['presence', true])
  } finally {
    me.close()
  }
})

test('room: a junk flood never mutes a broker — authentic messages keep arriving', async () => {
  const { net, urls, open } = setup([0, 0])
  const code = generateCode()
  const a = await open({ code })
  const b = await open({ code })
  try {
    const got = collect(a)
    await waitFor(allConnected(a, b), 1000, 'brokers')
    const { topic: B } = await deriveRoomKeys(code)
    const junk = new Uint8Array(40)
    // flood both brokers on the broadcast topic (visible to anybody who can guess / sniff the topic)
    for (const url of urls) for (let i = 0; i < DECRYPT_BURST + 300; i++) net.brokers.get(url)!.inject(`${B}/b`, junk)
    await waitFor(() => a.diagnostics().brokers.every((x) => x.throttled > 0), 2000, 'excess junk dropped')
    b.send(presence('B'))
    await waitFor(() => got.length === 1, 3000, 'authentic message delivered despite the flood')
    const d = a.diagnostics()
    assert.ok(d.brokers.every((x) => x.junk > 0))
    assert.equal(got[0].body.t, 'presence')
  } finally {
    a.close()
    b.close()
  }
})

test('room: queues while no broker is connected, flushes to each broker on connect, keeps order', async () => {
  const { net, urls, open } = setup([0, 30])
  const code = generateCode()
  const a = await open({ code })
  const got = collect(a)
  let b: SignalingRoom | undefined
  try {
    await waitFor(allConnected(a), 1000, 'a brokers')
    // new connections fail from now on (a keeps its established ones)
    for (const url of urls) net.brokers.get(url)!.down = true
    b = await open({ code })
    // b has no broker: these are queued (the 50-message cap drops the oldest ones)
    for (let i = 0; i < 55; i++) b.send(join(`j${i}`, a.selfId), a.selfId)
    await delay(30)
    assert.equal(b.status().connected, 0)
    assert.equal(b.diagnostics().queued, 50)
    assert.equal(b.diagnostics().sent, 0)
    for (const url of urls) net.brokers.get(url)!.down = false
    await waitFor(() => got.length === 50, 3000, 'flushed messages')
    await waitFor(allConnected(b), 1000, 'b brokers')
    await delay(100)
    assert.equal(got.length, 50, 'each queued message delivered once although flushed to two brokers')
    assert.deepEqual(
      got.map((m) => (m.body as { jid: string }).jid),
      Array.from({ length: 50 }, (_, i) => `j${i + 5}`),
    )
    for (const url of urls) assert.equal(net.brokers.get(url)!.published.filter((p) => p.topic.endsWith(`/p/${a.selfId}`)).length, 50)
    assert.equal(b.diagnostics().sent, 50)
    assert.equal(b.diagnostics().queued, 0)
    assert.equal(a.diagnostics().duplicates, 50)
  } finally {
    a.close()
    b?.close()
  }
})

test('room: onStatus reports every change of the connected count', async () => {
  const { net, urls, open } = setup([0, 0])
  const r = await open({ code: generateCode() })
  try {
    const log: SignalingStatus[] = []
    r.onStatus = (s) => log.push(s)
    await waitFor(allConnected(r), 1000, 'brokers')
    net.brokers.get(urls[1])!.killAll()
    await waitFor(() => log.some((s) => s.connected === 1) && r.status().connected === 2, 2000, 'drop + reconnect')
    assert.deepEqual(log[log.length - 1], { connected: 2, total: 2 })
    assert.ok(log.every((s) => s.total === 2))
    for (let i = 1; i < log.length; i++) assert.notEqual(log[i].connected, log[i - 1].connected, 'only changes are reported')
  } finally {
    r.close()
  }
})

test('room: close() flushes a just-sent message, then disconnects; send after close is a no-op', async () => {
  const { net, urls, open } = setup([0])
  const code = generateCode()
  const a = await open({ code })
  const b = await open({ code })
  const got = collect(a)
  let statusAfterClose = 0
  try {
    await waitFor(allConnected(a, b), 1000, 'brokers')
    b.onStatus = () => statusAfterClose++
    b.send({ t: 'bye', sid: 's1' }, a.selfId)
    b.close()
    b.send({ t: 'bye' }, a.selfId)
    b.close()
    await waitFor(() => got.length === 1, 1000, 'bye delivered')
    await delay(50)
    assert.equal(got.length, 1)
    assert.deepEqual(got[0].body, { t: 'bye', sid: 's1' })
    assert.equal(net.brokers.get(urls[0])!.disconnects, 1)
    assert.equal(statusAfterClose, 0, 'no callbacks after close()')
  } finally {
    a.close()
    b.close()
  }
})

test('room: argument validation', async () => {
  const { urls, open } = setup([0])
  await assert.rejects(open({ code: 'nope' }), /Ungültiger Code/)
  await assert.rejects(open({ code: generateCode(), selfId: 'a/b' }), TypeError)
  await assert.rejects(open({ code: generateCode(), brokers: ['http://x', 'garbage'] }), /Keine gültigen Signaling-Server/)
  // invalid and duplicate URLs are skipped
  const r = await open({ code: generateCode(), brokers: [urls[0], 'garbage', urls[0], ` ${urls[0]} `] })
  try {
    assert.equal(r.status().total, 1)
    assert.throws(() => r.send({ t: 'answer', sid: 's', sdp: 'x' }, 'bad/id'), TypeError)
    assert.throws(() => r.send(null as unknown as SignalBody), TypeError)
    assert.throws(() => r.send(join('j', 'x')), TypeError, 'joins are always addressed')
    assert.throws(() => r.send({ t: 'bye', sid: 's' }), TypeError, 'a bye with sid is addressed')
    assert.throws(() => r.send(presence('x'), 'peer1'), TypeError, 'presence is broadcast-only')
    assert.throws(() => r.send({ t: 'leave' }, 'peer1'), TypeError, 'leave is broadcast-only')
    r.send({ t: 'bye' }) // sid-less bye: broadcast ("my stream ended") …
    r.send({ t: 'bye' }, 'peer1') // … or addressed (a watcher leaving before connecting)
    r.send({ t: 'leave' })
  } finally {
    r.close()
  }
})

test('validateEnvelope', () => {
  const now = Date.now()
  const ok = { v: PROTOCOL_VERSION, id: 'abc', from: 'p1', ts: now, body: { t: 'presence', name: 'x', live: null } }
  assert.ok(validateEnvelope(ok, now))
  assert.ok(validateEnvelope({ ...ok, to: 'p2' }, now))
  assert.equal(validateEnvelope({ ...ok, to: 5 }, now), null)
  assert.equal(validateEnvelope({ ...ok, to: 'a/b' }, now), null)
  assert.equal(validateEnvelope({ ...ok, ts: now - MAX_CLOCK_SKEW_MS - 1 }, now), null)
  assert.ok(validateEnvelope({ ...ok, ts: now - MAX_CLOCK_SKEW_MS + 1000 }, now))
  assert.equal(validateEnvelope({ ...ok, ts: Number.NaN }, now), null)
  assert.equal(validateEnvelope({ ...ok, id: '' }, now), null)
  assert.equal(validateEnvelope(null, now), null)
  assert.equal(validateEnvelope([], now), null)
})

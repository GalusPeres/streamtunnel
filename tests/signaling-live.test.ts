// Live tests against the real default public brokers (DEFAULT_NET). Skip with ST_OFFLINE=1.
// Run: npm test   (or: node --test tests/signaling-live.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NET } from '../src/rtc/defaults.ts'
import { SignalingRoom } from '../src/signaling/room.ts'
import { MAX_PAYLOAD_BYTES, MqttClient } from '../src/signaling/mqtt.ts'
import { deriveRoomKeys, randomId, unseal } from '../src/core/crypto.ts'
import { generateCode } from '../src/core/code.ts'
import type { SignalBody } from '../src/types.ts'
import { delay, waitFor } from './signaling-fakes.ts'

const skip = process.env.ST_OFFLINE === '1' ? 'ST_OFFLINE=1' : false
const BROKERS = DEFAULT_NET.brokers
const CONNECT_TIMEOUT_MS = 30_000

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]
const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]
const r1 = (x: number): number => Math.round(x * 10) / 10

function fakeSdp(bytes: number): string {
  let s = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2\r\n'
  let i = 0
  while (s.length < bytes) s += `a=candidate:${i++} 1 udp 2122260223 192.168.1.${i % 250} ${50000 + i} typ host generation 0\r\n`
  return s
}

test('live: MqttClient works with every default broker (connect, subscribe, publish, 60 KB payload)', { skip, timeout: 90_000 }, async (t) => {
  const results = await Promise.all(
    BROKERS.map(async (url) => {
      const a = new MqttClient(url)
      const b = new MqttClient(url)
      const topic = `st1test/${randomId(8)}`
      let last: { payload: Uint8Array; at: number } | null = null
      b.onMessage = (tp, payload) => {
        if (tp === topic) last = { payload, at: performance.now() }
      }
      b.subscribe(topic)
      const t0 = performance.now()
      a.connect()
      b.connect()
      try {
        await waitFor(() => a.status === 'connected' && b.status === 'connected', CONNECT_TIMEOUT_MS, `connect ${url}`)
        const connectMs = performance.now() - t0
        // wait until the subscription is active (probe until the first message comes through)
        const probeEnd = Date.now() + 8000
        while (!last) {
          if (Date.now() > probeEnd) throw new Error(`no message through ${url}`)
          a.publish(topic, Uint8Array.of(0))
          await delay(250)
        }
        await delay(200)
        const lat: number[] = []
        for (let i = 0; i < 6; i++) {
          last = null
          const p = crypto.getRandomValues(new Uint8Array(200))
          const sentAt = performance.now()
          assert.ok(a.publish(topic, p))
          await waitFor(() => last !== null, 5000, `message ${i} via ${url}`)
          const got = last as unknown as { payload: Uint8Array; at: number }
          assert.deepEqual(got.payload, p)
          lat.push(got.at - sentAt)
          await delay(150)
        }
        last = null
        const big = crypto.getRandomValues(new Uint8Array(MAX_PAYLOAD_BYTES))
        assert.ok(a.publish(topic, big))
        await waitFor(() => last !== null, 10_000, `60 KB via ${url}`)
        assert.deepEqual((last as unknown as { payload: Uint8Array }).payload, big)
        return { url, ok: true, connectMs: Math.round(connectMs), oneWayMedianMs: r1(median(lat)), oneWayMaxMs: r1(Math.max(...lat)), big60k: true }
      } catch (err) {
        return { url, ok: false, error: String(err), lastErrorA: a.lastError, lastErrorB: b.lastError }
      } finally {
        a.close()
        b.close()
      }
    }),
  )
  for (const r of results) t.diagnostic(JSON.stringify(r))
  const failed = results.filter((r) => !r.ok)
  assert.equal(failed.length, 0, `brokers failing: ${JSON.stringify(failed)}`)
})

test('live: two tunnel members exchange presence + join → offer exactly once across 4 brokers; wrong code gets nothing', { skip, timeout: 120_000 }, async (t) => {
  const code = generateCode()
  let wrongCode = generateCode()
  while (wrongCode === code) wrongCode = generateCode()
  const open = (c: string) => SignalingRoom.open({ code: c, selfId: randomId(), brokers: BROKERS })
  const rooms: SignalingRoom[] = []
  let spy: MqttClient | undefined
  try {
    const viewer = await open(code)
    rooms.push(viewer)
    const wrongHost = await open(wrongCode)
    const wrongViewer = await open(wrongCode)
    rooms.push(wrongHost, wrongViewer)
    let wrongDelivered = 0
    wrongHost.onSignal = wrongViewer.onSignal = () => wrongDelivered++

    const viewerGot: Array<{ from: string; body: SignalBody; at: number }> = []
    viewer.onSignal = (from, body) => viewerGot.push({ from, body, at: performance.now() })

    // eavesdropper on one broker (what a broker operator sees): everything under the room topic
    const { topic: B } = await deriveRoomKeys(code)
    const spied: Array<{ topic: string; p: Uint8Array }> = []
    spy = new MqttClient(BROKERS[0])
    spy.subscribe(`${B}/#`)
    spy.onMessage = (topic, p) => spied.push({ topic, p })
    spy.connect()

    const tOpen = performance.now()
    await waitFor(() => viewer.status().connected === BROKERS.length && spy?.status === 'connected', CONNECT_TIMEOUT_MS, 'viewer on all brokers')
    t.diagnostic(`viewer connected to ${BROKERS.length}/${BROKERS.length} brokers after ${Math.round(performance.now() - tOpen)} ms`)
    await delay(500) // subscriptions settle

    // The sharer opens and broadcasts presence before any broker is connected → queued, flushed on connect.
    const host = await open(code)
    rooms.push(host)
    const hostGot: Array<{ from: string; body: SignalBody; at: number }> = []
    host.onSignal = (from, body) => hostGot.push({ from, body, at: performance.now() })
    assert.equal(host.status().connected, 0)
    host.send({ t: 'presence', name: 'LiveHost', live: null })
    await waitFor(() => viewerGot.some((m) => m.body.t === 'presence'), CONNECT_TIMEOUT_MS, 'queued presence broadcast')
    await waitFor(
      () => [host, wrongHost, wrongViewer].every((r) => r.status().connected === BROKERS.length),
      CONNECT_TIMEOUT_MS,
      'all rooms on all brokers',
    )
    await delay(500)

    const joinLat: number[] = []
    const offerLat: number[] = []
    const ROUNDS = 10
    const sdp = fakeSdp(5000)
    for (let i = 0; i < ROUNDS; i++) {
      const jid = `j${i}`
      const tJoin = performance.now()
      viewer.send({ t: 'join', jid, origin: host.selfId, name: 'Viewer', dec: ['AV1', 'H264'], relay: true }, host.selfId)
      await waitFor(() => hostGot.some((m) => m.body.t === 'join' && m.body.jid === jid), 8000, `join ${i}`)
      joinLat.push(hostGot.find((m) => m.body.t === 'join' && m.body.jid === jid)!.at - tJoin)
      const tOffer = performance.now()
      host.send({ t: 'offer', jid, sid: `s${i}`, sdp, hostName: 'LiveHost' }, viewer.selfId)
      await waitFor(() => viewerGot.some((m) => m.body.t === 'offer' && m.body.jid === jid), 8000, `offer ${i}`)
      offerLat.push(viewerGot.find((m) => m.body.t === 'offer' && m.body.jid === jid)!.at - tOffer)
      await delay(150)
    }
    viewer.send({ t: 'answer', sid: 's9', sdp: 'v=0\r\n' }, host.selfId)
    host.send({ t: 'ice', sid: 's9', c: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx', sdpMid: '0', sdpMLineIndex: 0 }] }, viewer.selfId)
    await waitFor(() => hostGot.some((m) => m.body.t === 'answer') && viewerGot.some((m) => m.body.t === 'ice'), 8000, 'answer + ice')
    await delay(3000) // collect late duplicates from slower brokers

    // exactly once, nothing else
    const hostKinds = hostGot.map((m) => (m.body.t === 'join' ? `join:${m.body.jid}` : m.body.t)).sort()
    const viewerKinds = viewerGot.map((m) => (m.body.t === 'offer' ? `offer:${m.body.jid}` : m.body.t)).sort()
    assert.deepEqual(hostKinds, ['answer', ...Array.from({ length: ROUNDS }, (_, i) => `join:j${i}`)].sort())
    assert.deepEqual(viewerKinds, ['ice', 'presence', ...Array.from({ length: ROUNDS }, (_, i) => `offer:j${i}`)].sort())
    assert.ok(hostGot.every((m) => m.from === viewer.selfId))
    assert.ok(viewerGot.every((m) => m.from === host.selfId))

    for (const [name, room] of [
      ['host', host],
      ['viewer', viewer],
    ] as const) {
      const d = room.diagnostics()
      const received = d.brokers.reduce((n, b) => n + b.received, 0)
      t.diagnostic(
        `${name}: delivered ${d.delivered}, duplicates dropped ${d.duplicates}, invalid ${d.dropped}; per broker ` +
          d.brokers.map((b) => `${new URL(b.url).hostname}: rx ${b.received}, first ${b.firstDeliveries}`).join(' | '),
      )
      // the only "invalid" packets are the echoes of our own broadcast (one per broker at most)
      assert.ok(d.dropped <= (name === 'host' ? BROKERS.length : 0), `dropped ${d.dropped}`)
      assert.equal(received, d.delivered + d.duplicates + d.dropped)
      assert.equal(d.brokers.length, 4)
      assert.ok(
        d.brokers.every((b) => b.received > 0),
        'every broker carried traffic',
      )
      // with 4 brokers each message arrives up to 4 times; at least one extra copy per message on average
      assert.ok(d.duplicates >= d.delivered, `expected duplicates (≥ ${d.delivered}), got ${d.duplicates}`)
    }

    // wrong code: nothing at all
    assert.equal(wrongDelivered, 0)
    assert.equal(wrongHost.diagnostics().brokers.reduce((n, b) => n + b.received, 0), 0)
    assert.equal(wrongViewer.diagnostics().brokers.reduce((n, b) => n + b.received, 0), 0)

    // eavesdropper saw only ciphertext
    assert.ok(spied.length >= ROUNDS * 2, `spy saw ${spied.length} messages`)
    const { key: wrongKey } = await deriveRoomKeys(wrongCode)
    const latin1 = new TextDecoder('latin1')
    for (const { topic, p } of spied) {
      const s = latin1.decode(p)
      assert.ok(!s.includes('LiveHost') && !s.includes('v=0') && !s.includes('join') && !s.includes(viewer.selfId), 'ciphertext only')
      assert.equal(await unseal(wrongKey, p, topic), null)
    }
    const { key } = await deriveRoomKeys(code)
    assert.ok(await unseal(key, spied[0].p, spied[0].topic), 'right key decrypts the spied payload (AAD = its topic)')
    assert.equal(await unseal(key, spied[0].p, B), null, 'but not with the base topic as AAD')

    const summary = {
      joinViewerToHostMs: { median: r1(median(joinLat)), p90: r1(pct(joinLat, 0.9)), max: r1(Math.max(...joinLat)) },
      offer5kHostToViewerMs: { median: r1(median(offerLat)), p90: r1(pct(offerLat, 0.9)), max: r1(Math.max(...offerLat)) },
    }
    t.diagnostic(`end-to-end delivery latency (send() → onSignal, incl. encrypt/decrypt): ${JSON.stringify(summary)}`)
  } finally {
    for (const r of rooms) r.close()
    spy?.close()
  }
})

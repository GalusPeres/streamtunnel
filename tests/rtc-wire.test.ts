// Unit tests for the data-channel / trickle validation helpers exported by host.ts.
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCandidates, parseCtl, sanitizeName } from '../src/rtc/host.ts'

test('sanitizeName', () => {
  assert.equal(sanitizeName('  Anna  '), 'Anna')
  assert.equal(sanitizeName('a\u0000b\nc'), 'abc')
  assert.equal(sanitizeName(''), 'Gast')
  assert.equal(sanitizeName(42), 'Gast')
  assert.equal(sanitizeName('x'.repeat(100)).length, 40)
})

test('parseCandidates: keeps valid entries, drops junk and end-of-candidates', () => {
  const c = parseCandidates([
    { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    { candidate: '' },
    { candidate: 5 },
    null,
    'x',
    { candidate: 'candidate:2 1 udp 1686052607 1.2.3.4 50001 typ srflx raddr 0.0.0.0 rport 0' },
  ])
  assert.equal(c.length, 2)
  assert.equal(c[0].sdpMid, '0')
  assert.equal(c[1].sdpMLineIndex, 0) // filled in for max-bundle
  assert.deepEqual(parseCandidates('nope'), [])
})

test('parseCtl: validates and normalizes messages', () => {
  assert.equal(parseCtl('not json'), null)
  assert.equal(parseCtl(JSON.stringify({ t: 'unknown' })), null)
  assert.equal(parseCtl(JSON.stringify({ t: 'paused' })), null)
  assert.deepEqual(parseCtl(JSON.stringify({ t: 'paused', paused: true })), { t: 'paused', paused: true })
  assert.deepEqual(parseCtl(JSON.stringify({ t: 'kick' })), { t: 'kick' })
  const info = parseCtl(
    JSON.stringify({ t: 'info', hostName: 'Ben', settings: { resolution: 1080, fps: 120, bitrateKbps: 0, codec: 'AV1', content: 'motion', audio: false }, viewers: 3, codec: 'AV1', hops: 2 }),
  )
  assert.deepEqual(info, {
    t: 'info',
    hostName: 'Ben',
    settings: { resolution: 1080, fps: 120, bitrateKbps: 0, codec: 'AV1', content: 'motion', audio: false },
    viewers: 3,
    codec: 'AV1',
    hops: 2,
  })
  const rx = parseCtl(JSON.stringify({ t: 'rx', fps: 59.9, latencyMs: null, lossPct: 300, width: 1920, height: 1080, children: 1, descendants: 2, canRelay: 'yes' }))
  assert.deepEqual(rx, { t: 'rx', fps: 59.9, latencyMs: null, lossPct: 100, width: 1920, height: 1080, children: 1, descendants: 2, canRelay: false })
  const tx = parseCtl(JSON.stringify({ t: 'tx', encodeMs: 3.2, encoder: 'X', hw: true, kbps: 9000, upstreamLatencyMs: 0 }))
  assert.deepEqual(tx, { t: 'tx', encodeMs: 3.2, encoder: 'X', hw: true, kbps: 9000, upstreamLatencyMs: 0 })
  const lim = parseCtl(JSON.stringify({ t: 'tx', encodeMs: 3.2, encoder: 'X', hw: true, kbps: 9000, upstreamLatencyMs: 0, lim: 'bandwidth' }))
  assert.equal((lim as { lim?: string }).lim, 'bandwidth')
  const bad = parseCtl(JSON.stringify({ t: 'tx', encodeMs: 3.2, encoder: 'X', hw: true, kbps: 9000, upstreamLatencyMs: 0, lim: '<b>' }))
  assert.equal('lim' in (bad as object), false)
})

test('parseCtl: expect (relay vouching) and bounded viewer-reported counts', () => {
  assert.deepEqual(parseCtl(JSON.stringify({ t: 'expect', id: 'abc123', jid: 'j1' })), { t: 'expect', id: 'abc123', jid: 'j1' })
  assert.equal(parseCtl(JSON.stringify({ t: 'expect', id: 'a/b', jid: 'j1' })), null)
  assert.equal(parseCtl(JSON.stringify({ t: 'expect', id: 'abc' })), null)
  assert.equal(parseCtl(JSON.stringify({ t: 'expect', id: 'x'.repeat(65), jid: 'j' })), null)
  // spoofed relay load / audience: children and descendants are capped at MAX_RELAY_CHILDREN (3)
  const rx = parseCtl(JSON.stringify({ t: 'rx', fps: 60, latencyMs: 10, lossPct: 0, width: 1, height: 1, children: 50, descendants: 1e300, canRelay: true }))
  assert.equal(rx?.t === 'rx' && rx.children, 3)
  assert.equal(rx?.t === 'rx' && rx.descendants, 3)
  const info = parseCtl(JSON.stringify({ t: 'info', hostName: 'B', settings: {}, viewers: 1e300, codec: 'H264', hops: 1 }))
  assert.equal(info?.t === 'info' && info.viewers, 10_000)
})

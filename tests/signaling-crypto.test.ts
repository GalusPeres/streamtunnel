// Key/topic derivation and seal/unseal, cross-checked against an independent node:crypto implementation.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, hkdfSync, pbkdf2Sync } from 'node:crypto'
import { PBKDF2_ITERATIONS, deriveRoomKeys, randomId, seal, unseal } from '../src/core/crypto.ts'

const CODE = 'K7F3QX9MZD'

test('deriveRoomKeys: deterministic, spec-conformant (cross-checked with node:crypto) and fast', async (t) => {
  const t0 = performance.now()
  const a = await deriveRoomKeys(CODE)
  const ms = performance.now() - t0
  assert.ok(ms < 1500, `derivation took ${ms.toFixed(0)} ms (limit 1500)`)
  const b = await deriveRoomKeys(CODE)
  assert.equal(a.topic, b.topic)
  assert.match(a.topic, /^st2\/[0-9a-f]{32}$/)
  assert.equal(a.key.extractable, false)
  assert.deepEqual([...a.key.usages].sort(), ['decrypt', 'encrypt'])
  assert.equal((a.key.algorithm as AesKeyAlgorithm).length, 256)

  // independent implementation of §4.2
  const ikm = pbkdf2Sync(CODE, 'streamtunnel/v1/room', PBKDF2_ITERATIONS, 32, 'sha256')
  const topicBytes = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'topic', 16))
  assert.equal(a.topic, 'st2/' + topicBytes.toString('hex'))

  // a value sealed by our code must decrypt with the independently derived key (format IV ‖ ct ‖ tag, AAD = topic)
  const keyBytes = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'key', 32))
  const sealed = await seal(a.key, { hello: 'Welt', n: 1 }, a.topic)
  const iv = sealed.subarray(0, 12)
  const tag = sealed.subarray(sealed.length - 16)
  const ct = sealed.subarray(12, sealed.length - 16)
  const d = createDecipheriv('aes-256-gcm', keyBytes, iv)
  d.setAAD(Buffer.from(a.topic))
  d.setAuthTag(tag)
  const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  assert.deepEqual(JSON.parse(plain), { hello: 'Welt', n: 1 })

  t.diagnostic(`deriveRoomKeys (PBKDF2 ${PBKDF2_ITERATIONS}): ${ms.toFixed(0)} ms`)
})

test('deriveRoomKeys: different codes give different topics and keys', async () => {
  const a = await deriveRoomKeys(CODE)
  const b = await deriveRoomKeys('K7F3QX9MZE')
  assert.notEqual(a.topic, b.topic)
  const sealed = await seal(a.key, { x: 1 }, a.topic)
  assert.equal(await unseal(b.key, sealed, a.topic), null)
  await assert.rejects(deriveRoomKeys(''))
})

test('seal/unseal: round trip, random IV, wrong key / wrong aad / tampering → null', async () => {
  const { key, topic } = await deriveRoomKeys(CODE)
  const { key: otherKey } = await deriveRoomKeys('0000000000')
  const value = { v: 1, id: 'abc', body: { t: 'offer', sdp: 'v=0\r\n'.repeat(200), ü: 'ä€😀' } }
  const s1 = await seal(key, value, topic)
  const s2 = await seal(key, value, topic)
  assert.ok(s1 instanceof Uint8Array)
  assert.equal(s1.length, 12 + new TextEncoder().encode(JSON.stringify(value)).length + 16)
  assert.notDeepEqual(s1.subarray(0, 12), s2.subarray(0, 12), 'IV must be random')
  assert.deepEqual(await unseal(key, s1, topic), value)
  assert.deepEqual(await unseal(key, s2, topic), value)

  assert.equal(await unseal(otherKey, s1, topic), null, 'wrong key')
  assert.equal(await unseal(key, s1, topic + '/x'), null, 'wrong aad')
  assert.equal(await unseal(key, s1, ''), null, 'missing aad')
  for (const pos of [0, 11, 12, s1.length - 1]) {
    const t = s1.slice()
    t[pos] ^= 0x01
    assert.equal(await unseal(key, t, topic), null, `tampered byte ${pos}`)
  }
  assert.equal(await unseal(key, s1.subarray(0, 27), topic), null, 'too short')
  assert.equal(await unseal(key, new Uint8Array(0), topic), null)
  assert.equal(await unseal(key, 'nope' as unknown as Uint8Array, topic), null)
  // a view into a larger buffer works too
  const big = new Uint8Array(s1.length + 10)
  big.set(s1, 5)
  assert.deepEqual(await unseal(key, big.subarray(5, 5 + s1.length), topic), value)
  // undefined is sealed as JSON null
  const sealedUndefined = await seal(key, undefined, topic)
  assert.equal(sealedUndefined.length, 12 + 4 + 16)
})

test('randomId: lowercase hex of the requested length', () => {
  assert.match(randomId(), /^[0-9a-f]{16}$/)
  assert.match(randomId(10), /^[0-9a-f]{20}$/)
  assert.match(randomId(1), /^[0-9a-f]{2}$/)
  assert.match(randomId(0), /^[0-9a-f]{2}$/)
  const ids = new Set(Array.from({ length: 1000 }, () => randomId()))
  assert.equal(ids.size, 1000)
})

// Room code generation / normalization / formatting.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_ALPHABET, CODE_LENGTH, formatCode, generateCode, normalizeCode } from '../src/core/code.ts'

test('generateCode: 10 Crockford base32 chars, round-trips through format/normalize', () => {
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  for (let i = 0; i < 2000; i++) {
    const c = generateCode()
    assert.equal(c.length, CODE_LENGTH)
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{10}$/)
    assert.equal(normalizeCode(c), c)
    assert.equal(normalizeCode(formatCode(c)), c)
    assert.equal(normalizeCode(formatCode(c).toLowerCase()), c)
    seen.add(c)
    for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  assert.equal(seen.size, 2000, 'codes must not repeat')
  // all 32 symbols used, roughly uniformly (expected 625 each for 20 000 chars)
  assert.equal(counts.size, 32)
  for (const ch of CODE_ALPHABET) {
    const n = counts.get(ch) ?? 0
    assert.ok(n > 450 && n < 800, `symbol ${ch} count ${n} looks non-uniform`)
  }
})

test('formatCode', () => {
  assert.equal(formatCode('K7F3QX9MZD'), 'K7F3Q-X9MZD')
  assert.equal(formatCode('k7f3qx9mzd'), 'K7F3Q-X9MZD')
  assert.equal(formatCode('K7F3Q-X9MZD'), 'K7F3Q-X9MZD')
  // partial input while typing
  assert.equal(formatCode('k7f3'), 'K7F3')
  assert.equal(formatCode('k7f3q'), 'K7F3Q')
  assert.equal(formatCode('k7f3qx'), 'K7F3Q-X')
  assert.equal(formatCode(''), '')
})

test('normalizeCode: separators, case and look-alikes', () => {
  assert.equal(normalizeCode('K7F3QX9MZD'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('k7f3q-x9mzd'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('  K7F3Q X9MZD \n'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('K7F3Q_X9MZD'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('K7-F3-QX-9M-ZD'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('K7F3Q–X9MZD'), 'K7F3QX9MZD') // en dash from word processors
  assert.equal(normalizeCode('O0OIL-1il0o'), '0001111100')
  assert.equal(normalizeCode('k7f3o-x9mzd'), 'K7F30X9MZD')
})

test('normalizeCode: invalid input → null', () => {
  assert.equal(normalizeCode(''), null)
  assert.equal(normalizeCode('K7F3QX9MZ'), null) // 9 chars
  assert.equal(normalizeCode('K7F3QX9MZDA'), null) // 11 chars
  assert.equal(normalizeCode('K7F3Q-X9MZU'), null) // U is not part of Crockford base32
  assert.equal(normalizeCode('K7F3Q-X9MZ!'), null)
  assert.equal(normalizeCode('hallo du da'), null)
  assert.equal(normalizeCode(undefined as unknown as string), null)
  assert.equal(normalizeCode(42 as unknown as string), null)
})

test('normalizeCode: extracts the code from pasted invite text', () => {
  assert.equal(normalizeCode('Code: K7F3Q-X9MZD (StreamTunnel)'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('Schau meinen Stream in StreamTunnel: Code K7F3Q-X9MZD'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('Schau meinen Stream in StreamTunnel: Code k7f3q-x9mzd.'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('code=K7F3QX9MZD'), 'K7F3QX9MZD')
  assert.equal(normalizeCode('Hier: K7F3Q X9MZD danke'), 'K7F3QX9MZD')
  // a dashed token wins over an earlier 10-letter word
  assert.equal(normalizeCode('ABCDEFGHJK oder K7F3Q-X9MZD'), 'K7F3QX9MZD')
  // invalid dashed token falls back to the next candidate
  assert.equal(normalizeCode('UUUUU-UUUUU K7F3Q-X9MZD'), 'K7F3QX9MZD')
  // 12-letter word is not a code
  assert.equal(normalizeCode('STREAMTUNNEL'), null)
  assert.equal(normalizeCode('Kein Code hier drin, sorry'), null)
})

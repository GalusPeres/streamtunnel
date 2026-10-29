// Unit tests for the in-app update check's version comparison (src/update.ts).
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNewer } from '../src/update.ts'

test('isNewer compares x.y.z numerically, ignoring a leading v', () => {
  assert.equal(isNewer('v0.2.9', '0.2.8'), true)
  assert.equal(isNewer('0.2.10', '0.2.9'), true)
  assert.equal(isNewer('0.3.0', '0.2.99'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('v0.2.8', '0.2.8'), false)
  assert.equal(isNewer('0.2.7', '0.2.8'), false)
  assert.equal(isNewer('0.2', '0.2.0'), false)
  assert.equal(isNewer('garbage', '0.2.8'), false)
})

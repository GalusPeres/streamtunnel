// Unit tests for the native path's frame pacing (src/rtc/framepacer.ts): playout times on the sharer's beat grid and
// the choice of the frame per display refresh, checked on a simulated 60 Hz display.
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FramePacer, pickFrame } from '../src/rtc/framepacer.ts'

const BEAT = 1000 / 60

/** Deterministic jitter in [0, 1). */
function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

interface Sim {
  /** display refreshes after the warm-up that showed no new frame */
  repeats: number
  /** frames never shown */
  skipped: number
  /** mean wait from decoded to shown (ms) */
  waitMs: number
}

/**
 * 600 frames at 60 fps (capture times `ptsMs`), decoded 5 ms + jitter·J later, shown on a 60 Hz display whose
 * refreshes sit at `phase` ms. `drawAtOnce`: the renderer before pacing — every frame drawn when decoded, so a
 * refresh shows the newest one and the others are never seen.
 */
function simulate(opts: { fps: number; jitterMs: number; phase: number; seed?: number; ptsMs?: (k: number) => number; drawAtOnce?: boolean }): Sim {
  const pacer = new FramePacer()
  pacer.configure(opts.fps, 'lowest')
  const r = rng(opts.seed ?? 1)
  const pts = opts.ptsMs ?? ((k: number) => k * BEAT)
  const frames = Array.from({ length: 600 }, (_, k) => ({ k, pts: pts(k), ready: pts(k) + 5 + r() * opts.jitterMs }))
  const queue: { k: number; at: number; ready: number }[] = []
  let next = 0
  let last = -1
  let repeats = 0
  let wait = 0
  let shown = 0
  const end = frames[frames.length - 1].ready + 100
  for (let t = opts.phase; t < end; t += BEAT) {
    while (next < frames.length && frames[next].ready <= t) {
      const f = frames[next++]
      queue.push({ k: f.k, ready: f.ready, at: pacer.place(f.pts * 1000, f.ready) })
    }
    const i = opts.drawAtOnce ? queue.length - 1 : pickFrame(queue.map((q) => q.at), t)
    if (i >= 0) {
      queue.splice(0, i)
      const q = queue.shift()!
      wait += t - q.ready
      shown++
      last = q.k
    } else if (last >= 60 && next < frames.length) {
      repeats++
    }
  }
  return { repeats, skipped: frames.length - shown, waitMs: wait / shown }
}

test('frames drawn the moment they are decoded double and skip refreshes when they arrive unevenly', () => {
  let stutter = 0
  for (let phase = 0; phase < BEAT; phase += 2) {
    const s = simulate({ fps: 0, jitterMs: 8, phase, drawAtOnce: true })
    stutter += s.repeats + s.skipped
  }
  assert.ok(stutter > 100, `expected stutter without pacing, got ${stutter}`)
})

test('paced frames: one new frame per refresh with 8 ms of arrival jitter, at every display phase', () => {
  for (let phase = 0; phase < BEAT; phase += 2) {
    for (const seed of [1, 2, 3]) {
      const s = simulate({ fps: 60, jitterMs: 8, phase, seed })
      assert.equal(s.repeats, 0, `phase ${phase} seed ${seed}: ${s.repeats} repeated refreshes`)
      assert.ok(s.skipped <= 2, `phase ${phase} seed ${seed}: ${s.skipped} frames skipped`)
      assert.ok(s.waitMs < BEAT + 10, `phase ${phase}: waited ${s.waitMs} ms`)
    }
  }
})

test('a 144 Hz monitor sampled at 60 fps: capture times 13.9 / 20.8 ms apart still give an even grid', () => {
  const comp = 1000 / 144
  // the sharer encodes the first composition at or after a quarter beat before each beat
  const pts = (k: number) => Math.ceil((k * BEAT - BEAT / 4) / comp) * comp
  const pacer = new FramePacer()
  pacer.configure(60, 'lowest')
  const at: number[] = []
  for (let k = 0; k < 200; k++) at.push(pacer.place(pts(k) * 1000, pts(k) + 5))
  for (let k = 101; k < 200; k++) assert.ok(Math.abs(at[k] - at[k - 1] - BEAT) < 1e-6, `frame ${k}: ${at[k] - at[k - 1]} ms`)
  const s = simulate({ fps: 60, jitterMs: 3, phase: 7, ptsMs: pts })
  assert.equal(s.repeats, 0)
})

test('a skipped beat keeps its place on the grid; a long pause starts a new grid', () => {
  const pacer = new FramePacer()
  pacer.configure(60, 'lowest')
  let t = 1000
  let pts = 0
  const a = pacer.place(pts, t)
  assert.equal(a, t)
  pts += BEAT * 1000
  const b = pacer.place(pts, (t += BEAT))
  pts += 2 * BEAT * 1000 // nothing new on the sharer's screen for one beat
  const c = pacer.place(pts, (t += 2 * BEAT))
  assert.ok(Math.abs(c - b - 2 * BEAT) < 1e-6)
  pts += 2_000_000 // 2 s pause
  t += 2000
  assert.equal(pacer.place(pts, t), t)
})

test('the delay stays within one beat above the fastest frame in lowest mode, three in smooth mode', () => {
  for (const [mode, cap] of [['lowest', BEAT], ['smooth', 3 * BEAT]] as const) {
    const pacer = new FramePacer()
    pacer.configure(60, mode)
    const r = rng(7)
    let worst = 0
    for (let k = 0; k < 600; k++) {
      const ready = k * BEAT + r() * 80
      const at = pacer.place(k * BEAT * 1000, ready)
      if (k > 120) worst = Math.max(worst, pacer.addedMs())
      assert.ok(at >= k * BEAT - 1e-6, 'never shown before the fastest path could bring it')
    }
    assert.ok(worst <= cap + 1e-6, `${mode}: added ${worst} ms`)
  }
})

test('without the sharer fps every frame is due at once', () => {
  const pacer = new FramePacer()
  pacer.configure(0, 'lowest')
  assert.equal(pacer.place(123_000, 456), 456)
  assert.equal(pacer.place(140_000, 470), 470)
})

test('pickFrame: the newest due frame; the older due ones are skipped', () => {
  assert.equal(pickFrame([], 100), -1)
  assert.equal(pickFrame([101], 100), -1)
  assert.equal(pickFrame([100], 100), 0)
  assert.equal(pickFrame([95, 104], 100), 0)
  assert.equal(pickFrame([70, 80, 90, 104], 100), 2)
})

test('one frame decoded far too late costs one repeated refresh, not a refresh of delay for good', () => {
  const pacer = new FramePacer()
  pacer.configure(60, 'lowest')
  const queue: { k: number; at: number; ready: number }[] = []
  const shownAt = new Map<number, number>()
  let next = 0
  const frames = Array.from({ length: 300 }, (_, k) => ({ k, ready: k * BEAT + 5 + (k === 150 ? 40 : 0) }))
  for (let t = 3; t < 300 * BEAT + 100; t += BEAT) {
    while (next < frames.length && frames[next].ready <= t) {
      const f = frames[next++]
      queue.push({ k: f.k, ready: f.ready, at: pacer.place(f.k * BEAT * 1000, f.ready) })
    }
    const i = pickFrame(queue.map((q) => q.at), t)
    if (i >= 0) {
      queue.splice(0, i)
      const q = queue.shift()!
      shownAt.set(q.k, t - q.ready)
    }
  }
  // before and well after the late frame, every frame waits the same short time
  const wait = (from: number, to: number) => Math.max(...Array.from({ length: to - from }, (_, j) => shownAt.get(from + j) ?? Infinity))
  assert.ok(wait(100, 140) < BEAT, `before: ${wait(100, 140)} ms`)
  assert.ok(wait(160, 280) < BEAT, `after: ${wait(160, 280)} ms`)
})

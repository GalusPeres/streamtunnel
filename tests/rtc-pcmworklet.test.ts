// Unit tests for the native path's AudioWorklet ring buffer (src/rtc/pcmworklet.js) in plain Node, with the worklet
// globals faked: 20 ms blocks of a 440 Hz sine against clock drift, stalls, bursts and restarts.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const RATE = 48_000
const QUANTUM = 128
const BLOCK = 960

type Player = any
const g = globalThis as Record<string, unknown>
let PlayerClass: (new (options: unknown) => Player) | null = null
g.sampleRate = RATE
g.currentTime = 0
g.AudioWorkletProcessor = class {
  port = { onmessage: null as unknown, postMessage: (_m: unknown): void => {} }
}
g.registerProcessor = (_name: string, cls: new (options: unknown) => Player): void => {
  PlayerClass = cls
}
await import(new URL('../src/rtc/pcmworklet.js', import.meta.url).href)

const ms = (frames: number): number => (frames * 1000) / RATE

/** s16 stereo: `frames` frames of a 440 Hz sine at half scale, from sample `at` of the sharer's stream. */
function sine(at: number, frames = BLOCK): ArrayBuffer {
  const s = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(16384 * Math.sin((2 * Math.PI * 440 * (at + i)) / RATE))
    s[2 * i] = v
    s[2 * i + 1] = v
  }
  return s.buffer
}

/** A player and the two clocks: frames played by us, frames sent by the sharer. */
class Harness {
  readonly p: Player
  played = 0
  sent = 0
  /** position in the sine (= sent, plus blocks delivered twice) */
  at = 0
  /** largest step between neighbouring output samples while playing (a cut without crossfade jumps up to 1) */
  maxStep = 0
  /** fill after each quantum (ms) of the last `play` */
  fills: number[] = []
  private prev = 0

  constructor() {
    if (!PlayerClass) throw new Error('worklet not registered')
    this.p = new PlayerClass({ processorOptions: { targetMs: 40, maxMs: 100 } })
  }

  send(blocks = 1): void {
    this.extra(blocks)
    this.sent += blocks * BLOCK
  }

  /** blocks on top of the sharer's schedule (the sine continues; the next scheduled block comes on time) */
  extra(blocks: number): void {
    for (let k = 0; k < blocks; k++) {
      this.p.push(sine(this.at))
      this.at += BLOCK
    }
  }

  tick(): void {
    const l = new Float32Array(QUANTUM)
    const r = new Float32Array(QUANTUM)
    g.currentTime = this.played / RATE
    const was = this.p.playing as boolean
    this.p.process([], [[l, r]])
    if (was && this.p.playing) {
      for (let i = 0; i < QUANTUM; i++) {
        this.maxStep = Math.max(this.maxStep, Math.abs(l[i] - (i === 0 ? this.prev : l[i - 1])))
      }
    }
    this.prev = l[QUANTUM - 1]
    this.played += QUANTUM
    this.fills.push(ms(this.p.count))
  }

  /**
   * Plays `seconds`; the sharer completes a block every 20 ms of its own clock, which runs `drift` faster than ours
   * (1e-3 = 0.1 %). `arrive(t)` = when a block completed at our frame `t` reaches the worklet (stalls, jitter).
   */
  play(seconds: number, opts: { drift?: number; arrive?: (t: number) => number; sending?: boolean } = {}): void {
    const { drift = 0, arrive = (t: number) => t, sending = true } = opts
    const end = this.played + seconds * RATE
    this.fills = []
    while (this.played < end) {
      while (sending && arrive((this.sent + BLOCK) / (1 + drift)) <= this.played) this.send()
      this.tick()
    }
  }

  /** the lowest fill of the last `seconds` (ms) */
  low(seconds: number): number {
    return Math.min(...this.fills.slice(-Math.round((seconds * RATE) / QUANTUM)))
  }

  high(seconds: number): number {
    return Math.max(...this.fills.slice(-Math.round((seconds * RATE) / QUANTUM)))
  }
}

/** up to 3 ms of IPC jitter per block, fixed pseudo-random */
function jitter(t: number): number {
  const k = Math.round(t / BLOCK)
  return t + ((k * 2_654_435_761) % 1000) * 0.144
}

/** Starts a harness and plays until the stream has settled (the sharer's clock may drift). */
function started(drift = 0): Harness {
  const h = new Harness()
  h.play(3, { drift, arrive: jitter })
  assert.equal(h.p.playing, true)
  return h
}

test('a steady stream plays without underruns near its goal and is never cut', () => {
  const h = started()
  h.play(60, { arrive: jitter })
  assert.equal(h.p.underruns, 0)
  assert.equal(h.p.dropped, 0)
  // the lowest fill sits at target − one block (20 ms) within the dead band, the highest one block above
  assert.ok(h.low(60) > 10 && h.low(60) < 24, `lowest fill ${h.low(60)} ms`)
  assert.ok(h.high(60) < 46, `highest fill ${h.high(60)} ms`)
  assert.ok(h.maxStep < 0.04, `output step ${h.maxStep}`)
})

test('clock drift between the two sound cards is followed, either way', () => {
  for (const drift of [1e-3, -1e-3]) {
    // 0.1 % for 3 minutes = 180 ms the buffer would gain or lose without control
    const h = started(drift)
    h.play(180, { drift, arrive: jitter })
    assert.equal(h.p.underruns, 0, `drift ${drift}: underruns`)
    assert.equal(h.p.dropped, 0, `drift ${drift}: cut ${ms(h.p.dropped)} ms`)
    assert.ok(h.low(30) > 10 && h.high(30) < 48, `drift ${drift}: fill ${h.low(30)}…${h.high(30)} ms`)
    assert.ok(h.maxStep < 0.04, `drift ${drift}: output step ${h.maxStep}`)
  }
})

test('the burst after a stall does not stay in the buffer', () => {
  const h = started()
  // 100 ms without blocks (main thread or IPC stall), then the missed ones at once
  const from = h.played
  const until = from + 0.1 * RATE
  const stall = (t: number): number => (t > from && t < until ? until : jitter(t))
  h.play(0.3, { arrive: stall })
  assert.equal(h.p.underruns, 1)
  h.play(3, { arrive: jitter })
  // the extra fill is gone within a few seconds: back at the goal, not 80 ms above it
  assert.ok(h.low(1) < 24 && h.high(1) < 46, `fill after the stall ${h.low(1)}…${h.high(1)} ms`)
  h.play(30, { arrive: jitter })
  assert.equal(h.p.underruns, 1)
})

test('a burst while playing is cut with a crossfade', () => {
  const h = started()
  h.extra(3) // 60 ms more at once that stay (without an underrun before them)
  h.play(3, { arrive: jitter })
  assert.equal(h.p.underruns, 0)
  assert.ok(ms(h.p.dropped) > 40 && ms(h.p.dropped) < 70, `cut ${ms(h.p.dropped)} ms`)
  assert.ok(h.high(1) < 46, `fill ${h.high(1)} ms`)
  // a cut without crossfade jumps by up to the full amplitude
  assert.ok(h.maxStep < 0.06, `output step ${h.maxStep}`)
  // more than 100 ms is cut at once, down to the target
  h.extra(5)
  h.tick()
  assert.ok(ms(h.p.count) <= 40, `fill after the hard cut ${ms(h.p.count)} ms`)
})

test('after every underrun playback restarts with the full margin, so one gap stays one gap', () => {
  const h = started()
  for (const gap of [0.06, 0.5, 0.06]) {
    // the sound stops (or a block is lost) and comes back
    const before = h.p.underruns as number
    h.play(gap, { sending: false })
    assert.equal(h.p.playing, false)
    assert.equal(h.p.underruns, before + 1)
    h.sent = Math.ceil(h.played / BLOCK) * BLOCK
    h.at = h.sent
    h.send()
    h.tick()
    assert.equal(h.p.playing, false, 'one block is no margin')
    h.play(0.1, { arrive: jitter })
    assert.equal(h.p.playing, true)
    // the next blocks come with the usual jitter: no second underrun
    h.play(10, { arrive: jitter })
    assert.equal(h.p.underruns, before + 1, `gap ${gap} s`)
    assert.ok(h.low(2) > 10, `lowest fill ${h.low(2)} ms`)
  }
})

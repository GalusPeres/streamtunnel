// Native path, when each decoded frame is shown (docs/NATIVE-PATH.md §11.2). Frames reach the page unevenly — the
// sharer's encode timing, the network, the IPC hop and the decoder each add a few ms — and drawing every frame the
// moment it is decoded turns that jitter into doubled and skipped display refreshes: micro stutter at a steady
// bitrate (measured on one PC over 127.0.0.1: draw intervals from 13 to 20 ms, p99 up to 28 ms at 60 fps).
// FramePacer gives every frame a playout time on the stream's own beat grid instead:
//   * slot: the previous frame's slot plus one beat (1 / the sharer's fps), or the whole beats between the two capture
//     times when the sharer skipped beats (nothing new on screen). One beat per frame also evens out the capture
//     jitter of a 144 Hz monitor sampled at 60 fps;
//   * lateness = decoded − slot; the playout delay follows the largest lateness of the last WINDOW_MS that is at
//     most `cap` above the smallest (the fastest frame never waits longer than that; a frame later than that is
//     shown late and leaves the delay alone). It rises at once and falls once a second.
// pickFrame then chooses, once per display refresh, the frame to show.

/** Lateness history kept (ms). */
const WINDOW_MS = 2000
/** A capture gap of more than this many beats means the sharer skipped beats. */
const GAP_BEATS = 1.75
/** A capture gap longer than this (or a step back) starts a new grid (ms). */
const MAX_GAP_MS = 500
/** Added to the largest lateness (ms). */
const MARGIN_MS = 1
/** The delay falls at most this often (ms) ... */
const LOWER_EVERY_MS = 1000
/** ... and only when it would fall by more than this (ms). */
const LOWER_MIN_MS = 1

export class FramePacer {
  /** 1 / fps (ms), 0 = unknown: no pacing */
  private beat = 0
  /** most added delay above the fastest frame (ms) */
  private capMs = 0
  private last: { pts: number; slot: number } | null = null
  /** playout = slot + delay (ms) */
  private delay = 0
  private hist: { at: number; late: number }[] = []
  private lowerAt = 0

  /** The sharer's fps (0 = unknown) and how much delay the viewer accepts at most. */
  configure(fps: number, mode: 'lowest' | 'smooth'): void {
    const beat = fps > 0 && fps <= 1000 ? 1000 / fps : 0
    if (beat !== this.beat) this.reset()
    this.beat = beat
    // 'lowest': one beat (at least 12 ms); 'smooth': three beats (at least 50 ms)
    this.capMs = mode === 'smooth' ? Math.max(3 * beat, 50) : Math.max(beat, 12)
  }

  reset(): void {
    this.last = null
    this.hist = []
    this.delay = 0
  }

  /** Delay above the fastest frame of the window (ms): what the pacing costs. */
  addedMs(): number {
    if (this.hist.length === 0) return 0
    return Math.max(0, this.delay - Math.min(...this.hist.map((h) => h.late)))
  }

  /** Playout time (performance.now ms) of a frame captured at `ptsUs` (sharer clock) and decoded at `readyMs`. */
  place(ptsUs: number, readyMs: number): number {
    const beat = this.beat
    if (beat <= 0) return readyMs
    const d = this.last ? (ptsUs - this.last.pts) / 1000 : -1
    if (!this.last || d <= -MAX_GAP_MS || d > MAX_GAP_MS) {
      // first frame, a pause or a restart of the sharer's clock: a new grid with this frame shown at once
      this.reset()
      this.last = { pts: ptsUs, slot: readyMs }
      this.hist.push({ at: readyMs, late: 0 })
      return readyMs
    }
    const slot = this.last.slot + (d > GAP_BEATS * beat ? Math.round(d / beat) : 1) * beat
    this.last = { pts: ptsUs, slot }
    const late = readyMs - slot
    this.hist.push({ at: readyMs, late })
    while (this.hist.length > 1 && readyMs - this.hist[0].at > WINDOW_MS) this.hist.shift()
    let floor = Infinity
    for (const h of this.hist) floor = Math.min(floor, h.late)
    const cap = floor + this.capMs
    // a frame later than the cap allows is shown late anyway: it does not raise the delay (one hiccup would otherwise
    // keep the whole window at the cap)
    let top = -Infinity
    for (const h of this.hist) if (h.late + MARGIN_MS <= cap) top = Math.max(top, h.late)
    if (late + MARGIN_MS > this.delay && late + MARGIN_MS <= cap) {
      this.delay = late + MARGIN_MS
    } else if (readyMs >= this.lowerAt) {
      this.lowerAt = readyMs + LOWER_EVERY_MS
      if (top + MARGIN_MS < this.delay - LOWER_MIN_MS) this.delay = top + MARGIN_MS
    }
    this.delay = Math.min(this.delay, cap)
    return slot + this.delay
  }
}

/**
 * Which queued frame (playout times `at`, oldest first) a display refresh at `t` shows: the newest one due (at ≤ t);
 * the older due ones are skipped. A frame is decoded before its playout time, so it is always there when its refresh
 * comes and is shown on the first refresh after its playout time — the same refresh whatever its decode moment. Two
 * frames due at once (one decoded later than the pacing's cap allows, a lowered delay, the sharer's clock drifting
 * against the display) cost one skipped frame and never leave the picture a refresh behind.
 * Returns the index to show (the frames before it are skipped), -1 for none.
 */
export function pickFrame(at: readonly number[], t: number): number {
  let i = -1
  while (i + 1 < at.length && at[i + 1] <= t) i++
  return i
}

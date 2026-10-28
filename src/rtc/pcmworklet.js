// AudioWorklet of the native path (nativeplayer.ts, docs/NATIVE-PATH.md §11.2): plays the 20 ms s16 PCM blocks of a
// native watch link through a ring buffer.
// * Playback starts at the target fill (40 ms), and after an underrun again only at the target: restarting with a
//   single 20 ms block leaves no margin for the next one, so one gap would become several.
// * Fill control: once a second the lowest fill of that second is compared with the target minus one block (the
//   lowest fill of a steady stream that started at the target). Off by more than 3 ms, playback runs up to 0.5 %
//   faster or slower (linear interpolation, inaudible) until it fits again; that follows the clock drift between the
//   sharer's sound card and ours. More than one block too much for a whole second (the burst after a stall) is cut
//   at once, and so is anything above 100 ms, with a crossfade over one render quantum.
// A static file loaded with audioWorklet.addModule (imported with ?url&no-inline), so the CSP stays unchanged.
// Every second it reports { bufferedMs, underruns, droppedMs, blocks, playing } over its port.

/** Fill control: the most playback speeds up or slows down. */
const MAX_ADJUST = 0.005
/** Fill control: no correction while the lowest fill is this close to its goal (ms; one render quantum is 2.7 ms). */
const DEADBAND_MS = 3
/** Fill control: the correction removes the error in about this long (s), within MAX_ADJUST. */
const SETTLE_S = 2

class StPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    const frames = (ms) => Math.round((ms * sampleRate) / 1000)
    this.frames = frames
    this.target = frames(o.targetMs || 40)
    this.max = frames(o.maxMs || 100)
    this.cap = frames(1000)
    this.l = new Float32Array(this.cap)
    this.r = new Float32Array(this.cap)
    this.readAt = 0
    this.writeAt = 0
    this.count = 0
    /** fractional read position between readAt and the next frame (resampling) */
    this.frac = 0
    /** input frames per output frame (1 ± MAX_ADJUST) */
    this.ratio = 1
    /** frames to cut at the next quantum (crossfaded) */
    this.skip = 0
    /** frames of the last block pushed */
    this.block = frames(20)
    this.playing = false
    /** lowest fill of the current second, and how much of it was played */
    this.low = Infinity
    this.seen = 0
    this.underruns = 0
    this.dropped = 0
    this.blocks = 0
    this.reportAt = currentTime + 1
    this.port.onmessage = (e) => this.push(e.data)
  }

  /** One block: ArrayBuffer of s16 interleaved stereo. */
  push(buf) {
    if (!(buf instanceof ArrayBuffer)) return
    const s = new Int16Array(buf)
    const frames = s.length >> 1
    for (let i = 0; i < frames; i++) {
      if (this.count === this.cap) {
        this.readAt = (this.readAt + 1) % this.cap
        this.count--
        this.dropped++
      }
      this.l[this.writeAt] = s[2 * i] / 32768
      this.r[this.writeAt] = s[2 * i + 1] / 32768
      this.writeAt = (this.writeAt + 1) % this.cap
      this.count++
    }
    if (frames > 0) this.block = frames
    this.blocks++
  }

  /** Once per second of playback: new speed, or a cut, from the lowest fill of that second. */
  steer() {
    const goal = Math.max(this.target - this.block, this.frames(5))
    const err = this.low - goal
    this.low = Infinity
    this.seen = 0
    if (err > this.block) {
      this.skip = err
      this.ratio = 1
    } else if (Math.abs(err) <= this.frames(DEADBAND_MS)) {
      this.ratio = 1
    } else {
      const adjust = err / (SETTLE_S * sampleRate)
      this.ratio = 1 + Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, adjust))
    }
  }

  /** Cuts `skip` frames: this quantum fades from the current position to the one after the cut. */
  cut(left, right, n) {
    const cap = this.cap
    for (let i = 0; i < n; i++) {
      const a = (this.readAt + i) % cap
      const b = (this.readAt + this.skip + i) % cap
      const w = (i + 1) / n
      left[i] = this.l[a] * (1 - w) + this.l[b] * w
      right[i] = this.r[a] * (1 - w) + this.r[b] * w
    }
    this.readAt = (this.readAt + this.skip + n) % cap
    this.count -= this.skip + n
    this.dropped += this.skip
    this.skip = 0
    this.frac = 0
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out[1] || out[0]
    const n = left.length
    if (!this.playing && this.count >= this.target) {
      this.playing = true
      this.low = Infinity
      this.seen = 0
      this.frac = 0
    }
    if (this.playing && this.count > this.max) this.skip = this.count - this.target
    let i = 0
    if (this.playing && this.skip > 0 && this.count >= this.skip + n) {
      this.cut(left, right, n)
      i = n
    } else if (this.playing) {
      this.skip = 0
      const cap = this.cap
      for (; i < n && this.count > 0; i++) {
        const a = this.readAt
        if (this.frac > 0 && this.count > 1) {
          const b = (a + 1) % cap
          left[i] = this.l[a] + (this.l[b] - this.l[a]) * this.frac
          right[i] = this.r[a] + (this.r[b] - this.r[a]) * this.frac
        } else {
          left[i] = this.l[a]
          right[i] = this.r[a]
        }
        this.frac += this.ratio
        while (this.frac >= 1 && this.count > 0) {
          this.readAt = (this.readAt + 1) % cap
          this.count--
          this.frac -= 1
        }
      }
      if (i < n) {
        this.playing = false
        this.ratio = 1
        this.underruns++
      }
    }
    if (this.playing) {
      if (this.count < this.low) this.low = this.count
      this.seen += n
      if (this.seen >= sampleRate) this.steer()
    }
    for (; i < n; i++) {
      left[i] = 0
      right[i] = 0
    }
    if (currentTime >= this.reportAt) {
      this.reportAt = currentTime + 1
      this.port.postMessage({
        bufferedMs: (this.count * 1000) / sampleRate,
        underruns: this.underruns,
        droppedMs: (this.dropped * 1000) / sampleRate,
        blocks: this.blocks,
        playing: this.playing,
      })
    }
    return true
  }
}

registerProcessor('st-pcm', StPcmPlayer)

// AudioWorklet of the native path (nativeplayer.ts, docs/NATIVE-PATH.md §11.2): plays the 20 ms s16 PCM blocks of a
// native watch link through a ring buffer. Playback starts at the target fill (40 ms); after an underrun it waits
// until 20 ms are buffered again; above 120 ms (a burst after a stall) it drops the oldest audio down to the target.
// A static file loaded with audioWorklet.addModule (imported with ?url&no-inline), so the CSP stays unchanged.
// Every second it reports { bufferedMs, underruns, droppedMs, blocks, playing } over its port.

class StPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    const frames = (ms) => Math.round((ms * sampleRate) / 1000)
    this.target = frames(o.targetMs || 40)
    this.reprime = frames(o.reprimeMs || 20)
    this.max = frames(o.maxMs || 120)
    this.cap = frames(1000)
    this.l = new Float32Array(this.cap)
    this.r = new Float32Array(this.cap)
    this.readAt = 0
    this.writeAt = 0
    this.count = 0
    this.playing = false
    this.threshold = this.target
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
    this.blocks++
    if (this.count > this.max) {
      const drop = this.count - this.target
      this.readAt = (this.readAt + drop) % this.cap
      this.count -= drop
      this.dropped += drop
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out[1] || out[0]
    const n = left.length
    if (!this.playing && this.count >= this.threshold) this.playing = true
    let i = 0
    if (this.playing) {
      const take = Math.min(n, this.count)
      for (; i < take; i++) {
        left[i] = this.l[this.readAt]
        right[i] = this.r[this.readAt]
        this.readAt = (this.readAt + 1) % this.cap
      }
      this.count -= take
      if (take < n) {
        this.playing = false
        this.threshold = this.reprime
        this.underruns++
      }
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

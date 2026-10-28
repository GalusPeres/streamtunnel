// Native path, the picture and sound of a native watch link (docs/NATIVE-PATH.md §11.2). No Tauri in here:
// nativelink.ts feeds both classes from the link's Channel, tests/e2e/native-decode.mjs feeds them a recorded stream
// in headless Edge.
//   NvVideoRenderer — every access unit is decoded with WebCodecs (hardware preferred, optimizeForLatency) and each
//     decoded frame is drawn at once on a 2D canvas: no jitter buffer, the newest frame wins (like lowlat.ts and the
//     Linux engine in native.ts). A decoder that falls behind or fails skips to the next key frame and asks for one.
//   NvAudioPlayer — 20 ms PCM blocks go into an AudioWorklet ring buffer (pcmworklet.js); its output is a
//     MediaStream, so the watch view's <audio> keeps volume and mute.
import type { NvAudioMessage, NvVideoMessage } from './nativelink.ts'
import { avcCodecString } from './native.ts'

/** WebCodecs codec strings for the capability check (the stream's real level is read from its SPS). */
export const NV_HEVC_CODEC = 'hvc1.1.6.L153.B0'
export const NV_H264_CODEC = 'avc1.640033'

/** More frames waiting in the decoder than this → skip to the next key frame (latency must not pile up). */
const MAX_DECODE_QUEUE = 2
/** This many decoder errors within ERROR_WINDOW_MS → give up (the session falls back to WebRTC). */
const MAX_ERRORS = 3
const ERROR_WINDOW_MS = 5000
/** Key frame requests are sent at most this often (ms). */
const KEY_REQUEST_MS = 300

export interface NvVideoStats {
  /** totals */
  received: number
  drawn: number
  dropped: number
  errors: number
  bytes: number
  width: number
  height: number
  /** decoder codec string, '' before the first key frame */
  codec: string
  /** the decoder was configured with prefer-hardware (WebCodecs does not say more) */
  hw: boolean | null
  /** averages over the frames drawn since the previous sample (ms), null if none */
  decodeMs: number | null
  /** capture → drawn: the link's age + IPC + decode + draw (ms), null while the clock offset is unknown */
  latencyMs: number | null
  ipcMs: number | null
}

interface Submitted {
  /** performance.now() when the message arrived */
  at: number
  ageMs: number
  ipcMs: number
}

/** Decoder config for a codec string: hardware first; H.264 may also decode in software. Cached. */
const configCache = new Map<string, Promise<VideoDecoderConfig | null>>()
function pickConfig(codec: string, softwareOk: boolean): Promise<VideoDecoderConfig | null> {
  let p = configCache.get(codec)
  if (!p) {
    p = (async () => {
      const accel: HardwareAcceleration[] = softwareOk ? ['prefer-hardware', 'no-preference'] : ['prefer-hardware']
      for (const hardwareAcceleration of accel) {
        const cfg: VideoDecoderConfig = { codec, optimizeForLatency: true, hardwareAcceleration }
        try {
          if ((await VideoDecoder.isConfigSupported(cfg)).supported) return cfg
        } catch { /* try the next */ }
      }
      return null
    })()
    configCache.set(codec, p)
  }
  return p
}

/** Wall clock in µs (Rust stamps each message with its own; the difference is the IPC delay). */
const epochUs = (): number => (performance.timeOrigin + performance.now()) * 1000

export class NvVideoRenderer {
  readonly canvas: HTMLCanvasElement
  /** the first frame was drawn */
  onFirstFrame: () => void = () => {}
  /** the decoder needs a key frame (nm_link_keyframe) */
  onKeyframeNeeded: () => void = () => {}
  /** the decoder keeps failing or is missing: give the native path up */
  onFatal: (reason: string) => void = () => {}

  private readonly ctx: CanvasRenderingContext2D | null
  private decoder: VideoDecoder | null = null
  private codec = ''
  private configuring: string | null = null
  /** key frame that arrived while the decoder was being configured (decoded right after) */
  private pendingKey: NvVideoMessage | null = null
  private pendingMeta: Submitted | null = null
  private waitKey = true
  private closed = false
  private fatal = false
  private hw: boolean | null = null
  private lastTs = -1
  private lastKeyReq = -Infinity
  private readonly errorTimes: number[] = []
  private readonly submitted = new Map<number, Submitted>()
  private received = 0
  private drawn = 0
  private dropped = 0
  private errors = 0
  private bytes = 0
  private width = 0
  private height = 0
  private decSum = 0
  private latSum = 0
  private latN = 0
  private ipcSum = 0
  private sumN = 0

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'viewer-canvas'
    this.canvas.id = 'viewer-canvas'
    this.canvas.width = 1280
    this.canvas.height = 720
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
  }

  push(m: NvVideoMessage): void {
    if (this.closed || this.fatal) return
    const at = performance.now()
    this.received++
    this.bytes += m.data.byteLength
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      this.dropped++
      this.giveUp('no WebCodecs')
      return
    }
    // Repeated frames may carry an older capture time: keep the decoder's timestamps strictly increasing.
    const ts = m.ptsUs > this.lastTs ? m.ptsUs : this.lastTs + 1
    this.lastTs = ts
    const sentUs = m.sentEpochUs
    const ipcMs = sentUs > 0 ? Math.min(1000, Math.max(0, (epochUs() - sentUs) / 1000)) : 0
    const msg: NvVideoMessage = ts === m.ptsUs ? m : { ...m, ptsUs: ts }
    const meta: Submitted = { at, ageMs: m.ageUs / 1000, ipcMs }
    if (m.key) {
      const codec = m.codec === 'hevc' ? NV_HEVC_CODEC : (avcCodecString(m.data) ?? NV_H264_CODEC)
      if (codec !== this.codec || !this.decoder || this.decoder.state !== 'configured') {
        this.pendingKey = msg
        this.pendingMeta = meta
        if (this.configuring !== codec) void this.configure(codec, m.codec === 'h264')
        return
      }
    }
    const dec = this.decoder
    if (this.configuring !== null || !dec || dec.state !== 'configured' || (this.waitKey && !m.key)) {
      this.dropped++
      if (this.configuring === null) this.requestKey()
      return
    }
    if (!m.key && dec.decodeQueueSize > MAX_DECODE_QUEUE) {
      // falling behind: skip to the next key frame instead of piling up latency
      this.waitKey = true
      this.dropped++
      this.requestKey()
      return
    }
    this.decode(msg, meta)
  }

  private decode(m: NvVideoMessage, meta: Submitted): void {
    const dec = this.decoder
    if (!dec) return
    this.waitKey = false
    if (this.submitted.size > 120) this.submitted.clear()
    this.submitted.set(m.ptsUs, meta)
    try {
      dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ptsUs, data: m.data }))
    } catch (err) {
      this.fail(err)
    }
  }

  private async configure(codec: string, softwareOk: boolean): Promise<void> {
    this.configuring = codec
    const cfg = await pickConfig(codec, softwareOk)
    if (this.closed || this.configuring !== codec) return
    this.configuring = null
    if (!cfg) {
      this.pendingKey = null
      this.giveUp(`no decoder for ${codec}`)
      return
    }
    try {
      if (!this.decoder || this.decoder.state === 'closed') {
        this.decoder = new VideoDecoder({ output: (f) => this.draw(f), error: (e) => this.fail(e) })
      }
      this.decoder.configure(cfg)
      this.codec = codec
      this.hw = cfg.hardwareAcceleration === 'prefer-hardware' ? true : null
      console.info(`[native] VideoDecoder ${codec} (${cfg.hardwareAcceleration})`)
    } catch (err) {
      this.fail(err)
      return
    }
    const k = this.pendingKey
    const meta = this.pendingMeta
    this.pendingKey = null
    this.pendingMeta = null
    if (k && meta) this.decode(k, meta)
    else this.requestKey()
  }

  private draw(frame: VideoFrame): void {
    try {
      if (this.closed) return
      const meta = this.submitted.get(frame.timestamp)
      if (meta) this.submitted.delete(frame.timestamp)
      const decoded = performance.now()
      const w = frame.displayWidth
      const h = frame.displayHeight
      if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
        this.canvas.width = w
        this.canvas.height = h
      }
      this.width = w
      this.height = h
      this.ctx?.drawImage(frame, 0, 0, w, h)
      this.drawn++
      if (meta) {
        const done = performance.now()
        this.decSum += decoded - meta.at
        this.ipcSum += meta.ipcMs
        this.sumN++
        if (meta.ageMs > 0) {
          this.latSum += meta.ageMs + meta.ipcMs + (done - meta.at)
          this.latN++
        }
      }
      if (this.drawn === 1) this.onFirstFrame()
    } finally {
      frame.close()
    }
  }

  private requestKey(): void {
    const now = performance.now()
    if (now - this.lastKeyReq < KEY_REQUEST_MS) return
    this.lastKeyReq = now
    this.onKeyframeNeeded()
  }

  private fail(err: unknown): void {
    if (this.closed) return
    this.errors++
    console.warn('[native] decoder error', err instanceof Error ? err.message : String(err))
    try { this.decoder?.close() } catch { /* ignore */ }
    this.decoder = null
    this.codec = '' // the next key frame configures a fresh decoder
    this.waitKey = true
    const now = performance.now()
    this.errorTimes.push(now)
    while (this.errorTimes.length > 0 && now - this.errorTimes[0] > ERROR_WINDOW_MS) this.errorTimes.shift()
    if (this.errorTimes.length >= MAX_ERRORS) {
      this.giveUp('decoder')
      return
    }
    this.requestKey()
  }

  private giveUp(reason: string): void {
    if (this.fatal) return
    this.fatal = true
    this.onFatal(reason)
  }

  /** Counters; the averages cover the frames drawn since the previous call. */
  sample(): NvVideoStats {
    const s: NvVideoStats = {
      received: this.received,
      drawn: this.drawn,
      dropped: this.dropped,
      errors: this.errors,
      bytes: this.bytes,
      width: this.width,
      height: this.height,
      codec: this.codec,
      hw: this.hw,
      decodeMs: this.sumN > 0 ? this.decSum / this.sumN : null,
      latencyMs: this.latN > 0 ? this.latSum / this.latN : null,
      ipcMs: this.sumN > 0 ? this.ipcSum / this.sumN : null,
    }
    this.decSum = this.latSum = this.ipcSum = 0
    this.sumN = this.latN = 0
    return s
  }

  close(): void {
    this.closed = true
    try { this.decoder?.close() } catch { /* ignore */ }
    this.decoder = null
    this.pendingKey = null
    this.submitted.clear()
    this.canvas.remove()
  }
}

// ───────────────────────── sound ─────────────────────────

export interface NvAudioStats {
  /** blocks handed to the worklet (total) */
  blocks: number
  bytes: number
  /** from the worklet, about once a second */
  bufferedMs: number
  underruns: number
  droppedMs: number
  playing: boolean
}

type WorkletReport = Omit<NvAudioStats, 'blocks' | 'bytes'>

/** Ring buffer (docs/NATIVE-PATH.md §11.2): target 40 ms, re-prime at 20 ms after an underrun, drop above 120 ms. */
const RING = { targetMs: 40, reprimeMs: 20, maxMs: 120 }

export class NvAudioPlayer {
  /** the sound as a MediaStream for the watch view's <audio>; null if the AudioWorklet could not start */
  readonly ready: Promise<MediaStream | null>

  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private closed = false
  private blocks = 0
  private bytes = 0
  private last: WorkletReport = { bufferedMs: 0, underruns: 0, droppedMs: 0, playing: false }
  /** autoplay rules: resume on the first click / key press if the context starts suspended */
  private readonly onGesture = (): void => {
    void this.ctx?.resume().catch(() => {})
  }

  constructor() {
    this.ready = this.start().catch((err: unknown) => {
      console.warn('[native] audio not available', err instanceof Error ? err.message : String(err))
      return null
    })
  }

  private async start(): Promise<MediaStream | null> {
    if (typeof AudioWorkletNode !== 'function') return null
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
    this.ctx = ctx
    const url = (await import('./pcmworklet.js?url&no-inline')).default
    await ctx.audioWorklet.addModule(url)
    if (this.closed) return null
    const node = new AudioWorkletNode(ctx, 'st-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: RING })
    node.port.onmessage = (e: MessageEvent) => {
      this.last = e.data as WorkletReport
    }
    const dest = ctx.createMediaStreamDestination()
    node.connect(dest)
    this.node = node
    void ctx.resume().catch(() => {})
    document.addEventListener('pointerdown', this.onGesture, { capture: true })
    document.addEventListener('keydown', this.onGesture, { capture: true })
    return dest.stream
  }

  push(m: NvAudioMessage): void {
    if (this.closed || m.channels !== 2) return
    this.blocks++
    this.bytes += m.pcm.byteLength
    const node = this.node
    if (!node) return // still starting: the ring buffer fills from the next block on
    const copy = m.pcm.slice()
    node.port.postMessage(copy.buffer, [copy.buffer])
  }

  stats(): NvAudioStats {
    return { blocks: this.blocks, bytes: this.bytes, ...this.last }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    document.removeEventListener('pointerdown', this.onGesture, { capture: true })
    document.removeEventListener('keydown', this.onGesture, { capture: true })
    try { this.node?.disconnect() } catch { /* ignore */ }
    this.node = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

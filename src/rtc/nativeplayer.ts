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

/**
 * More frames waiting in the decoder than this for BACKLOG_MS, or more than MAX_DECODE_QUEUE_BURST at all → skip to
 * the next key frame (latency must not pile up; a short stall of a hardware decoder drains by itself within a few ms
 * and is no reason for a key frame).
 */
const MAX_DECODE_QUEUE = 2
const BACKLOG_MS = 100
const MAX_DECODE_QUEUE_BURST = 8
/**
 * Until a freshly configured decoder hands out its first frame it may hold this many (a hardware decoder needs tens
 * of ms to start, and the frames that arrived while it was being configured go in at once); also the most frames
 * kept while it is being configured.
 */
const MAX_DECODE_QUEUE_START = 30
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

/** Reads an RBSP bit by bit (exp-Golomb included). Throws past the end. */
class Bits {
  private pos = 0
  private readonly b: Uint8Array

  constructor(b: Uint8Array) {
    this.b = b
  }

  u(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3]
      if (byte === undefined) throw new Error('end of SPS')
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1)
      this.pos++
    }
    return v
  }

  ue(): number {
    let zeros = 0
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('bad exp-Golomb code')
    return 2 ** zeros - 1 + this.u(zeros)
  }
}

/**
 * Picture size from the HEVC SPS of an access unit (Annex B), conformance window applied; null without a readable
 * SPS. WebCodecs needs it for HEVC: configured without codedWidth / codedHeight, Chromium's HEVC decoder hands out
 * every frame with a 1280x720 visible rect (its placeholder size), whatever the stream's size.
 */
export function hevcPictureSize(au: Uint8Array): { width: number; height: number } | null {
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue
    const start = i + 3
    if (start + 2 >= au.length || ((au[start] >> 1) & 0x3f) !== 33) continue
    // the SPS's RBSP: up to the next start code, emulation prevention bytes (00 00 03) removed
    const rbsp: number[] = []
    let zeros = 0
    for (let j = start + 2; j < au.length; j++) {
      const b = au[j]
      if (zeros >= 2 && b === 1) break
      if (zeros >= 2 && b === 3) {
        zeros = 0
        continue
      }
      zeros = b === 0 ? zeros + 1 : 0
      rbsp.push(b)
    }
    try {
      const r = new Bits(Uint8Array.from(rbsp))
      r.u(4) // sps_video_parameter_set_id
      const subLayers = r.u(3) // sps_max_sub_layers_minus1
      r.u(1)
      // profile_tier_level: the general part is 96 bits, then the sub-layers' presence flags and parts
      r.u(48)
      r.u(48)
      const present: [number, number][] = []
      for (let s = 0; s < subLayers; s++) present.push([r.u(1), r.u(1)])
      if (subLayers > 0) for (let s = subLayers; s < 8; s++) r.u(2)
      for (const [profile, level] of present) {
        if (profile) {
          r.u(44)
          r.u(44)
        }
        if (level) r.u(8)
      }
      r.ue() // sps_seq_parameter_set_id
      const chroma = r.ue()
      if (chroma === 3) r.u(1)
      let width = r.ue()
      let height = r.ue()
      if (r.u(1)) {
        // conformance window, in chroma samples
        const [sw, sh] = [chroma === 1 || chroma === 2 ? 2 : 1, chroma === 1 ? 2 : 1]
        width -= sw * (r.ue() + r.ue())
        height -= sh * (r.ue() + r.ue())
      }
      return width > 0 && height > 0 ? { width, height } : null
    } catch {
      return null
    }
  }
  return null
}

/** Wall clock in µs (Rust stamps each message with its own; the difference is the IPC delay). */
const epochUs = (): number => (performance.timeOrigin + performance.now()) * 1000

// ───────────────────────── video track sink (WebKit) ─────────────────────────
//
// WebKit cannot keep up drawing 1440p60 VideoFrames on a 2D canvas: measured in Safari 26.6 on Apple silicon
// (tests/e2e/bench.html, .github/workflows/mac-bench.yml) the renderer showed 15 of 240 frames and waited for key
// frames all the time, while decoding alone took ~8 ms. Frames written into a VideoTrackGenerator (worker-only) and
// shown in a <video> — how WebKit shows WebRTC video — came out 240 of 240, evenly every ~17 ms. Chromium draws on
// the canvas fine (and has no VideoTrackGenerator), so it keeps the canvas.

const SINK_WORKER = `
let writer = null
let pending = 0
onmessage = (e) => {
  const m = e.data
  if (m.t === 'init') {
    try {
      const gen = new VideoTrackGenerator()
      writer = gen.writable.getWriter()
      postMessage({ t: 'track', track: gen.track }, [gen.track])
    } catch (err) {
      postMessage({ t: 'error', error: String(err) })
    }
    return
  }
  const f = m.frame
  // the newest frame wins over a backlog in the track
  if (!writer || pending > 1) {
    f.close()
    return
  }
  pending++
  writer.write(f).then(
    () => { pending--; f.close() },
    () => { pending--; f.close() },
  )
}`

let sinkUrl: string | null = null
function sinkWorker(): Worker {
  sinkUrl ??= URL.createObjectURL(new Blob([SINK_WORKER], { type: 'text/javascript' }))
  return new Worker(sinkUrl)
}

/** A sink worker's first answer: its track, or null when VideoTrackGenerator / track transfer is missing. */
function sinkTrack(w: Worker, timeoutMs: number): Promise<MediaStreamTrack | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    w.onmessage = (e: MessageEvent<{ t: string; track?: MediaStreamTrack }>) => {
      clearTimeout(timer)
      resolve(e.data.t === 'track' && e.data.track ? e.data.track : null)
    }
    w.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
    w.postMessage({ t: 'init' })
  })
}

let trackSinkOk = false
let sinkProbe: Promise<void> | null = null

/**
 * Finds out once whether this page shows native video through a video track (WebKit with VideoTrackGenerator) —
 * awaited before a native watch starts, so NvVideoRenderer can choose its element right away.
 */
export function prepareVideoSink(): Promise<void> {
  sinkProbe ??= (async () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)
    if (!webkit || typeof Worker !== 'function' || typeof MediaStream !== 'function') return
    let w: Worker | null = null
    try {
      w = sinkWorker()
      const track = await sinkTrack(w, 3000)
      trackSinkOk = !!track
      track?.stop()
    } catch {
      trackSinkOk = false
    } finally {
      w?.terminate()
    }
  })()
  return sinkProbe
}

export class NvVideoRenderer {
  /** what the watch view shows: a <video> fed by the sink worker (WebKit), else the canvas the frames are drawn on */
  readonly view: HTMLCanvasElement | HTMLVideoElement
  /** the first frame was drawn */
  onFirstFrame: () => void = () => {}
  /** the decoder needs a key frame (nm_link_keyframe) */
  onKeyframeNeeded: () => void = () => {}
  /** the decoder keeps failing or is missing: give the native path up */
  onFatal: (reason: string) => void = () => {}

  private readonly ctx: CanvasRenderingContext2D | null
  /** the sink worker behind the <video> (WebKit), null with the canvas */
  private readonly sink: Worker | null = null
  private decoder: VideoDecoder | null = null
  private codec = ''
  /** what the decoder is configured for: the codec string, plus the picture size for HEVC */
  private config = ''
  private configuring: string | null = null
  /**
   * The key frame that arrived while the decoder was being configured and every frame after it, decoded right after
   * (dropping a delta here would leave the next ones without their reference)
   */
  private pending: { m: NvVideoMessage; meta: Submitted }[] = []
  /** the current decoder has handed out a frame */
  private started = false
  /** performance.now() since when more than MAX_DECODE_QUEUE frames wait in the decoder, 0 = not */
  private backlogSince = 0
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
    if (trackSinkOk) {
      const v = document.createElement('video')
      v.muted = true
      v.autoplay = true
      v.playsInline = true
      v.disablePictureInPicture = true
      this.view = v
      this.ctx = null
      const w = sinkWorker()
      this.sink = w
      void sinkTrack(w, 3000).then((track) => {
        if (this.closed) {
          track?.stop()
          return
        }
        if (!track) {
          this.giveUp('video sink: no track')
          return
        }
        v.srcObject = new MediaStream([track])
        void v.play().catch(() => {})
      })
    } else {
      const c = document.createElement('canvas')
      c.width = 1280
      c.height = 720
      this.view = c
      this.ctx = c.getContext('2d', { alpha: false, desynchronized: true })
    }
    this.view.className = 'viewer-canvas'
    this.view.id = 'viewer-canvas'
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
      // HEVC needs the picture size in its config (see hevcPictureSize); a new size needs a new config
      const size = m.codec === 'hevc' ? hevcPictureSize(m.data) : null
      const config = size ? `${codec} ${size.width}x${size.height}` : codec
      if (config !== this.config || !this.decoder || this.decoder.state !== 'configured') {
        // a newer key frame replaces whatever waited for the decoder
        this.dropped += this.pending.length
        this.pending = [{ m: msg, meta }]
        if (this.configuring !== config) void this.configure(codec, m.codec === 'h264', size, config)
        return
      }
    }
    if (this.configuring !== null && this.pending.length > 0) {
      if (this.pending.length < MAX_DECODE_QUEUE_START) {
        this.pending.push({ m: msg, meta })
        return
      }
      // configuring takes too long: wait for the next key frame (requested once the decoder is ready)
      this.dropped += this.pending.length
      this.pending = []
    }
    const dec = this.decoder
    if (this.configuring !== null || !dec || dec.state !== 'configured' || (this.waitKey && !m.key)) {
      this.dropped++
      if (this.configuring === null) this.requestKey()
      return
    }
    const queued = dec.decodeQueueSize
    if (queued <= MAX_DECODE_QUEUE) this.backlogSince = 0
    else if (this.backlogSince === 0) this.backlogSince = at
    const behind = this.started
      ? this.backlogSince > 0 && (at - this.backlogSince >= BACKLOG_MS || queued > MAX_DECODE_QUEUE_BURST)
      : queued > MAX_DECODE_QUEUE_START
    if (!m.key && behind) {
      // falling behind: skip to the next key frame instead of piling up latency
      this.backlogSince = 0
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

  private async configure(codec: string, softwareOk: boolean, size: { width: number; height: number } | null, config: string): Promise<void> {
    this.configuring = config
    const cfg = await pickConfig(codec, softwareOk)
    if (this.closed || this.configuring !== config) return
    this.configuring = null
    if (!cfg) {
      this.pending = []
      this.giveUp(`no decoder for ${codec}`)
      return
    }
    try {
      if (!this.decoder || this.decoder.state === 'closed') {
        this.decoder = new VideoDecoder({ output: (f) => this.draw(f), error: (e) => this.fail(e) })
      }
      this.decoder.configure(size ? { ...cfg, codedWidth: size.width, codedHeight: size.height } : cfg)
      this.codec = codec
      this.config = config
      this.started = false
      this.backlogSince = 0
      this.hw = cfg.hardwareAcceleration === 'prefer-hardware' ? true : null
      console.info(`[native] VideoDecoder ${codec} (${cfg.hardwareAcceleration})`)
    } catch (err) {
      this.fail(err)
      return
    }
    const queued = this.pending
    this.pending = []
    for (const p of queued) this.decode(p.m, p.meta)
    if (queued.length === 0) this.requestKey()
  }

  private draw(frame: VideoFrame): void {
    let sent = false
    try {
      if (this.closed) return
      const meta = this.submitted.get(frame.timestamp)
      if (meta) this.submitted.delete(frame.timestamp)
      const decoded = performance.now()
      const w = frame.displayWidth
      const h = frame.displayHeight
      this.width = w
      this.height = h
      if (this.sink) {
        // the worker owns the frame from here (it closes it once the track took it)
        try {
          this.sink.postMessage({ frame }, [frame as unknown as Transferable])
          sent = true
        } catch (err) {
          this.giveUp(`video sink: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
      } else {
        const c = this.view as HTMLCanvasElement
        if (w > 0 && h > 0 && (c.width !== w || c.height !== h)) {
          c.width = w
          c.height = h
        }
        this.ctx?.drawImage(frame, 0, 0, w, h)
      }
      this.drawn++
      this.started = true
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
      if (!sent) frame.close()
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
    this.config = ''
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
    this.pending = []
    this.submitted.clear()
    if (this.sink) {
      this.sink.terminate()
      const v = this.view as HTMLVideoElement
      const s = v.srcObject
      if (s instanceof MediaStream) for (const t of s.getTracks()) t.stop()
      v.srcObject = null
    }
    this.view.remove()
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

/**
 * Ring buffer (docs/NATIVE-PATH.md §11.2): (re)start at 40 ms, cut above 100 ms; the worklet steers the fill back to
 * its goal (clock drift, the burst after a stall).
 */
const RING = { targetMs: 40, maxMs: 100 }

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

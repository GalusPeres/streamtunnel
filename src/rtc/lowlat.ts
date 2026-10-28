// Low-latency receive path (how Parsec shows a stream): every encoded video frame is taken the moment WebRTC has
// assembled it (RTCRtpScriptTransform, before the engine's jitter buffer), decoded on the GPU (WebCodecs,
// optimizeForLatency) and drawn at once on a canvas — the engine's playout buffer and <video> pipeline are skipped.
// Frames are still handed on to the engine, so its loss handling (NACK, keyframe requests) keeps working; if the
// fast path stops producing pictures the watch view falls back to the <video> element.
// Works in WebView2 (Windows) and WebKit (Mac); the Linux app has its own engine (native.ts) and skips this.
import type { CodecName } from '../types.ts'

export interface LowLatencyStats {
  /** frames drawn so far */
  rendered: number
  /** average GPU decode time over the last second (ms), null if nothing was decoded */
  decodeMs: number | null
  errors: number
}

export interface LowLatencyRenderer {
  readonly canvas: HTMLCanvasElement
  /** the codec the sender uses (from our answer); decoding starts with the next key frame */
  setCodec(codec: CodecName | null): void
  /** false = only pass frames on (the 'smooth' mode shows the engine's <video>) */
  setEnabled(on: boolean): void
  stats(): LowLatencyStats
  stop(): void
}

export function lowLatencySupported(): boolean {
  return (
    typeof RTCRtpScriptTransform === 'function' &&
    typeof VideoDecoder === 'function' &&
    typeof EncodedVideoChunk === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  )
}

/**
 * Worker body. Runs in its own global scope (no imports, no closures): it is turned into source text with
 * Function.prototype.toString() and started from a Blob URL, so the single-file web build needs no worker chunk.
 */
function workerMain(): void {
  type Frame = { type: string; data: ArrayBuffer; timestamp?: number; getMetadata?: () => { rtpTimestamp?: number } }
  type Transformer = {
    readable: ReadableStream<Frame>
    writable: WritableStream<Frame>
    options: { canvas: OffscreenCanvas; port: MessagePort }
    sendKeyFrameRequest?: () => Promise<void>
  }
  const scope = self as unknown as { onrtctransform: ((ev: { transformer: Transformer }) => void) | null }
  scope.onrtctransform = (ev) => {
    const tr = ev.transformer
    const { canvas, port } = tr.options
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D | null
    const CODECS: Record<string, string> = { H264: 'avc1.640034', AV1: 'av01.0.13M.08', VP9: 'vp09.00.51.08', VP8: 'vp8' }
    let codec: string | null = null
    let enabled = true
    let dec: VideoDecoder | null = null
    let waitKey = true
    let rendered = 0
    let errors = 0
    let lastKeyReq = 0
    let decSum = 0
    let decN = 0
    const started = new Map<number, number>()
    const reqKey = () => {
      const now = performance.now()
      if (now - lastKeyReq < 300 || !tr.sendKeyFrameRequest) return
      lastKeyReq = now
      tr.sendKeyFrameRequest().catch(() => {})
    }
    const drop = () => {
      try {
        if (dec && dec.state !== 'closed') dec.close()
      } catch {
        /* ignore */
      }
      dec = null
      waitKey = true
    }
    const make = (): void => {
      drop()
      if (!codec) return
      const d = new VideoDecoder({
        output: (f) => {
          const t0 = started.get(f.timestamp)
          if (t0 !== undefined) {
            started.delete(f.timestamp)
            decSum += performance.now() - t0
            decN++
          }
          if (ctx && enabled) {
            const w = f.displayWidth
            const h = f.displayHeight
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w
              canvas.height = h
            }
            ctx.drawImage(f, 0, 0)
            rendered++
          }
          f.close()
        },
        error: () => {
          errors++
          if (dec === d) {
            dec = null
            waitKey = true
          }
          reqKey()
        },
      })
      d.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
      dec = d
      waitKey = true
    }
    port.onmessage = (m: MessageEvent) => {
      const msg = m.data as { codec?: string | null; enabled?: boolean }
      if (msg.codec !== undefined) {
        const next = msg.codec ? CODECS[msg.codec] ?? null : null
        if (next !== codec) {
          codec = next
          drop()
          reqKey()
        }
      }
      if (typeof msg.enabled === 'boolean') {
        enabled = msg.enabled
        if (!enabled) drop()
        else reqKey()
      }
    }
    setInterval(() => {
      port.postMessage({ rendered, decodeMs: decN > 0 ? decSum / decN : null, errors })
      decSum = 0
      decN = 0
    }, 1000)

    const handle = (frame: Frame): void => {
      if (!enabled || !codec || frame.type === 'empty' || frame.data.byteLength === 0) return
      const key = frame.type === 'key'
      if (!dec) {
        if (!key) return reqKey()
        make()
      }
      const d = dec
      if (!d || d.state !== 'configured') return
      if (waitKey && !key) return reqKey()
      // Falling behind (queue grows) → skip to the next key frame instead of piling up delay.
      if (!key && d.decodeQueueSize > 2) {
        waitKey = true
        return reqKey()
      }
      waitKey = false
      const rtp = typeof frame.timestamp === 'number' ? frame.timestamp : (frame.getMetadata?.().rtpTimestamp ?? 0)
      const ts = Math.round((rtp * 1000) / 90) // RTP 90 kHz → µs
      started.set(ts, performance.now())
      if (started.size > 240) started.clear()
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: frame.data }))
    }

    const reader = tr.readable.getReader()
    const writer = tr.writable.getWriter()
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || !value) return
        try {
          handle(value) // EncodedVideoChunk copies the data, so the frame can be passed on afterwards
        } catch {
          errors++
          drop()
          reqKey()
        }
        await writer.write(value)
      }
    })().catch(() => {})
  }
}

let workerUrl: string | null = null

/** Attaches the fast path to a video receiver. null if not supported or it could not be set up. */
export function attachLowLatency(receiver: RTCRtpReceiver): LowLatencyRenderer | null {
  if (!lowLatencySupported()) return null
  try {
    workerUrl ??= URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }))
    const worker = new Worker(workerUrl)
    const canvas = document.createElement('canvas')
    canvas.className = 'viewer-canvas'
    canvas.id = 'viewer-canvas'
    const offscreen = canvas.transferControlToOffscreen()
    const channel = new MessageChannel()
    let last: LowLatencyStats = { rendered: 0, decodeMs: null, errors: 0 }
    channel.port1.onmessage = (m: MessageEvent) => {
      last = m.data as LowLatencyStats
    }
    receiver.transform = new RTCRtpScriptTransform(worker, { canvas: offscreen, port: channel.port2 }, [offscreen, channel.port2])
    return {
      canvas,
      setCodec(codec) {
        channel.port1.postMessage({ codec })
      },
      setEnabled(on) {
        channel.port1.postMessage({ enabled: on })
      },
      stats: () => last,
      stop() {
        // Detach first so frames flow straight to the engine again (a dead worker would hold them back).
        try {
          receiver.transform = null
        } catch {
          /* ignore */
        }
        channel.port1.onmessage = null
        channel.port1.close()
        worker.terminate()
      },
    }
  } catch {
    return null
  }
}

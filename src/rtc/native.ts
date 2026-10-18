// Linux (Tauri on WebKitGTK, which ships without WebRTC): a stand-in for the small part of RTCPeerConnection the
// ViewerSession uses, backed by the Rust GStreamer engine (src-tauri/linux-media, commands in src-tauri/src/media.rs).
// Only the watch side exists: we answer the sharer's offer with H.264 + Opus + the "ctl" data channel. Video arrives
// as encoded H.264 access units over a Tauri Channel and is decoded by WebCodecs (GStreamer inside WebKit, VA-API
// when available) into a <canvas> laid over the watch view's <video>; audio is decoded and played by GStreamer and
// follows the volume / mute of the watch view's <audio> element. See docs/LINUX.md.
//
// Selected only by nativeRtcActive() (Tauri app on Linux) — Windows/macOS and browsers keep the real
// RTCPeerConnection. The pure helpers (filterOfferForNative, ensureTransportCc, addCandidatesToSdp, avcCodecString)
// are unit-tested under Node.

type CoreModule = typeof import('@tauri-apps/api/core')

/**
 * true inside the Tauri app on Linux. Deliberately NOT `typeof RTCPeerConnection === 'undefined'`: a future
 * WebKitGTK with WebRTC must not silently swap the media engine under us.
 */
export function nativeRtcActive(): boolean {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window) || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Linux/i.test(ua) && !/Android/i.test(ua)
}

// ───────────────────────── pure SDP / bitstream helpers ─────────────────────────

const TRANSPORT_CC = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'

function splitSections(sdp: string): string[][] {
  const lines = sdp.split(/\r?\n/).filter((l) => l.length > 0)
  const sections: string[][] = [[]]
  for (const l of lines) {
    if (l.startsWith('m=')) sections.push([])
    sections[sections.length - 1].push(l)
  }
  return sections
}

const joinSections = (sections: string[][]): string => sections.flat().join('\r\n') + '\r\n'

/** Payload type of an a=rtpmap / a=fmtp / a=rtcp-fb line, or null. */
function linePt(l: string): string | null {
  const m = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+|\*)\s/.exec(l + ' ')
  return m ? m[1] : null
}

function filterMediaSection(lines: string[]): string[] {
  const kind = /^m=(\w+)/.exec(lines[0])?.[1]
  if (kind !== 'video' && kind !== 'audio') return lines
  const names = new Map<string, string>()
  const fmtp = new Map<string, string>()
  for (const l of lines) {
    const r = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(l)
    if (r) names.set(r[1], r[2].toLowerCase())
    const f = /^a=fmtp:(\d+)\s+(.*)$/.exec(l)
    if (f) fmtp.set(f[1], f[2])
  }
  const mParts = lines[0].split(' ')
  const order = mParts.slice(3)
  const keep = new Set<string>()
  if (kind === 'video') {
    const h264 = order.filter((pt) => names.get(pt) === 'h264')
    const pm1 = h264.filter((pt) => /(^|;)\s*packetization-mode=1/.test(fmtp.get(pt) ?? ''))
    for (const pt of pm1.length > 0 ? pm1 : h264) keep.add(pt)
    if (keep.size === 0) return lines // no H.264 offered: leave it to the engine (no picture, but no break either)
    for (const pt of order) {
      const apt = /(^|;)\s*apt=(\d+)/.exec(fmtp.get(pt) ?? '')
      if (names.get(pt) === 'rtx' && apt && keep.has(apt[2])) keep.add(pt)
    }
  } else {
    for (const pt of order) if (names.get(pt) === 'opus') keep.add(pt)
    if (keep.size === 0) return lines
  }
  const out: string[] = [[...mParts.slice(0, 3), ...order.filter((pt) => keep.has(pt))].join(' ')]
  for (const l of lines.slice(1)) {
    const pt = linePt(l)
    if (pt !== null && pt !== '*' && !keep.has(pt)) continue
    out.push(l)
  }
  return out
}

/**
 * The sharer's offer reduced to what the Linux engine handles: video = H.264 (packetization-mode=1) + its RTX,
 * audio = Opus, data channel unchanged. Header extensions and rtcp-fb (incl. transport-cc) stay. webrtcbin answers
 * with exactly these codecs, so the sharer's browser sends H.264 whatever it prefers. Pure, CRLF output.
 */
export function filterOfferForNative(sdp: string): string {
  return joinSections(splitSections(sdp).map((s, i) => (i === 0 ? s : filterMediaSection(s))))
}

/**
 * If webrtcbin's answer dropped transport-cc (extmap and/or rtcp-fb) that the offer had, put it back — Chrome's
 * bandwidth estimate only ramps up with TWCC (the engine's rtpsession generates the feedback from the
 * extension id in its caps). Returns the answer unchanged when nothing is missing. Pure.
 */
export function ensureTransportCc(answer: string, offer: string): string {
  const off = splitSections(offer)
  const ans = splitSections(answer)
  let changed = false
  for (let i = 1; i < ans.length; i++) {
    const a = ans[i]
    const o = off[i]
    if (!o) continue
    const m = /^m=(\w+) (\d+) /.exec(a[0])
    if (!m || (m[1] !== 'video' && m[1] !== 'audio') || m[2] === '0') continue
    const ext = o.find((l) => l.startsWith('a=extmap:') && l.includes(TRANSPORT_CC))
    const em = ext ? /^a=extmap:(\d+)(?:\/\w+)?\s+(\S+)/.exec(ext) : null
    if (!em) continue
    if (!a.some((l) => l.startsWith('a=extmap:') && l.includes(TRANSPORT_CC))) {
      let at = -1
      a.forEach((l, idx) => {
        if (l.startsWith('a=extmap:') || l.startsWith('a=mid:')) at = idx
      })
      a.splice(at >= 0 ? at + 1 : a.length, 0, `a=extmap:${em[1]} ${em[2]}`)
      changed = true
    }
    for (const pt of a[0].split(' ').slice(3)) {
      const fb = `a=rtcp-fb:${pt} transport-cc`
      if (!o.includes(fb) || a.includes(fb)) continue
      const rtpmap = a.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `))
      a.splice(rtpmap >= 0 ? rtpmap + 1 : a.length, 0, fb)
      changed = true
    }
  }
  return changed ? joinSections(ans) : answer
}

/** Puts gathered local candidates into their m-sections (half-trickle: the answer we send must carry them). Pure. */
export function addCandidatesToSdp(sdp: string, cands: ReadonlyArray<{ mline: number; candidate: string }>): string {
  if (cands.length === 0) return sdp
  const sections = splitSections(sdp)
  for (const c of cands) {
    const sec = sections[c.mline + 1]
    if (!sec) continue
    const line = 'a=' + c.candidate.replace(/^a=/, '')
    if (!sec.includes(line)) sec.push(line)
  }
  return joinSections(sections)
}

/** a=mid values per m-section, in order (null where missing). */
export function sdpMids(sdp: string): Array<string | null> {
  return splitSections(sdp)
    .slice(1)
    .map((s) => {
      const l = s.find((x) => x.startsWith('a=mid:'))
      return l ? l.slice(6).trim() : null
    })
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** "avc1.PPCCLL" from the first SPS of an Annex B access unit, or null. Pure. */
export function avcCodecString(au: Uint8Array): string | null {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0) continue
    let p: number
    if (au[i + 2] === 1) p = i + 3
    else if (au[i + 2] === 0 && au[i + 3] === 1) p = i + 4
    else continue
    if (p + 3 >= au.length) return null
    if ((au[p] & 0x1f) === 7) return `avc1.${hex2(au[p + 1])}${hex2(au[p + 2])}${hex2(au[p + 3])}`
    i = p
  }
  return null
}

// ───────────────────────── runtime (Tauri only) ─────────────────────────

let corePromise: Promise<CoreModule> | null = null
const core = (): Promise<CoreModule> => (corePromise ??= import('@tauri-apps/api/core'))
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await core()).invoke<T>(cmd, args)
}

/** Problems the user must see (missing packages, no decoder): console + toast (loaded lazily, browser only). */
const reported = new Set<string>()
function problem(message: string): void {
  console.error('[native]', message)
  if (reported.has(message)) return
  reported.add(message)
  void import('../ui/toast.ts').then((m) => m.toast(message, 'error', 12_000)).catch(() => {})
}

let probeOnce: Promise<void> | null = null
function probe(): Promise<void> {
  probeOnce ??= invoke<{ available: boolean; missing: string[]; version: string }>('media_probe')
    .then((p) => {
      if (!p.available) problem(`Für Linux fehlen GStreamer-Pakete: ${p.missing.join(', ')}`)
    })
    .catch(() => {})
  return probeOnce
}

const NATIVE_TRACK = Symbol('native-track')

/** true for the placeholder tracks of the native engine (they are not MediaStreamTracks). */
export function isNativeTrack(track: unknown): boolean {
  return typeof track === 'object' && track !== null && NATIVE_TRACK in track
}

/** Counters of the most recent native video (E2E test, diagnostics). */
export interface NativeVideoDebug {
  framesReceived: number
  framesDecoded: number
  framesDropped: number
  decodeErrors: number
  width: number
  height: number
  codec: string
  hardwareAcceleration: string
  attached: boolean
}
let lastVideo: NativeVideo | null = null
export function nativeDebug(): NativeVideoDebug | null {
  const v = lastVideo
  if (!v) return null
  return {
    framesReceived: v.framesReceived,
    framesDecoded: v.framesDecoded,
    framesDropped: v.framesDropped,
    decodeErrors: v.decodeErrors,
    width: v.width,
    height: v.height,
    codec: v.codec,
    hardwareAcceleration: v.hw,
    attached: v.canvas.isConnected,
  }
}

/** Decoder config per codec string: hardware if WebKit/GStreamer has one, else whatever decodes it. Cached. */
const configCache = new Map<string, Promise<VideoDecoderConfig | null>>()
function pickConfig(codec: string): Promise<VideoDecoderConfig | null> {
  let p = configCache.get(codec)
  if (!p) {
    p = (async () => {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
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

/** WebCodecs H.264 decoder drawing into a canvas that lays itself over the watch view's <video>. */
class NativeVideo {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly requestKey: () => void
  private decoder: VideoDecoder | null = null
  private waitKey = true
  private closed = false
  private seq = 0
  private configuring: string | null = null
  /** key frame that arrived while the decoder was being configured (decoded right after) */
  private pendingKey: { data: Uint8Array; ts: number } | null = null
  private readonly submitted = new Map<number, number>()
  codec = ''
  hw = ''
  framesReceived = 0
  framesDecoded = 0
  framesDropped = 0
  decodeErrors = 0
  bytes = 0
  decodeTimeS = 0
  width = 0
  height = 0

  constructor(requestKey: () => void) {
    this.requestKey = requestKey
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'viewer-canvas'
    this.canvas.width = 1280
    this.canvas.height = 720
    // same box as the <video> underneath (which keeps receiving clicks / double clicks)
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none'
    this.ctx = this.canvas.getContext('2d', { alpha: false })
    lastVideo = this
  }

  push(buf: ArrayBuffer): void {
    if (this.closed || buf.byteLength < 10) return
    const view = new DataView(buf)
    const key = (view.getUint8(0) & 1) === 1
    const pts = Number(view.getBigUint64(1, true))
    const data = new Uint8Array(buf, 9)
    const ts = pts > 0 ? pts : ++this.seq * 16_667
    this.framesReceived++
    this.bytes += data.byteLength
    if (typeof VideoDecoder === 'undefined') {
      this.framesDropped++
      problem('Diese WebKitGTK-Version kann kein Video dekodieren (WebCodecs fehlt, WebKitGTK ≥ 2.46 nötig).')
      return
    }
    if (key) {
      const codec = avcCodecString(data)
      if (codec && codec !== this.codec) {
        this.pendingKey = { data, ts }
        if (this.configuring !== codec) void this.configure(codec)
        return
      }
    }
    if (this.configuring !== null || !this.decoder || this.decoder.state !== 'configured') {
      this.framesDropped++
      return
    }
    if (this.waitKey && !key) {
      this.framesDropped++
      return
    }
    if (!key && this.decoder.decodeQueueSize > 6) {
      // decoder falls behind: skip to the next key frame instead of piling up latency
      this.waitKey = true
      this.framesDropped++
      this.requestKey()
      return
    }
    this.decode(data, ts, key)
  }

  private decode(data: Uint8Array, ts: number, key: boolean): void {
    const dec = this.decoder
    if (!dec) return
    this.waitKey = false
    if (this.submitted.size > 120) this.submitted.clear()
    this.submitted.set(ts, performance.now())
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }))
    } catch (err) {
      this.fail(err)
    }
  }

  private async configure(codec: string): Promise<void> {
    this.configuring = codec
    const cfg = await pickConfig(codec)
    if (this.closed || this.configuring !== codec) return
    this.configuring = null
    if (!cfg) {
      this.pendingKey = null
      problem(`H.264-Dekoder fehlt (${codec}) – Paket gst-libav installieren (oder gst-plugin-va für die GPU).`)
      return
    }
    try {
      if (!this.decoder || this.decoder.state === 'closed') {
        this.decoder = new VideoDecoder({ output: (f) => this.draw(f), error: (e) => this.fail(e) })
      }
      this.decoder.configure(cfg)
      this.codec = codec
      this.hw = cfg.hardwareAcceleration ?? ''
      console.info(`[native] VideoDecoder ${codec} (${this.hw})`)
    } catch (err) {
      this.fail(err)
      return
    }
    const k = this.pendingKey
    this.pendingKey = null
    if (k) this.decode(k.data, k.ts, true)
    else this.requestKey()
  }

  private draw(frame: VideoFrame): void {
    try {
      if (this.closed) return
      const t0 = this.submitted.get(frame.timestamp)
      if (t0 !== undefined) {
        this.submitted.delete(frame.timestamp)
        this.decodeTimeS += (performance.now() - t0) / 1000
      }
      const w = frame.displayWidth
      const h = frame.displayHeight
      if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
        this.canvas.width = w
        this.canvas.height = h
      }
      this.width = w
      this.height = h
      this.ctx?.drawImage(frame, 0, 0, w, h)
      this.framesDecoded++
      if (!this.canvas.isConnected) this.attach()
    } finally {
      frame.close()
    }
  }

  /** Lays the canvas over the watch view's <video> (src/ui/watch.ts renders `#viewer-video`). */
  private attach(): void {
    const video = document.getElementById('viewer-video')
    if (video?.parentElement) video.after(this.canvas)
  }

  private fail(err: unknown): void {
    this.decodeErrors++
    console.warn('[native] decoder error', err instanceof Error ? err.message : String(err))
    try { this.decoder?.close() } catch { /* ignore */ }
    this.decoder = null
    this.codec = '' // the next key frame configures a fresh decoder
    this.waitKey = true
    if (!this.closed) this.requestKey()
    if (this.decodeErrors === 5) problem('Video kann nicht dekodiert werden – Paket gst-libav (H.264) installieren.')
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

/** The "ctl" data channel (negotiated, id 0 — the engine creates it together with the peer). */
class NativeDataChannel {
  readonly label: string
  readonly id = 0
  readonly negotiated = true
  readonly ordered = true
  readyState: RTCDataChannelState = 'connecting'
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private readonly pc: NativePeerConnection

  constructor(pc: NativePeerConnection, label: string) {
    this.pc = pc
    this.label = label
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new DOMException('data channel not open', 'InvalidStateError')
    this.pc.dcSend(String(data))
  }

  close(): void {
    this.setState('closed')
  }

  setState(s: RTCDataChannelState): void {
    if (this.readyState === s || this.readyState === 'closed') return
    this.readyState = s
    const ev = new Event(s === 'open' ? 'open' : 'close')
    try {
      if (s === 'open') this.onopen?.(ev)
      else if (s === 'closed') this.onclose?.(ev)
    } catch { /* handler errors stay in the handler */ }
  }

  deliver(text: string): void {
    if (this.readyState !== 'open') return
    try { this.onmessage?.({ data: text }) } catch { /* ignore */ }
  }
}

type EngineEvent =
  | { t: 'ice'; mline: number; c: string }
  | { t: 'gather'; s: RTCIceGatheringState }
  | { t: 'state'; c: string; i: string }
  | { t: 'track'; k: 'video' | 'audio' }
  | { t: 'dcopen' }
  | { t: 'dcclose' }
  | { t: 'dc'; m: string }
  | { t: 'err'; m: string }

/** Base jitter buffer of the engine (ms); 'smooth' adds the receiver's jitterBufferTarget on top. */
const BASE_LATENCY_MS = 40

type Rec = Record<string, unknown>
const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * RTCPeerConnection stand-in (answerer only). Constructed synchronously; the engine peer is created in the background
 * and every method waits for it.
 */
export class NativePeerConnection {
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'new'
  signalingState: RTCSignalingState = 'stable'
  ontrack: ((e: RTCTrackEvent) => void) | null = null
  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null
  onconnectionstatechange: ((e: Event) => void) | null = null

  private readonly idP: Promise<number>
  private id: number | null = null
  private closed = false
  private offer = ''
  private answer: string | null = null
  private mids: Array<string | null> = []
  private readonly cands: Array<{ mline: number; candidate: string }> = []
  private readonly listeners = new Map<string, Set<(e: Event) => void>>()
  private dc: NativeDataChannel | null = null
  private video: NativeVideo | null = null
  private sendChain: Promise<unknown> = Promise.resolve()
  private latencyMs = BASE_LATENCY_MS
  private audioEl: HTMLMediaElement | null = null
  private volume = -1
  private loggedStats = false

  constructor(config?: RTCConfiguration) {
    const stun: string[] = []
    const turn: Array<{ urls: string; username?: string; credential?: string }> = []
    for (const s of config?.iceServers ?? []) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      for (const u of urls) {
        if (/^stuns?:/i.test(u)) stun.push(u)
        else if (/^turns?:/i.test(u)) turn.push({ urls: u, username: s.username, credential: typeof s.credential === 'string' ? s.credential : undefined })
      }
    }
    // debugging / headless E2E (tests/e2e/linux-app-driver.js)
    ;(window as unknown as { __stNative?: unknown }).__stNative = { debug: nativeDebug }
    void probe()
    this.idP = core().then(async ({ Channel, invoke }) => {
      const ch = new Channel<unknown>((m) => this.onEngine(m))
      const id = await invoke<number>('media_create', { config: { stun, turn, latencyMs: this.latencyMs }, events: ch })
      this.id = id
      if (this.closed) {
        void invoke('media_close', { id }).catch(() => {})
        throw new Error('closed')
      }
      this.bindAudio()
      return id
    })
    this.idP.catch((err: unknown) => {
      if (!this.closed) problem(`Linux-Medienpfad nicht verfügbar: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  get localDescription(): RTCSessionDescriptionInit | null {
    return this.answer === null ? null : { type: 'answer', sdp: addCandidatesToSdp(this.answer, this.cands) }
  }

  createDataChannel(label: string): RTCDataChannel {
    this.dc ??= new NativeDataChannel(this, label)
    return this.dc as unknown as RTCDataChannel
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.type !== 'offer' || !desc.sdp) throw new DOMException('only offers are supported', 'InvalidStateError')
    const id = await this.idP
    const offer = filterOfferForNative(desc.sdp)
    await invoke('media_remote', { id, sdp: offer })
    if (this.closed) return
    this.offer = offer
    this.signalingState = 'have-remote-offer'
  }

  async setLocalDescription(): Promise<void> {
    const id = await this.idP
    const sdp = await invoke<string>('media_answer', { id })
    if (this.closed) return
    const answer = ensureTransportCc(sdp, this.offer)
    if (answer !== sdp) console.info('[native] answer: transport-cc restored')
    this.answer = answer
    this.mids = sdpMids(answer)
    this.signalingState = 'stable'
  }

  async addIceCandidate(c?: RTCIceCandidateInit | null): Promise<void> {
    if (!c || !c.candidate) return
    let mline = typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : -1
    if (mline < 0 && c.sdpMid != null) mline = this.mids.indexOf(c.sdpMid)
    const id = await this.idP
    await invoke('media_ice', { id, mline: Math.max(0, mline), candidate: c.candidate })
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  private dispatch(type: string): void {
    const ev = new Event(type)
    for (const fn of this.listeners.get(type) ?? []) {
      try { fn(ev) } catch { /* ignore */ }
    }
  }

  dcSend(text: string): void {
    const id = this.id
    if (id === null || this.closed) return
    // keep ctl messages in order
    this.sendChain = this.sendChain.then(() => invoke('media_dc_send', { id, text })).catch(() => {})
  }

  /** GStreamer plays the sound; it follows the watch view's <audio> element (volume slider / mute). */
  private readonly onVolume = (): void => this.pushVolume()

  private bindAudio(): void {
    if (this.closed) return
    const el = document.getElementById('viewer-audio') as HTMLMediaElement | null
    if (el !== this.audioEl) {
      this.audioEl?.removeEventListener('volumechange', this.onVolume)
      this.audioEl = el
      el?.addEventListener('volumechange', this.onVolume)
    }
    this.pushVolume()
  }

  private pushVolume(): void {
    const el = this.audioEl
    const v = el ? (el.muted ? 0 : el.volume) : 1
    if (v === this.volume || this.id === null || this.closed) return
    this.volume = v
    void invoke('media_volume', { id: this.id, volume: v }).catch(() => {})
  }

  private requestKeyframe = (): void => {
    if (this.id !== null && !this.closed) void invoke('media_keyframe', { id: this.id }).catch(() => {})
  }

  private setLatency(targetMs: number): void {
    const ms = Math.round(BASE_LATENCY_MS + Math.max(0, targetMs || 0))
    if (ms === this.latencyMs) return
    this.latencyMs = ms
    if (this.id !== null && !this.closed) void invoke('media_latency', { id: this.id, ms }).catch(() => {})
  }

  private onEngine(m: unknown): void {
    if (this.closed) return
    if (m instanceof ArrayBuffer) {
      this.ensureVideo().push(m)
      return
    }
    const ev = m as EngineEvent
    switch (ev?.t) {
      case 'ice': {
        this.cands.push({ mline: ev.mline, candidate: ev.c })
        const init: RTCIceCandidateInit = { candidate: ev.c, sdpMLineIndex: ev.mline, sdpMid: this.mids[ev.mline] ?? null }
        const candidate = { ...init, toJSON: () => init }
        try { this.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent) } catch { /* ignore */ }
        return
      }
      case 'gather':
        if (ev.s !== this.iceGatheringState) {
          this.iceGatheringState = ev.s
          this.dispatch('icegatheringstatechange')
        }
        return
      case 'state':
        this.updateState(ev.c, ev.i)
        return
      case 'track':
        if (ev.k === 'video') this.ensureVideo()
        else this.bindAudio()
        this.emitTrack(ev.k)
        return
      case 'dcopen':
        this.dc?.setState('open')
        return
      case 'dcclose':
        this.dc?.setState('closed')
        return
      case 'dc':
        this.dc?.deliver(ev.m)
        return
      case 'err':
        console.warn('[media]', ev.m)
        return
      default:
        return
    }
  }

  private updateState(c: string, i: string): void {
    this.iceConnectionState = (['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'].includes(i) ? i : 'new') as RTCIceConnectionState
    let next: RTCPeerConnectionState
    if (c === 'closed') next = 'closed'
    else if (c === 'failed' || i === 'failed') next = 'failed'
    else if (c === 'connected' || i === 'connected' || i === 'completed') next = 'connected'
    else if (c === 'disconnected' || i === 'disconnected') next = 'disconnected'
    else if (c === 'connecting' || i === 'checking') next = 'connecting'
    else next = this.connectionState
    if (next === this.connectionState) return
    this.connectionState = next
    try { this.onconnectionstatechange?.(new Event('connectionstatechange')) } catch { /* ignore */ }
    this.dispatch('connectionstatechange')
  }

  private ensureVideo(): NativeVideo {
    this.video ??= new NativeVideo(this.requestKeyframe)
    return this.video
  }

  /**
   * Track events carry placeholder tracks (isNativeTrack): the ViewerSession keeps the receiver (latency mode →
   * jitterBufferTarget → engine latency) but hands no MediaStream to the UI — the picture is our canvas.
   */
  private emitTrack(kind: 'video' | 'audio'): void {
    const pc = this
    const receiver = {
      track: null,
      get jitterBufferTarget(): number {
        return pc.latencyMs - BASE_LATENCY_MS
      },
      set jitterBufferTarget(ms: number) {
        pc.setLatency(ms)
      },
    }
    const track = { [NATIVE_TRACK]: true, kind, id: `native-${kind}`, readyState: 'live', enabled: true, muted: false, stop: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
    const ev = { track, receiver, streams: [], transceiver: null }
    try { this.ontrack?.(ev as unknown as RTCTrackEvent) } catch { /* ignore */ }
  }

  /** Chrome-shaped report: the engine's webrtcbin stats (camelCased) + our own video counters. */
  async getStats(): Promise<RTCStatsReport> {
    const report = new Map<string, Rec>()
    const now = Date.now()
    this.bindAudio() // the watch view may have been (re)mounted
    let raw: Record<string, Rec> = {}
    if (this.id !== null && !this.closed) {
      try {
        raw = await invoke<Record<string, Rec>>('media_stats', { id: this.id })
      } catch { /* engine busy / closed */ }
    }
    if (!this.loggedStats && Object.keys(raw).length > 0 && this.connectionState === 'connected') {
      this.loggedStats = true
      console.info('[native] engine stats', JSON.stringify(raw))
    }
    const codecs = new Map<string, Rec>()
    for (const [sid, s] of Object.entries(raw)) {
      const o: Rec = { id: sid, timestamp: now }
      for (const [k, v] of Object.entries(s)) if (k !== 'timestamp' && k !== 'id') o[camel(k)] = v
      if (o.type === 'codec') codecs.set(sid, o)
      report.set(sid, o)
    }
    const isVideo = (s: Rec): boolean => {
      if (s.kind === 'video' || s.kind === 'audio') return s.kind === 'video'
      const c = codecs.get(String(s.codecId ?? ''))
      return c?.clockRate === 90000 || /video/i.test(String(c?.mimeType ?? c?.codecType ?? ''))
    }
    let lost = 0
    let recv = 0
    let jitter: number | undefined
    for (const s of report.values()) {
      if (s.type !== 'inbound-rtp') continue
      if (isVideo(s)) {
        lost += typeof s.packetsLost === 'number' ? Math.max(0, s.packetsLost) : 0
        recv += typeof s.packetsReceived === 'number' ? s.packetsReceived : 0
        if (typeof s.jitter === 'number') jitter = s.jitter
        s.type = 'inbound-rtp-engine' // replaced by the entry below (our byte/frame counters)
      } else {
        s.kind = 'audio'
      }
    }
    const v = this.video
    if (v) {
      report.set('native-codec-video', { id: 'native-codec-video', timestamp: now, type: 'codec', mimeType: 'video/H264' })
      report.set('native-inbound-video', {
        id: 'native-inbound-video',
        timestamp: now,
        type: 'inbound-rtp',
        kind: 'video',
        codecId: 'native-codec-video',
        bytesReceived: v.bytes,
        framesReceived: v.framesReceived,
        framesDecoded: v.framesDecoded,
        framesDropped: v.framesDropped,
        totalDecodeTime: v.decodeTimeS,
        jitterBufferDelay: (v.framesDecoded * this.latencyMs) / 1000,
        jitterBufferEmittedCount: v.framesDecoded,
        frameWidth: v.width,
        frameHeight: v.height,
        packetsLost: lost,
        packetsReceived: recv,
        jitter,
        decoderImplementation: `WebCodecs/GStreamer (${v.hw || 'n/a'})`,
        powerEfficientDecoder: v.hw === 'prefer-hardware' ? true : undefined,
      })
    }
    return report as unknown as RTCStatsReport
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.connectionState = 'closed'
    this.signalingState = 'closed'
    this.dc?.setState('closed')
    this.video?.close()
    this.audioEl?.removeEventListener('volumechange', this.onVolume)
    this.audioEl = null
    const id = this.id
    if (id !== null) void invoke('media_close', { id }).catch(() => {})
  }
}

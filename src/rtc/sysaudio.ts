// Windows app: share sound captured natively (src-tauri/src/sysaudio.rs, WASAPI process loopback) instead of the
// browser picker's "share system audio" checkbox:
//   screen share → all system sound except StreamTunnel itself (no echo of what you watch)
//   window share → only that window's program (e.g. the game)
// 48 kHz stereo f32 PCM arrives in 10 ms chunks and is turned into an audio track with MediaStreamTrackGenerator.

type CoreModule = typeof import('@tauri-apps/api/core')
let corePromise: Promise<CoreModule> | null = null
const core = (): Promise<CoreModule> => (corePromise ??= import('@tauri-apps/api/core'))

interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<AudioData>
}
type TrackGeneratorCtor = new (init: { kind: 'audio' | 'video' }) => TrackGenerator

const RATE = 48000
const CHANNELS = 2
/** chunks received from the native side (diagnostics / app self-test) */
export let nativeAudioChunks = 0

function isWindowsApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Windows/i.test(navigator.userAgent)
}

let supported: Promise<boolean> | null = null

/** True in the Windows app when native capture works (Windows 10 2004+ / 11) and the page can make audio tracks. */
export function nativeShareAudioSupported(): Promise<boolean> {
  supported ??= (async () => {
    if (!isWindowsApp() || typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') return false
    try {
      return await (await core()).invoke<boolean>('sysaudio_supported')
    } catch {
      return false
    }
  })()
  return supported
}

/** "window:<hwnd>:0" → hwnd (the engine's id for a window share), else null. */
export function hwndOf(track: MediaStreamTrack | undefined): number | null {
  let id = ''
  try {
    id = track?.getSettings().deviceId ?? ''
  } catch {
    /* ignore */
  }
  const m = /^window:(\d+):/.exec(id)
  return m ? Number(m[1]) : null
}

/**
 * Starts native share sound. `window` = the shared window's handle (only that program is heard) or null for the
 * whole system without StreamTunnel. Returns the audio track (stop() ends the capture), or null if it failed.
 */
export async function startNativeShareAudio(windowHandle: number | null): Promise<MediaStreamTrack | null> {
  if (!(await nativeShareAudioSupported())) return null
  const { Channel, invoke } = await core()
  let target: number | null = null
  if (windowHandle !== null) {
    target = await invoke<number | null>('window_pid', { hwnd: windowHandle }).catch(() => null)
    if (target === null) return null
  }
  const Gen = (globalThis as unknown as { MediaStreamTrackGenerator: TrackGeneratorCtor }).MediaStreamTrackGenerator
  const track = new Gen({ kind: 'audio' })
  const writer = track.writable.getWriter()
  let timestampUs = 0
  let pending = 0
  let closed = false
  const channel = new Channel<ArrayBuffer>((buf) => {
    if (closed || !(buf instanceof ArrayBuffer) || buf.byteLength < 8) return
    nativeAudioChunks++
    const frames = buf.byteLength / (4 * CHANNELS)
    const data = new AudioData({ format: 'f32', sampleRate: RATE, numberOfFrames: frames, numberOfChannels: CHANNELS, timestamp: timestampUs, data: buf })
    timestampUs += (frames * 1_000_000) / RATE
    if (pending > 20) {
      data.close() // the track is not being consumed fast enough: drop instead of piling up
      return
    }
    pending++
    writer.write(data).then(
      () => pending--,
      () => {
        pending--
        data.close()
      },
    )
  })
  let id: number
  try {
    id = await invoke<number>('sysaudio_start', { target, events: channel })
  } catch {
    closed = true
    track.stop()
    return null
  }
  try {
    track.contentHint = 'music'
  } catch {
    /* ignore */
  }
  const stopNative = () => {
    if (closed) return
    closed = true
    void invoke('sysaudio_stop', { id }).catch(() => {})
    void writer.close().catch(() => {})
  }
  // MediaStreamTrack.stop() fires no 'ended' event, so hook stop() itself (the share ends by stopping all tracks).
  const originalStop = track.stop.bind(track)
  track.stop = () => {
    stopNative()
    originalStop()
  }
  track.addEventListener('ended', stopNative, { once: true })
  return track
}

/**
 * Self-test for the Windows app (run over DevTools): captures system sound for `ms`, returns how many 10 ms chunks
 * arrived and the loudest sample seen through the generated track.
 */
export async function probeNativeShareAudio(ms = 1500): Promise<{ supported: boolean; started: boolean; chunks: number; peak: number }> {
  const supported = await nativeShareAudioSupported()
  if (!supported) return { supported, started: false, chunks: 0, peak: 0 }
  const before = nativeAudioChunks
  const track = await startNativeShareAudio(null)
  if (!track) return { supported, started: false, chunks: 0, peak: 0 }
  const ctx = new AudioContext({ sampleRate: RATE })
  const an = ctx.createAnalyser()
  ctx.createMediaStreamSource(new MediaStream([track])).connect(an)
  const buf = new Float32Array(an.fftSize)
  let peak = 0
  const end = Date.now() + ms
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50))
    an.getFloatTimeDomainData(buf)
    for (const v of buf) peak = Math.max(peak, Math.abs(v))
  }
  track.stop()
  await ctx.close()
  return { supported, started: true, chunks: nativeAudioChunks - before, peak: Math.round(peak * 1000) / 1000 }
}

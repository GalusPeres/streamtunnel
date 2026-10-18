// Screen/window capture via getDisplayMedia plus a synthetic test stream.
import type { StreamSettings } from '../types.ts'

export type CaptureErrorKind = 'cancelled' | 'unsupported' | 'failed'
export class CaptureError extends Error {
  readonly kind: CaptureErrorKind
  constructor(kind: CaptureErrorKind, message: string) { super(message); this.kind = kind }
}
export interface CaptureInfo {
  /** 'monitor' | 'window' | 'browser' | 'unknown' */
  surface: string
  /** human label (window title / "Bildschirm") */
  label: string
  hasAudio: boolean
}

/** getDisplayMedia options that lib.dom does not (yet) declare. */
interface ExtendedDisplayMediaOptions {
  video: MediaTrackConstraints
  audio: MediaTrackConstraints | false
  systemAudio?: 'include' | 'exclude'
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
}

type AudioConstraintsExt = MediaTrackConstraints & { suppressLocalAudioPlayback?: boolean }

/** contentHint for a content mode: only 'detail' is treated as screencast (sharp text). */
export function contentHintFor(content: StreamSettings['content']): string {
  return content === 'detail' ? 'detail' : 'motion'
}

function videoConstraints(settings: StreamSettings): MediaTrackConstraints {
  const res = settings.resolution
  const maxW = res === 'native' ? 3840 : Math.round((res * 16) / 9)
  const maxH = res === 'native' ? 2160 : res
  return {
    frameRate: { ideal: settings.fps, max: settings.fps },
    width: { max: maxW },
    height: { max: maxH },
  }
}

/** Opens the picker (must be called from a user gesture). Throws CaptureError with a German message. */
export async function captureScreen(settings: StreamSettings): Promise<MediaStream> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md || typeof md.getDisplayMedia !== 'function') {
    throw new CaptureError('unsupported', 'Bildschirmfreigabe wird hier nicht unterstützt.')
  }
  const audio: AudioConstraintsExt | false = settings.audio
    ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        suppressLocalAudioPlayback: false,
      }
    : false
  const options: ExtendedDisplayMediaOptions = {
    video: videoConstraints(settings),
    audio,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  }
  let stream: MediaStream
  try {
    stream = await md.getDisplayMedia(options as DisplayMediaStreamOptions)
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotAllowedError') {
      throw new CaptureError('cancelled', 'Freigabe abgebrochen.')
    }
    throw new CaptureError('failed', `Freigabe fehlgeschlagen (${name || 'unbekannter Fehler'}). Bitte erneut versuchen.`)
  }
  const video = stream.getVideoTracks()[0]
  if (!video) {
    for (const t of stream.getTracks()) t.stop()
    throw new CaptureError('failed', 'Freigabe fehlgeschlagen: Keine Videospur erhalten.')
  }
  try { video.contentHint = contentHintFor(settings.content) } catch { /* ignore */ }
  return stream
}

const SOURCE_ID_RE = /^(window|screen|web-contents-media-stream|tab):/i

function surfaceLabel(surface: string): string {
  if (surface === 'window') return 'Fenster'
  if (surface === 'browser') return 'Tab'
  return 'Bildschirm'
}

export function describeCapture(stream: MediaStream): CaptureInfo {
  const video = stream.getVideoTracks()[0]
  let surface = 'unknown'
  let label = ''
  if (video) {
    let s: MediaTrackSettings = {}
    try { s = video.getSettings() } catch { /* ignore */ }
    const ds = typeof s.displaySurface === 'string' ? s.displaySurface : ''
    if (ds === 'monitor' || ds === 'window' || ds === 'browser') surface = ds
    else if (typeof s.deviceId === 'string') {
      if (s.deviceId.startsWith('window:')) surface = 'window'
      else if (s.deviceId.startsWith('screen:')) surface = 'monitor'
    }
    const raw = (video.label || '').trim()
    if (raw && !SOURCE_ID_RE.test(raw)) label = raw
    else if (raw.toLowerCase().startsWith('window:')) label = 'Fenster'
    else if (raw.toLowerCase().startsWith('screen:')) label = 'Bildschirm'
  }
  if (!label) label = surfaceLabel(surface)
  const hasAudio = stream.getAudioTracks().some((t) => t.readyState === 'live')
  return { surface, label, hasAudio }
}

/** Live-apply resolution/fps/contentHint to an existing capture stream. */
export async function applyCaptureSettings(stream: MediaStream, settings: StreamSettings): Promise<void> {
  const video = stream.getVideoTracks()[0]
  if (video) {
    try { video.contentHint = contentHintFor(settings.content) } catch { /* ignore */ }
    if (video.readyState === 'live') {
      try { await video.applyConstraints(videoConstraints(settings)) } catch { /* not supported for this source — ignore */ }
    }
  }
  for (const a of stream.getAudioTracks()) a.enabled = settings.audio
}

/** Synthetic animated test stream (canvas + tone) with an on-screen ms clock, for testing without a picker. */
export function makeTestStream(fps?: number): MediaStream {
  const rate = fps && fps > 0 ? Math.min(120, Math.round(fps)) : 60
  const W = 1280
  const H = 720
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new CaptureError('unsupported', 'Testbild wird nicht unterstützt (kein Canvas).')
  const stream = canvas.captureStream(rate)
  const video = stream.getVideoTracks()[0]
  if (!video) throw new CaptureError('failed', 'Testbild konnte nicht erzeugt werden.')
  try { video.contentHint = 'motion' } catch { /* ignore */ }

  const colors = ['#6d5dfc', '#22c3ee', '#f59e0b', '#ef4444', '#10b981', '#e5e7eb', '#a855f7', '#0ea5e9']
  const barW = W / colors.length
  let frame = 0
  const draw = () => {
    frame++
    const now = Date.now()
    ctx.fillStyle = '#0b0d17'
    ctx.fillRect(0, 0, W, H)
    // moving colour bars (one full screen width every 4 s)
    const offset = ((now % 4000) / 4000) * W
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i]
      const x = (i * barW + offset) % W
      ctx.fillRect(x, 80, barW - 8, 260)
      if (x + barW > W) ctx.fillRect(x - W, 80, barW - 8, 260)
    }
    // sweeping marker to judge smoothness
    const sweep = ((now % 1000) / 1000) * (W - 40)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(sweep, 360, 40, 40)
    // big millisecond clock
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 150px Consolas, "Courier New", monospace'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(String(now % 100000).padStart(5, '0'), 60, 600)
    ctx.font = '36px Consolas, "Courier New", monospace'
    ctx.fillText(`Frame ${frame}  ·  ${rate} fps  ·  StreamTunnel Testbild`, 60, 680)
  }
  draw()
  const interval = setInterval(draw, 1000 / rate)

  // Quiet 440 Hz beep for 100 ms every second.
  let audioCtx: AudioContext | null = null
  let beepTimer: ReturnType<typeof setInterval> | null = null
  let audioTrack: MediaStreamTrack | null = null
  try {
    audioCtx = new AudioContext({ sampleRate: 48000 })
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 440
    const gain = audioCtx.createGain()
    gain.gain.value = 0
    const dest = audioCtx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    const ac = audioCtx
    const beep = () => {
      if (ac.state === 'suspended') void ac.resume().catch(() => {})
      const t = ac.currentTime + 0.01
      gain.gain.setValueAtTime(0.08, t)
      gain.gain.setValueAtTime(0, t + 0.1)
    }
    beep()
    beepTimer = setInterval(beep, 1000)
    audioTrack = dest.stream.getAudioTracks()[0] ?? null
    if (audioTrack) stream.addTrack(audioTrack)
  } catch {
    audioCtx = null
  }

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearInterval(interval)
    if (beepTimer) clearInterval(beepTimer)
    if (audioTrack && audioTrack.readyState === 'live') audioTrack.stop()
    if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close().catch(() => {})
  }
  // MediaStreamTrack.stop() does not fire 'ended', so hook stop() itself.
  const originalStop = video.stop.bind(video)
  video.stop = () => { cleanup(); originalStop() }
  video.addEventListener('ended', cleanup, { once: true })
  return stream
}

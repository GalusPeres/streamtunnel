// Defaults, ICE server list and the automatic bitrate model.
// Pure module (no DOM access at import time) so it can be unit-tested under Node.
import type { CodecName, NetConfig, StreamSettings } from '../types.ts'

export const DEFAULT_SETTINGS: StreamSettings = { resolution: 1440, fps: 60, bitrateKbps: 0, codec: 'auto', content: 'balanced', audio: true }

/** Verified 2026-10-18 (see SPEC.md). Order = preference. */
export const DEFAULT_NET: NetConfig = {
  brokers: [
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://iot.coreflux.cloud:443/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://demo@demo.tbmq.io:443/mqtt',
  ],
  stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun1.l.google.com:19302'],
  turn: [],
}

/** Lower / upper clamp of the automatic bitrate model (kbps). */
export const AUTO_BITRATE_MIN_KBPS = 2500
export const AUTO_BITRATE_MAX_KBPS = 60000

/** Opus target for music/game audio (kbps); also used as audio sender maxBitrate. */
export const AUDIO_KBPS = 192

/** RTCConfiguration list: all STUN urls in one entry, then every TURN server (empty entries skipped). */
export function iceServers(net: NetConfig): RTCIceServer[] {
  const out: RTCIceServer[] = []
  const stun = (net.stun ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => s.length > 0)
  if (stun.length > 0) out.push({ urls: stun })
  for (const t of net.turn ?? []) {
    const urls = typeof t?.urls === 'string' ? t.urls.trim() : ''
    if (!urls) continue
    const server: RTCIceServer = { urls }
    if (t.username) server.username = t.username
    if (t.credential) server.credential = t.credential
    out.push(server)
  }
  return out
}

/** Nominal capture size for a resolution preference (used when the real track size is unknown). */
export function nominalSize(resolution: StreamSettings['resolution']): { width: number; height: number } {
  if (resolution === 'native') return { width: 3840, height: 2160 }
  return { width: Math.round((resolution * 16) / 9), height: resolution }
}

/** Effective max video bitrate (kbps) for given settings, codec and actual capture size/fps. */
export function effectiveBitrateKbps(settings: StreamSettings, codec: CodecName, width: number, height: number, fps: number): number {
  if (settings.bitrateKbps > 0) return Math.round(settings.bitrateKbps)
  let w = width
  let h = height
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    const n = nominalSize(settings.resolution)
    w = n.width
    h = n.height
  }
  const f = fps > 0 && Number.isFinite(fps) ? fps : settings.fps
  const bpp = codec === 'AV1' ? 0.06 : codec === 'VP9' ? 0.07 : 0.1
  let kbps = ((w * h * 60 * bpp) / 1000) * Math.pow(f / 60, 0.7)
  if (settings.content === 'detail') kbps *= 0.8
  kbps = Math.min(AUTO_BITRATE_MAX_KBPS, Math.max(AUTO_BITRATE_MIN_KBPS, kbps))
  return Math.round(kbps / 100) * 100
}

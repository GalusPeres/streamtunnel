// Display formatting (German or English number style) shared by the views.
import type { CodecName, ConnType, ContentMode, FpsPref, ResolutionPref, StreamSettings } from '../types.ts'
import { formatCode } from '../core/code.ts'
import { getLang, t } from '../i18n.ts'

/** 12400 → "12,4 Mbit/s"; below 1 Mbit/s in kbit/s. */
export function mbit(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '–'
  if (kbps < 1000) return `${Math.round(kbps)} kbit/s`
  return `${dec(kbps / 1000, kbps >= 10000 ? 0 : 1)} Mbit/s`
}

export function dec(v: number, digits = 1): string {
  const s = v.toFixed(digits)
  return getLang() === 'de' ? s.replace('.', ',') : s
}

export function ms(v: number | null | undefined, approx = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  return `${approx ? '~' : ''}${Math.round(v)} ms`
}

export function resFps(w: number, h: number, fps: number): string {
  if (!(w > 0) || !(h > 0)) return '–'
  return `${w}×${h}${fps > 0 ? ` @ ${Math.round(fps)}` : ''}`
}

export function codecLabel(c: CodecName | string | null | undefined): string {
  if (!c) return '–'
  const u = c.toUpperCase()
  if (u === 'H264') return 'H.264'
  if (u === 'H265') return 'H.265'
  return u
}

export function connLabel(c: ConnType | null | undefined): string {
  switch (c) {
    case 'lan':
      return t('conn.lan')
    case 'p2p':
      return t('conn.p2p')
    case 'relay':
      return t('conn.relay')
    default:
      return '…'
  }
}

export const RESOLUTION_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['native', t('res.native')],
  ['2160', '2160p (4K)'],
  ['1440', '1440p'],
  ['1080', '1080p'],
  ['720', '720p'],
]
export const FPS_OPTIONS: ReadonlyArray<readonly [FpsPref, string]> = [
  [30, '30 FPS'],
  [60, '60 FPS'],
  [120, '120 FPS'],
]
export const CONTENT_OPTIONS: ReadonlyArray<readonly [ContentMode, string]> = [
  ['motion', t('content.motion')],
  ['balanced', t('content.balanced')],
  ['detail', t('content.detail')],
]

export function resolutionFromValue(v: string): ResolutionPref {
  if (v === 'native') return 'native'
  const n = Number(v)
  return n === 2160 || n === 1440 || n === 1080 || n === 720 ? n : 1440
}

export function resolutionLabel(r: ResolutionPref): string {
  return r === 'native' ? t('res.nativeShort') : `${r}p`
}

export function settingsSummary(s: StreamSettings): string {
  return `${resolutionLabel(s.resolution)} · ${s.fps} FPS · ${s.bitrateKbps > 0 ? mbit(s.bitrateKbps) : t('autoBitrate')}`
}

/** "K7F3QX9MZD" → "K7F3Q-X9MZD" (falls back to local formatting if core/code is unavailable). */
export function prettyCode(code: string): string {
  try {
    return formatCode(code)
  } catch {
    return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code
  }
}

export function inviteText(code: string): string {
  return t('invite', { code: prettyCode(code) })
}

/** Bitrate slider position (1 = Auto, 2–60 = Mbit/s) ↔ kbps. */
export function sliderToKbps(v: number): number {
  return v <= 1 ? 0 : Math.round(v) * 1000
}
export function kbpsToSlider(kbps: number): number {
  return kbps > 0 ? Math.min(60, Math.max(2, Math.round(kbps / 1000))) : 1
}

const AVATAR_COLORS = ['#f2b66d', '#8fc7a9', '#c9a6e0', '#9fb8d8', '#e8a0a0', '#a8d0e6', '#d6c38f', '#b5e08f']

/** Avatar background for a display name: the same person gets the same color on every screen. */
export function avatarColor(name: string): string {
  let hash = 0
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

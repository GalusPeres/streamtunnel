// Settings sheet (right side): sharing defaults, watching, network. Plain field list, saved on "Fertig".
import type { AppSettings } from '../settings.ts'
import { defaultNet, isValidBroker, isValidStun, isValidTurn, sanitizeNet, saveSettings } from '../settings.ts'
import type { CodecPref, LatencyMode, ResolutionPref } from '../types.ts'
import { button, field, h, iconButton, select, toggle } from './dom.ts'
import { RESOLUTION_OPTIONS, resolutionFromValue } from './format.ts'
import { t } from '../i18n.ts'

let openEl: HTMLElement | null = null

export function isSettingsOpen(): boolean {
  return openEl !== null
}

const lines = (v: string): string[] =>
  v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)

export function openSettings(settings: AppSettings, onSaved?: () => void): void {
  if (openEl) return
  const net = settings.net
  const turn0 = net.turn[0]
  const draft = {
    resolution: settings.stream.resolution as ResolutionPref,
    codec: settings.stream.codec as CodecPref,
    audio: settings.stream.audio,
    maxDirect: settings.maxDirect,
    upload: settings.uploadLimitKbps,
    approve: settings.requireApproval,
    relay: settings.allowRelay,
    latency: settings.latencyMode as LatencyMode,
    test: settings.showTestStream,
    lang: settings.lang,
  }

  const lang = select<AppSettings['lang']>(
    'set-lang',
    [
      ['auto', t('set.lang.auto')],
      ['de', 'Deutsch'],
      ['en', 'English'],
    ],
    draft.lang,
    (v) => (draft.lang = v),
  )

  const res = select<string>('set-res', RESOLUTION_OPTIONS, String(draft.resolution), (v) => (draft.resolution = resolutionFromValue(v)))
  const codec = select<CodecPref>(
    'set-codec',
    [
      ['auto', t('set.codec.auto')],
      ['AV1', 'AV1'],
      ['H264', 'H.264'],
      ['VP9', 'VP9'],
    ],
    draft.codec,
    (v) => (draft.codec = v),
  )
  const maxDirect = select<number>('set-direct', [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)] as const), draft.maxDirect, (v) => (draft.maxDirect = v))
  const upload = h('input', { id: 'set-upload', class: 'input', type: 'number', min: 0, step: 1, placeholder: t('set.unlimited'), value: draft.upload > 0 ? Math.round(draft.upload / 1000) : '' })
  upload.addEventListener('input', () => (draft.upload = Math.max(0, Math.round(Number(upload.value) || 0)) * 1000))
  const latency = select<LatencyMode>(
    'set-latency',
    [
      ['lowest', t('set.lat.lowest')],
      ['smooth', t('set.lat.smooth')],
    ],
    draft.latency,
    (v) => (draft.latency = v),
  )

  const brokers = h('textarea', { id: 'set-brokers', class: 'input mono', rows: 4, spellcheck: 'false' })
  brokers.value = net.brokers.join('\n')
  const stun = h('textarea', { id: 'set-stun', class: 'input mono', rows: 3, spellcheck: 'false' })
  stun.value = net.stun.join('\n')
  const turnUrl = h('input', { id: 'set-turn', class: 'input mono', type: 'text', spellcheck: 'false', placeholder: 'turn:server:3478', value: turn0?.urls ?? '' })
  const turnUser = h('input', { id: 'set-turn-user', class: 'input', type: 'text', autocomplete: 'off', placeholder: t('set.user'), value: turn0?.username ?? '' })
  const turnPass = h('input', { id: 'set-turn-pass', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: t('set.password'), value: turn0?.credential ?? '' })
  const err = h('div', { class: 'warnline', role: 'status', 'aria-live': 'polite' })

  const close = () => {
    back.remove()
    sheet.remove()
    document.removeEventListener('keydown', onKey, true)
    openEl = null
  }
  const save = () => {
    const b = lines(brokers.value)
    const s = lines(stun.value)
    const turnAddr = turnUrl.value.trim()
    const bad: string[] = []
    if (b.some((x) => !isValidBroker(x))) bad.push(t('set.badBroker'))
    if (s.some((x) => !isValidStun(x))) bad.push(t('set.badStun'))
    if (turnAddr && !isValidTurn(turnAddr)) bad.push(t('set.badTurn'))
    if (bad.length) {
      err.textContent = bad.join(' ')
      return
    }
    settings.stream = { ...settings.stream, resolution: draft.resolution, codec: draft.codec, audio: draft.audio }
    settings.maxDirect = draft.maxDirect
    settings.uploadLimitKbps = draft.upload
    settings.requireApproval = draft.approve
    settings.allowRelay = draft.relay
    settings.latencyMode = draft.latency
    settings.showTestStream = draft.test
    settings.lang = draft.lang
    settings.net = sanitizeNet({ brokers: b, stun: s, turn: turnAddr ? [{ urls: turnAddr, username: turnUser.value.trim(), credential: turnPass.value }] : [] })
    saveSettings(settings)
    onSaved?.()
    close()
  }
  const resetNet = () => {
    const d = defaultNet()
    brokers.value = d.brokers.join('\n')
    stun.value = d.stun.join('\n')
    turnUrl.value = turnUser.value = turnPass.value = ''
  }

  const back = h('div', { class: 'sheet-back', onclick: close })
  const sheet = h(
    'aside',
    { class: 'sheet', id: 'settings-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('set.title') },
    h('div', { class: 'sheet-head' }, h('span', null, t('set.title')), iconButton('x', t('set.close'), { onclick: close })),
    h(
      'div',
      { class: 'sheet-body scroll' },
      field(t('set.lang'), 'set-lang', lang),
      field(t('set.quality'), 'set-res', res, h('small', null, t('set.qualityHint'))),
      toggle('set-audio', t('set.audio'), draft.audio, (on) => (draft.audio = on)),
      field(t('set.watching'), 'set-latency', latency),
      h(
        'details',
        { class: 'expert' },
        h('summary', null, t('set.expert')),
        h(
          'div',
          { class: 'expert-body' },
          h('div', { class: 'grid2' }, field(t('set.codec'), 'set-codec', codec), field(t('set.direct'), 'set-direct', maxDirect)),
          field(t('set.upload'), 'set-upload', upload),
          toggle('set-approve', t('set.approve'), draft.approve, (on) => (draft.approve = on)),
          toggle('set-relay', t('set.relay'), draft.relay, (on) => (draft.relay = on), t('set.relayHint')),
          field(t('set.brokers'), 'set-brokers', brokers),
          field('STUN', 'set-stun', stun),
          field(t('set.turn'), 'set-turn', turnUrl, h('div', { class: 'grid2' }, turnUser, turnPass)),
          button(t('set.resetNet'), { cls: 'text', onclick: resetNet }),
          toggle('set-test', t('set.testBtn'), draft.test, (on) => (draft.test = on)),
        ),
      ),
      err,
    ),
    h('div', { class: 'sheet-foot' }, button(t('set.cancel'), { onclick: close }), button(t('set.done'), { id: 'settings-save', cls: 'primary', onclick: save })),
  )
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey, true)
  document.body.append(back, sheet)
  openEl = sheet
}

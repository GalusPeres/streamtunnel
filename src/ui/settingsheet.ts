// Settings dialog: tabs on the left (General / Sharing / Watching / Connection), one short row per setting.
// Nothing is collapsed; every tab fits without scrolling. Saved on "Fertig".
import type { AppSettings } from '../settings.ts'
import { cleanName, defaultNet, isValidBroker, isValidStun, isValidTurn, sanitizeNet, saveSettings } from '../settings.ts'
import type { CodecPref, LatencyMode, ResolutionPref } from '../types.ts'
import { button, h, iconButton, select } from './dom.ts'
import { RESOLUTION_OPTIONS, resolutionFromValue } from './format.ts'
import { t } from '../i18n.ts'

let openEl: HTMLElement | null = null
let lastTab = 0

export function isSettingsOpen(): boolean {
  return openEl !== null
}

const lines = (v: string): string[] =>
  v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)

/** One line: label left, control right. */
function row(label: string, forId: string, control: HTMLElement): HTMLDivElement {
  return h('div', { class: 'sd-row' }, h('label', { for: forId }, label), control)
}

/** One line with a switch on the right. */
function switchRow(id: string, label: string, checked: boolean, onchange: (on: boolean) => void): HTMLDivElement {
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked })
  input.addEventListener('change', () => onchange(input.checked))
  return h('div', { class: 'sd-row' }, h('label', { for: id }, label), h('span', { class: 'switch sd-switch' }, input))
}

/** Label above a wide control (lists of addresses). */
function block(label: string, forId: string, ...controls: HTMLElement[]): HTMLDivElement {
  return h('div', { class: 'sd-block' }, h('label', { for: forId }, label), ...controls)
}

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
    name: settings.name,
  }
  const nameInput = h('input', { id: 'set-name', class: 'input', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', value: draft.name })
  nameInput.addEventListener('input', () => (draft.name = nameInput.value))

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
      ['HEVC', 'HEVC (H.265)'],
      ['H264', 'H.264'],
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
  const err = h('div', { class: 'sd-err', role: 'status', 'aria-live': 'polite' })

  const resetNet = () => {
    const d = defaultNet()
    brokers.value = d.brokers.join('\n')
    stun.value = d.stun.join('\n')
    turnUrl.value = turnUser.value = turnPass.value = ''
  }

  const tabs: { label: string; body: HTMLElement }[] = [
    {
      label: t('set.tab.general'),
      body: h('div', { class: 'sd-page' }, row(t('set.name'), 'set-name', nameInput), row(t('set.lang'), 'set-lang', lang)),
    },
    {
      label: t('set.tab.share'),
      body: h(
        'div',
        { class: 'sd-page' },
        row(t('set.quality'), 'set-res', res),
        switchRow('set-audio', t('set.audio'), draft.audio, (on) => (draft.audio = on)),
        row(t('set.codec'), 'set-codec', codec),
        row(t('set.direct'), 'set-direct', maxDirect),
        row(t('set.upload'), 'set-upload', upload),
        switchRow('set-approve', t('set.approve'), draft.approve, (on) => (draft.approve = on)),
      ),
    },
    {
      label: t('set.tab.watch'),
      body: h('div', { class: 'sd-page' }, row(t('set.latency'), 'set-latency', latency), switchRow('set-relay', t('set.relay'), draft.relay, (on) => (draft.relay = on))),
    },
    {
      label: t('set.tab.net'),
      body: h(
        'div',
        { class: 'sd-page' },
        block(t('set.brokers'), 'set-brokers', brokers),
        block('STUN', 'set-stun', stun),
        block('TURN', 'set-turn', turnUrl, h('div', { class: 'sd-two' }, turnUser, turnPass)),
        switchRow('set-test', t('set.testBtn'), draft.test, (on) => (draft.test = on)),
        h('div', { class: 'sd-actions' }, button(t('set.resetNet'), { cls: 'b-btn b-secondary b-sm', onclick: resetNet })),
      ),
    },
  ]

  const navBtns = tabs.map((tab, i) =>
    h('button', { type: 'button', class: 'sd-tab', role: 'tab', id: `set-tab-${i}`, 'aria-selected': 'false', onclick: () => show(i) }, tab.label),
  )
  const heading = h('h2', { class: 'sd-title' })
  const pages = h('div', { class: 'sd-pages' }, ...tabs.map((tab) => tab.body))
  function show(i: number): void {
    lastTab = i
    tabs.forEach((tab, j) => {
      tab.body.hidden = j !== i
      navBtns[j].setAttribute('aria-selected', String(j === i))
    })
    heading.textContent = tabs[i].label
  }

  const close = () => {
    back.remove()
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
      show(3)
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
    settings.name = cleanName(draft.name) || settings.name
    settings.net = sanitizeNet({ brokers: b, stun: s, turn: turnAddr ? [{ urls: turnAddr, username: turnUser.value.trim(), credential: turnPass.value }] : [] })
    saveSettings(settings)
    onSaved?.()
    close()
  }

  const dialog = h(
    'div',
    { class: 'sd-dialog', id: 'settings-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('set.title') },
    h('nav', { class: 'sd-nav', role: 'tablist' }, h('div', { class: 'sd-navhead' }, t('set.title')), ...navBtns, h('div', { class: 'sd-version', id: 'app-version' }, typeof __APP_VERSION__ === 'string' ? `Version ${__APP_VERSION__}` : '')),
    h(
      'div',
      { class: 'sd-main' },
      h('div', { class: 'sd-head' }, heading, iconButton('x', t('set.close'), { onclick: close })),
      pages,
      h('div', { class: 'sd-foot' }, err, button(t('set.cancel'), { cls: 'b-btn b-secondary', onclick: close }), button(t('set.done'), { id: 'settings-save', cls: 'b-btn b-primary', onclick: save })),
    ),
  )
  const back = h('div', { class: 'sd-back' }, dialog)
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close()
  })
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  show(lastTab)
  document.addEventListener('keydown', onKey, true)
  document.body.append(back)
  openEl = dialog
}

// Tunnel screen — obvious structure: code + ONE copy button on top, people as tiles in the middle, and every
// action in ONE fixed bar at the bottom (Bildschirm teilen · Einstellungen · Tunnel verlassen).
import type { ContentMode, FpsPref, StreamSettings, TunnelMember, ViewerInfo } from '../types.ts'
import { copyText } from '../platform.ts'
import { button, clear, h, icon, setHidden, setText } from './dom.ts'
import type { View } from './dom.ts'
import { connLabel, inviteText, kbpsToSlider, mbit, ms, prettyCode, sliderToKbps } from './format.ts'

export interface TunnelActions {
  share(): void
  shareTest(): void
  stopShare(): void
  switchSource(): void
  watch(memberId: string): void
  leave(): void
  kick(viewerId: string): void
  decide(viewerId: string, ok: boolean): void
  updateSettings(next: StreamSettings): void
  setLocked(locked: boolean): void
  openSettings?(): void
}

export interface MyShare {
  title: string
  audio: boolean
  since: number
  test: boolean
}

export interface TunnelView extends View {
  setMembers(members: TunnelMember[]): void
  /** null = not sharing */
  setShare(share: MyShare | null, settings: StreamSettings): void
  setViewers(viewers: ViewerInfo[], relayed: number): void
  setWarning(text: string | null): void
  setBusy(text: string | null): void
}

const FPS: readonly FpsPref[] = [30, 60, 120]
const CONTENT: ReadonlyArray<readonly [ContentMode, string]> = [
  ['motion', 'Flüssig'],
  ['balanced', 'Ausgewogen'],
  ['detail', 'Scharf'],
]

function seg<T>(id: string, label: string, options: ReadonlyArray<readonly [T, string]>, onpick: (v: T) => void): { el: HTMLElement; set(v: T): void } {
  const btns = options.map(([v, text]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', onclick: () => onpick(v) }, text)
    return [v, b] as const
  })
  const el = h('div', { class: 'seg', role: 'radiogroup', id, 'aria-label': label }, ...btns.map(([, b]) => b))
  return {
    el,
    set(v) {
      for (const [bv, b] of btns) b.setAttribute('aria-checked', String(bv === v))
    },
  }
}

function spec(l: { width: number; height: number; fps: number }): string {
  const res = l.height >= 2000 ? '4K' : l.height > 0 ? `${l.height}p` : ''
  return [res, l.fps > 0 ? `${Math.round(l.fps)} FPS` : ''].filter(Boolean).join(' · ')
}

function duration(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`
}


export function mountTunnel(ctx: { code: string; showTest: boolean; actions: TunnelActions }): TunnelView {
  const { actions } = ctx
  const pretty = prettyCode(ctx.code)
  let settings: StreamSettings | null = null
  let share: MyShare | null = null
  let members: TunnelMember[] = []
  let destroyed = false

  // ── top: code + one copy button ──
  const codeText = h('button', { type: 'button', class: 'big-code', id: 'room-code', 'data-code': ctx.code, title: 'Code kopieren' }, pretty)
  const copyLabel = h('span', null, 'Code kopieren')
  const copyBtn = h('button', { type: 'button', class: 'btn', id: 'copy-btn' }, icon('copy'), copyLabel)
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  const copy = () =>
    void copyText(inviteText(ctx.code)).then((ok) => {
      if (!ok) return
      setText(copyLabel, 'Kopiert ✓')
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setText(copyLabel, 'Code kopieren'), 1500)
    })
  codeText.addEventListener('click', copy)
  copyBtn.addEventListener('click', copy)
  const countEl = h('span', { id: 'member-count' }, '1')
  const head = h(
    'header',
    { class: 't2-head' },
    h('div', { class: 't2-code' }, h('div', { class: 't2-hint' }, 'Schick diesen Code deinen Freunden:'), h('div', { class: 't2-code-row' }, codeText, copyBtn)),
    h('div', { class: 't2-count' }, countEl, h('span', null, ' im Tunnel')),
  )

  // ── middle: tiles ──
  const notice = h('div', { class: 't2-notice', id: 'empty-stage' })
  const busyLine = h('div', { class: 't2-notice', hidden: true, role: 'status', 'aria-live': 'polite' })
  const grid = h('div', { class: 'tiles', id: 'members', role: 'list' })

  // ── my stream panel (only while sharing) ──
  const timer = h('span', { class: 'num', id: 'live-timer' }, '00:00')
  const titleEl = h('span', { id: 'live-title' })
  const warn = h('div', { class: 'warnline', id: 'share-warn', role: 'status', 'aria-live': 'polite' })
  const viewerCount = h('span', { id: 'viewer-count' }, '0')
  const watchers = h('div', { class: 'watchers', id: 'watchers' })
  const noWatchers = h('div', { class: 'faint w-empty' }, 'Noch schaut niemand zu.')
  const fpsSeg = seg<FpsPref>('fps-seg', 'Bilder pro Sekunde', FPS.map((f) => [f, `${f} FPS`] as const), (v) => change({ fps: v }))
  const contentSeg = seg<ContentMode>('content-seg', 'Bild', CONTENT, (v) => change({ content: v }))
  const bitrate = h('input', { id: 'bitrate', type: 'range', class: 'range', min: 1, max: 60, step: 1, 'aria-label': 'Bitrate' })
  const bitrateOut = h('output', { for: 'bitrate' }, 'Auto')
  bitrate.addEventListener('input', () => setText(bitrateOut, labelKbps(sliderToKbps(Number(bitrate.value)))))
  bitrate.addEventListener('change', () => change({ bitrateKbps: sliderToKbps(Number(bitrate.value)) }))
  const lockInput = h('input', { type: 'checkbox', id: 'lock', role: 'switch' })
  lockInput.addEventListener('change', () => actions.setLocked(lockInput.checked))
  const mine = h(
    'section',
    { class: 'mine', id: 'my-stream', hidden: true, 'aria-label': 'Dein Stream' },
    h('div', { class: 'mine-title' }, h('span', { class: 'live-pill' }, h('span', { class: 'dot live' }), 'Du bist live'), titleEl, h('span', { class: 'faint' }, '·'), timer, h('span', { class: 'faint' }, '·'), h('span', null, viewerCount, ' schauen zu')),
    warn,
    noWatchers,
    watchers,
    h(
      'div',
      { class: 'mine-ctl' },
      h('label', { class: 'ctl' }, h('span', null, 'Bildrate'), fpsSeg.el),
      h('label', { class: 'ctl' }, h('span', null, 'Bild'), contentSeg.el),
      h('label', { class: 'ctl' }, h('span', null, 'Bitrate'), bitrate, bitrateOut),
      h('label', { class: 'switch', for: 'lock' }, lockInput, h('span', null, 'Keine neuen Zuschauer')),
    ),
  )

  const middle = h('section', { class: 't2-mid scroll' }, notice, busyLine, grid, mine)

  // ── bottom bar: every action, always in the same place ──
  const shareBtn = button('Bildschirm teilen', { id: 'share-btn', cls: 'primary big', icon: 'monitor', onclick: () => actions.share() })
  const testBtn = ctx.showTest ? button('Testbild', { id: 'test-stream', cls: 'big', icon: 'play', onclick: () => actions.shareTest() }) : null
  const switchBtn = button('Quelle wechseln', { id: 'switch-btn', cls: 'big', icon: 'swap', onclick: () => actions.switchSource() })
  const stopBtn = button('Teilen beenden', { id: 'stop-btn', cls: 'danger big', icon: 'stop', onclick: () => actions.stopShare() })
  const settingsBtn = button('Einstellungen', { id: 'tunnel-settings-btn', cls: 'big', icon: 'sliders', onclick: () => actions.openSettings?.() })
  const leaveBtn = button('Tunnel verlassen', { id: 'leave-btn', cls: 'big ghost-danger', icon: 'leave', onclick: () => actions.leave() })
  const bar = h('footer', { class: 'actionbar' }, shareBtn, testBtn, switchBtn, stopBtn, h('span', { class: 'sep' }), settingsBtn, leaveBtn)

  const root = h('main', { class: 'tunnel2', id: 'tunnel' }, head, middle, bar)

  function labelKbps(kbps: number): string {
    return kbps > 0 ? mbit(kbps) : 'Auto'
  }

  function change(patch: Partial<StreamSettings>): void {
    if (!settings) return
    settings = { ...settings, ...patch }
    renderControls()
    actions.updateSettings(settings)
  }

  function renderControls(): void {
    if (!settings) return
    fpsSeg.set(settings.fps)
    contentSeg.set(settings.content)
    bitrate.value = String(kbpsToSlider(settings.bitrateKbps))
    setText(bitrateOut, labelKbps(settings.bitrateKbps))
  }

  function tile(m: TunnelMember): HTMLElement {
    const live = m.live
    const el = h('div', { class: `tile${live ? ' is-live' : ''}${m.self ? ' is-self' : ''}`, role: 'listitem', 'data-member-id': m.id, 'data-live': live ? 'true' : 'false' })
    const avatar = h('span', { class: `dot ${live ? 'live' : m.self ? 'ok' : 'idle'}` })
    const nameEl = h('div', { class: 'tile-name' }, m.name, m.self ? h('span', { class: 'you' }, ' (du)') : null)
    if (live) {
      el.append(
        h('div', { class: 'tile-top' }, h('span', { class: 'live-pill' }, h('span', { class: 'dot live' }), 'LIVE'), h('span', { class: 'tile-viewers' }, live.viewers === 1 ? '1 schaut zu' : `${live.viewers} schauen zu`)),
        h('div', { class: 'tile-title' }, live.title || 'Bildschirm'),
        h('div', { class: 'tile-spec' }, spec(live), live.audio ? ' · mit Ton' : ' · ohne Ton'),
        h('div', { class: 'tile-foot' }, avatar, nameEl),
      )
      if (!m.self) {
        el.append(button('Ansehen', { cls: 'primary big watch-btn', icon: 'play', onclick: () => actions.watch(m.id) }))
        el.addEventListener('click', (e) => {
          if (!(e.target as HTMLElement).closest('button')) actions.watch(m.id)
        })
      } else {
        el.append(h('div', { class: 'tile-note' }, 'Das bist du'))
      }
    } else {
      el.append(h('div', { class: 'tile-foot' }, avatar, nameEl), h('div', { class: 'tile-note' }, m.self ? 'Du teilst gerade nichts' : 'teilt gerade nichts'))
    }
    return el
  }

  function render(): void {
    clear(grid)
    for (const m of members) grid.append(tile(m))
    setText(countEl, String(members.length))
    const anyOtherLive = members.some((m) => m.live && !m.self)
    const alone = members.length <= 1
    let msg = ''
    if (share) msg = ''
    else if (anyOtherLive) msg = 'Klick auf „Ansehen“, um zuzuschauen – oder teile selbst mit dem Knopf unten.'
    else if (alone) msg = 'Noch bist du allein. Schick den Code oben an deine Freunde – oder teile schon mal deinen Bildschirm.'
    else msg = 'Gerade teilt niemand. Teile deinen Bildschirm mit dem Knopf unten.'
    setText(notice, msg)
    setHidden(notice, !msg)
    const sharing = share !== null
    setHidden(shareBtn, sharing)
    if (testBtn) setHidden(testBtn, sharing)
    setHidden(switchBtn, !sharing)
    setHidden(stopBtn, !sharing)
  }

  let tick: ReturnType<typeof setInterval> | null = null

  return {
    el: root,
    setMembers(next) {
      if (destroyed) return
      members = next
      render()
    },
    setShare(next, s) {
      if (!next) lockInput.checked = false
      if (destroyed) return
      share = next
      settings = { ...s }
      setHidden(mine, next === null)
      if (next) {
        setText(titleEl, next.title || 'Bildschirm')
        setText(timer, duration(next.since))
        tick ??= setInterval(() => share && setText(timer, duration(share.since)), 1000)
        renderControls()
      } else if (tick) {
        clearInterval(tick)
        tick = null
      }
      render()
    },
    setViewers(viewers, relayed) {
      if (destroyed) return
      clear(watchers)
      const connected = viewers.filter((v) => v.state === 'connected').length
      setText(viewerCount, String(connected + relayed))
      setHidden(noWatchers, viewers.length > 0 || relayed > 0)
      for (const v of viewers) {
        const st = v.state
        const row = h('div', { class: 'w-row', 'data-viewer-id': v.id, 'data-state': st })
        const dot = h('span', { class: `dot ${st === 'connected' ? 'ok' : st === 'pending' ? 'warn' : 'idle'}` })
        row.append(h('div', { class: 'w-name' }, dot, h('span', null, v.name)))
        if (st === 'pending') {
          row.append(
            h(
              'div',
              { class: 'pending' },
              h('span', { class: 'faint' }, 'möchte zuschauen'),
              button('Zulassen', { cls: 'primary', onclick: () => actions.decide(v.id, true) }),
              button('Ablehnen', { onclick: () => actions.decide(v.id, false) }),
            ),
          )
        } else {
          const tx = v.tx
          const rx = v.rx
          const pic = tx && tx.height > 0 ? `${tx.height}p · ${Math.round(rx?.fps ?? tx.fps)} FPS` : st === 'connecting' ? 'verbindet…' : '–'
          const kids = rx && rx.descendants > 0 ? ` · reicht an ${rx.descendants} weiter` : ''
          row.append(
            h('span', { class: 'w-num' }, pic),
            h('span', { class: 'w-num' }, rx?.latencyMs != null ? ms(rx.latencyMs, true) : ms(tx?.rttMs ?? null)),
            h('span', { class: 'w-num' }, `${tx ? connLabel(tx.connType) : '–'}${kids}`),
            button('Entfernen', { cls: 'text w-kick', onclick: () => actions.kick(v.id) }),
          )
        }
        watchers.append(row)
      }
    },
    setWarning(text) {
      if (destroyed) return
      clear(warn)
      if (text) warn.append(icon('alert'), h('span', null, text))
    },
    setBusy(text) {
      if (destroyed) return
      setHidden(busyLine, !text)
      setText(busyLine, text ?? '')
      shareBtn.disabled = text !== null
      if (testBtn) testBtn.disabled = text !== null
    },
    destroy() {
      destroyed = true
      if (tick) clearInterval(tick)
      if (copyTimer) clearTimeout(copyTimer)
    },
  }
}

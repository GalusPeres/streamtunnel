// Tunnel screen (design B "Sprachkanal"): sidebar with the code + everyone in the tunnel, the live streams large in
// the middle, and every action in one dock at the bottom.
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
const AVATAR_COLORS = ['#f2b66d', '#8fc7a9', '#c9a6e0', '#9fb8d8', '#e8a0a0', '#a8d0e6', '#d6c38f', '#b5e08f']

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

function minutesSince(since: number): string {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000))
  return m < 1 ? 'gerade gestartet' : `seit ${m} Min.`
}

function avatar(name: string, id: string, size = ''): HTMLElement {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const el = h('span', { class: `b-avatar ${size}`, 'aria-hidden': 'true' }, (name.trim()[0] ?? '?').toUpperCase())
  el.style.background = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
  return el
}

export function mountTunnel(ctx: { code: string; showTest: boolean; actions: TunnelActions }): TunnelView {
  const { actions } = ctx
  const pretty = prettyCode(ctx.code)
  let settings: StreamSettings | null = null
  let share: MyShare | null = null
  let members: TunnelMember[] = []
  let destroyed = false

  // ── sidebar ──
  const codeText = h('button', { type: 'button', class: 'b-code', id: 'room-code', 'data-code': ctx.code, title: 'Code kopieren' }, pretty)
  const copyLabel = h('span', null, 'Code kopieren')
  const copyBtn = h('button', { type: 'button', class: 'b-btn b-primary', id: 'copy-btn' }, icon('copy'), copyLabel)
  const inviteLabel = h('span', null, 'Einladungstext kopieren')
  const inviteBtn = h('button', { type: 'button', class: 'b-btn b-secondary', id: 'invite-btn' }, icon('link'), inviteLabel)
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  const flash = (label: HTMLElement, text: string) => {
    setText(label, 'Kopiert ✓')
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      setText(copyLabel, 'Code kopieren')
      setText(inviteLabel, 'Einladungstext kopieren')
    }, 1500)
    void text
  }
  const copyCode = () => void copyText(pretty).then((ok) => ok && flash(copyLabel, pretty))
  codeText.addEventListener('click', copyCode)
  copyBtn.addEventListener('click', copyCode)
  inviteBtn.addEventListener('click', () => void copyText(inviteText(ctx.code)).then((ok) => ok && flash(inviteLabel, '')))

  const liveHead = h('div', { class: 'b-sec' })
  const liveList = h('div', { class: 'b-members' })
  const restHead = h('div', { class: 'b-sec' })
  const restList = h('div', { class: 'b-members', id: 'members', role: 'list' })
  const countEl = h('span', { id: 'member-count' }, '1')
  const side = h(
    'aside',
    { class: 'b-side' },
    h(
      'div',
      { class: 'b-codebox' },
      h('div', { class: 'b-lbl' }, 'Tunnel-Code'),
      codeText,
      h('div', { class: 'b-col' }, copyBtn, inviteBtn),
      h('div', { class: 'b-hint' }, 'Freunde öffnen StreamTunnel und geben den Code bei „Mit Code beitreten“ ein.'),
    ),
    h('div', { class: 'b-side-scroll scroll' }, liveHead, liveList, restHead, restList),
    h('div', { class: 'b-conn' }, h('i', null), countEl, h('span', null, ' im Tunnel – direkt verbunden')),
  )

  // ── stage ──
  const stageTitle = h('h1', null, 'Gerade live')
  const stageSub = h('span', { class: 'b-sub' })
  const stageCards = h('div', { class: 'b-cards' })
  const empty = h(
    'div',
    { class: 'b-empty', id: 'empty-stage' },
    h('div', { class: 'b-empty-ico' }, icon('monitor')),
    h('h2', null, 'Gerade teilt niemand'),
    h('p', null, 'Klick unten auf „Bildschirm teilen“, um dein Spiel oder deinen Bildschirm zu zeigen – oder warte, bis jemand live geht.'),
  )
  const others = h('div', { class: 'b-others' })
  const busyLine = h('div', { class: 'b-busy', hidden: true, role: 'status', 'aria-live': 'polite' })

  // my stream panel
  const timer = h('span', { class: 'num', id: 'live-timer' }, '00:00')
  const titleEl = h('b', { id: 'live-title' })
  const warn = h('div', { class: 'warnline', id: 'share-warn', role: 'status', 'aria-live': 'polite' })
  const viewerCount = h('span', { id: 'viewer-count' }, '0')
  const watchers = h('div', { class: 'watchers', id: 'watchers' })
  const noWatchers = h('div', { class: 'b-hint' }, 'Noch schaut niemand zu.')
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
    { class: 'b-mine', id: 'my-stream', hidden: true, 'aria-label': 'Dein Stream' },
    h('div', { class: 'b-mine-head' }, h('span', { class: 'b-live' }, 'LIVE'), h('span', null, 'Du teilst ', titleEl), h('span', { class: 'b-dim' }, timer), h('span', { class: 'b-dim' }, viewerCount, ' schauen zu')),
    warn,
    noWatchers,
    watchers,
    h(
      'div',
      { class: 'b-mine-ctl' },
      h('label', { class: 'b-ctl' }, h('span', null, 'Bildrate'), fpsSeg.el),
      h('label', { class: 'b-ctl' }, h('span', null, 'Bild'), contentSeg.el),
      h('label', { class: 'b-ctl' }, h('span', null, 'Bitrate'), bitrate, bitrateOut),
      h('label', { class: 'switch', for: 'lock' }, lockInput, h('span', null, 'Keine neuen Zuschauer')),
    ),
  )

  const stage = h(
    'section',
    { class: 'b-stage' },
    h('header', { class: 'b-stage-head' }, stageTitle, stageSub, h('span', { class: 'b-right' }, 'Alle sind gleichberechtigt – jeder kann teilen')),
    h('div', { class: 'b-stage-body scroll' }, busyLine, mine, stageCards, empty, others),
  )

  // ── dock ──
  const shareBtn = button('Bildschirm teilen', { id: 'share-btn', cls: 'b-dbtn b-share', icon: 'monitor', onclick: () => actions.share() })
  const testBtn = ctx.showTest ? button('Testbild', { id: 'test-stream', cls: 'b-dbtn', icon: 'play', onclick: () => actions.shareTest() }) : null
  const switchBtn = button('Quelle wechseln', { id: 'switch-btn', cls: 'b-dbtn', icon: 'swap', onclick: () => actions.switchSource() })
  const stopBtn = button('Teilen beenden', { id: 'stop-btn', cls: 'b-dbtn b-leave', icon: 'stop', onclick: () => actions.stopShare() })
  const settingsBtn = button('Einstellungen', { id: 'tunnel-settings-btn', cls: 'b-dbtn', icon: 'sliders', onclick: () => actions.openSettings?.() })
  const leaveBtn = button('Tunnel verlassen', { id: 'leave-btn', cls: 'b-dbtn b-leave', icon: 'leave', onclick: () => actions.leave() })
  const dock = h('footer', { class: 'b-dock' }, h('div', { class: 'b-dock-inner' }, shareBtn, testBtn, switchBtn, stopBtn, h('span', { class: 'b-dock-sep' }), settingsBtn, leaveBtn))

  const root = h('main', { class: 'b-view b-tunnel', id: 'tunnel' }, side, h('div', { class: 'b-right-col' }, stage, dock))

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

  function memberItem(m: TunnelMember): HTMLElement {
    const live = m.live
    const el = h('div', { class: `b-member${live ? ' is-live' : ''}`, role: 'listitem', 'data-member-id': m.id, 'data-live': live ? 'true' : 'false' })
    const av = avatar(m.name, m.id)
    av.append(h('span', { class: 'b-online' }))
    const status = live ? (m.self ? `Du teilst „${live.title || 'Bildschirm'}“` : live.title || 'Bildschirm') : m.self ? 'Du teilst nichts' : 'teilt nicht'
    el.append(av, h('div', { class: 'b-mtext' }, h('div', { class: 'b-nm' }, m.name, m.self ? h('span', { class: 'b-you' }, 'du') : null), h('div', { class: `b-st${live ? ' b-livetitle' : ''}` }, status)))
    if (live && !m.self) {
      el.append(button('Ansehen', { cls: 'b-btn b-primary b-sm watch-btn', onclick: () => actions.watch(m.id) }))
      el.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('button')) actions.watch(m.id)
      })
    } else if (live) {
      el.append(h('span', { class: 'b-live' }, 'LIVE'))
    }
    return el
  }

  function streamCard(m: TunnelMember): HTMLElement {
    const live = m.live!
    const watch = () => actions.watch(m.id)
    const preview = h(
      'div',
      { class: 'b-preview', onclick: watch },
      h('div', { class: 'b-tl' }, h('span', { class: 'b-live' }, 'LIVE'), h('span', { class: 'b-chip' }, minutesSince(live.since))),
      h('div', { class: 'b-play' }, h('span', null, icon('play'), 'Ansehen')),
    )
    return h(
      'article',
      { class: 'b-card', 'data-card-id': m.id },
      preview,
      h(
        'div',
        { class: 'b-card-info' },
        avatar(m.name, m.id, 'b-lgav'),
        h('div', null, h('div', { class: 'b-t1' }, `${m.name} teilt „${live.title || 'Bildschirm'}“`), h('div', { class: 'b-t2' }, h('b', null, spec(live)), live.audio ? ' · mit Ton' : ' · ohne Ton', ` · ${live.viewers === 1 ? '1 schaut zu' : `${live.viewers} schauen zu`}`)),
        button('Ansehen', { cls: 'b-btn b-primary b-lg', icon: 'play', onclick: watch }),
      ),
    )
  }

  function render(): void {
    const live = members.filter((m) => m.live)
    const rest = members.filter((m) => !m.live)
    clear(liveList)
    clear(restList)
    for (const m of live) liveList.append(memberItem(m))
    for (const m of rest) restList.append(memberItem(m))
    setText(liveHead, `Live · ${live.length}`)
    setHidden(liveHead, live.length === 0)
    setText(restHead, `Im Tunnel · ${rest.length}`)
    setHidden(restHead, rest.length === 0)
    setText(countEl, String(members.length))

    const otherLive = live.filter((m) => !m.self)
    clear(stageCards)
    for (const m of otherLive) stageCards.append(streamCard(m))
    setText(stageTitle, otherLive.length || share ? 'Gerade live' : 'Noch niemand live')
    setText(stageSub, otherLive.length ? (otherLive.length === 1 ? '1 Stream' : `${otherLive.length} Streams`) : '')
    setHidden(empty, otherLive.length > 0 || share !== null)

    const idle = rest.filter((m) => !m.self).map((m) => m.name)
    const meIdle = rest.some((m) => m.self)
    clear(others)
    if (members.length <= 1) {
      others.append(h('span', null, 'Noch bist du allein. Schick den Code links an deine Freunde.'))
    } else if (idle.length || meIdle) {
      const names = [...idle, ...(meIdle ? ['du'] : [])]
      const text = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`
      others.append(h('span', null, h('b', null, text), names.length === 1 && !meIdle ? ' teilt gerade nicht.' : ' teilen gerade nicht. Jeder kann jederzeit selbst teilen.'))
    }
    setHidden(others, others.childNodes.length === 0)

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
        setText(titleEl, `„${next.title || 'Bildschirm'}“${next.audio ? ' mit Ton' : ' ohne Ton'}`)
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
              h('span', { class: 'b-dim' }, 'möchte zuschauen'),
              button('Zulassen', { cls: 'b-btn b-primary b-sm', onclick: () => actions.decide(v.id, true) }),
              button('Ablehnen', { cls: 'b-btn b-secondary b-sm', onclick: () => actions.decide(v.id, false) }),
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
            button('Entfernen', { cls: 'b-btn b-secondary b-sm w-kick', onclick: () => actions.kick(v.id) }),
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

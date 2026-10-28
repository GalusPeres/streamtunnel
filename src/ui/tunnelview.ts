// Tunnel screen — minimal: sidebar = back, code, people; middle = live streams; bottom = share + settings.
// Rule: no explanatory sentences. Names, icons, one-word buttons.
import type { ContentMode, FpsPref, ResolutionPref, StreamSettings, TunnelMember, ViewerInfo } from '../types.ts'
import { copyText } from '../platform.ts'
import { button, clear, h, icon, setHidden, setText } from './dom.ts'
import type { View } from './dom.ts'
import { avatarColor, connLabel, kbpsToSlider, mbit, ms, prettyCode, resolutionFromValue, sliderToKbps } from './format.ts'
import { t } from '../i18n.ts'
import type { Key } from '../i18n.ts'

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
const RES: ReadonlyArray<readonly [ResolutionPref, string]> = [
  [720, '720p'],
  [1080, '1080p'],
  [1440, '1440p'],
  [2160, '4K'],
]
const CONTENT: ReadonlyArray<readonly [ContentMode, Key]> = [
  ['motion', 'tunnel.content.motion'],
  ['detail', 'tunnel.content.detail'],
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

function spec(l: { height: number; fps: number }): string {
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

function avatar(name: string, _id: string, size = ''): HTMLElement {
  const el = h('span', { class: `b-avatar ${size}`, 'aria-hidden': 'true' }, (name.trim()[0] ?? '?').toUpperCase())
  el.style.background = avatarColor(name)
  return el
}

export function mountTunnel(ctx: { code: string; showTest: boolean; actions: TunnelActions; user: HTMLElement }): TunnelView {
  const { actions } = ctx
  const pretty = prettyCode(ctx.code)
  let settings: StreamSettings | null = null
  let share: MyShare | null = null
  let members: TunnelMember[] = []
  let destroyed = false

  // ── sidebar: back · code · people ──
  const leaveBtn = h('button', { type: 'button', class: 'b-back', id: 'leave-btn', title: t('tunnel.leave'), onclick: () => actions.leave() }, icon('back'), h('span', null, t('tunnel.leaveShort')))
  const codeText = h('button', { type: 'button', class: 'b-code', id: 'room-code', 'data-code': ctx.code, title: t('tunnel.copyCode') }, pretty)
  const copyIcon = h('button', { type: 'button', class: 'b-copy', id: 'copy-btn', title: t('tunnel.copyCode'), 'aria-label': t('tunnel.copyCode') }, icon('copy'))
  const copied = h('span', { class: 'b-copied', 'aria-live': 'polite' })
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  const copy = () =>
    void copyText(pretty).then((ok) => {
      if (!ok) return
      setText(copied, t('tunnel.copied'))
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setText(copied, ''), 1500)
    })
  codeText.addEventListener('click', copy)
  copyIcon.addEventListener('click', copy)

  const list = h('div', { class: 'b-members', id: 'members', role: 'list' })
  const countEl = h('span', { id: 'member-count', hidden: true }, '1')
  const side = h(
    'aside',
    { class: 'b-side' },
    leaveBtn,
    h('div', { class: 'b-codebox' }, h('div', { class: 'b-code-row' }, codeText, copyIcon), copied),
    h('div', { class: 'b-side-scroll scroll' }, list),
    countEl,
    ctx.user,
  )

  // ── middle: streams ──
  const cards = h('div', { class: 'b-cards' })
  const emptyTitle = h('h2', null, t('tunnel.nobodyLive'))
  const emptyCopy = button(t('tunnel.copyCode'), { cls: 'b-btn b-secondary', icon: 'copy', onclick: () => copy() })
  const empty = h('div', { class: 'b-empty', id: 'empty-stage' }, h('div', { class: 'b-empty-ico' }, icon('monitor')), emptyTitle, emptyCopy)
  const busyLine = h('div', { class: 'b-busy', hidden: true, role: 'status', 'aria-live': 'polite' })

  // my stream (only while sharing)
  const timer = h('span', { class: 'b-dim num', id: 'live-timer' }, '00:00')
  const titleEl = h('b', { id: 'live-title' })
  const warn = h('div', { class: 'warnline', id: 'share-warn', role: 'status', 'aria-live': 'polite' })
  const viewerCount = h('span', { id: 'viewer-count' }, '0')
  const watchers = h('div', { class: 'watchers', id: 'watchers' })
  const resSeg = seg<ResolutionPref>('res-seg', t('tunnel.resolution'), RES, (v) => change({ resolution: v }))
  const fpsSeg = seg<FpsPref>('fps-seg', 'FPS', FPS.map((f) => [f, `${f}`] as const), (v) => change({ fps: v }))
  const contentSeg = seg<ContentMode>('content-seg', t('tunnel.picture'), CONTENT.map(([v, k]) => [v, t(k)] as const), (v) => change({ content: v }))
  const bitrate = h('input', { id: 'bitrate', type: 'range', class: 'range', min: 1, max: 60, step: 1, 'aria-label': t('tunnel.bitrate') })
  const bitrateOut = h('output', { for: 'bitrate' }, 'Auto')
  bitrate.addEventListener('input', () => setText(bitrateOut, labelKbps(sliderToKbps(Number(bitrate.value)))))
  bitrate.addEventListener('change', () => change({ bitrateKbps: sliderToKbps(Number(bitrate.value)) }))
  const lockInput = h('input', { type: 'checkbox', id: 'lock', role: 'switch' })
  lockInput.addEventListener('change', () => actions.setLocked(lockInput.checked))
  const viewersBtn = h('button', { type: 'button', class: 'b-eye', id: 'viewers-btn', title: t('tunnel.viewers'), 'aria-expanded': 'false', 'aria-controls': 'viewers-pop', onclick: () => openPop(viewersPop) }, icon('eye'), viewerCount)
  const mine = h('div', { class: 'b-mine', id: 'my-stream', hidden: true, 'aria-label': t('tunnel.yourStream') }, h('span', { class: 'b-live' }, 'LIVE'), titleEl, timer, viewersBtn)
  const viewersPop = h(
    'div',
    { class: 'b-pop b-pop-viewers', id: 'viewers-pop', hidden: true, role: 'dialog', 'aria-label': t('tunnel.viewers') },
    watchers,
    h('label', { class: 'switch b-lock', for: 'lock' }, lockInput, icon('lock'), h('span', null, t('tunnel.lock'))),
  )
  const requests = h('div', { class: 'b-requests', id: 'requests' })
  const stage = h('section', { class: 'b-stage' }, h('div', { class: 'b-stage-body scroll' }, busyLine, warn, requests, cards, empty))

  // ── bottom: share + settings ──
  const shareBtn = button(t('tunnel.share'), { id: 'share-btn', cls: 'b-dbtn b-share', icon: 'monitor', onclick: () => actions.share() })
  const testBtn = ctx.showTest ? button(t('tunnel.test'), { id: 'test-stream', cls: 'b-dbtn', icon: 'play', onclick: () => actions.shareTest() }) : null
  const switchBtn = button(t('tunnel.switch'), { id: 'switch-btn', cls: 'b-dbtn b-collapse', icon: 'swap', title: t('tunnel.switch'), onclick: () => actions.switchSource() })
  const stopBtn = button(t('tunnel.stop'), { id: 'stop-btn', cls: 'b-dbtn b-stop', icon: 'stop', onclick: () => actions.stopShare() })
  const qualityPop = h(
    'div',
    { class: 'b-pop', id: 'quality-pop', hidden: true, role: 'dialog', 'aria-label': t('tunnel.quality') },
    h('div', { class: 'b-pop-row' }, h('span', null, t('tunnel.resolution')), resSeg.el),
    h('div', { class: 'b-pop-row' }, h('span', null, 'FPS'), fpsSeg.el),
    h('div', { class: 'b-pop-row' }, h('span', null, t('tunnel.picture')), contentSeg.el),
    h('div', { class: 'b-pop-row' }, h('span', null, t('tunnel.bitrate')), h('div', { class: 'b-pop-rate' }, bitrate, bitrateOut)),
  )
  const qualityBtn = h('button', { type: 'button', class: 'btn b-dbtn b-collapse', id: 'quality-btn', title: t('tunnel.quality'), 'aria-expanded': 'false', 'aria-controls': 'quality-pop', onclick: () => openPop(qualityPop) }, icon('sliders'), h('span', null, t('tunnel.quality')))
  const pops: Array<[HTMLElement, HTMLElement]> = [
    [qualityPop, qualityBtn],
    [viewersPop, viewersBtn],
  ]
  /** Opens `pop` (or closes it when already open); null closes all. */
  function openPop(pop: HTMLElement | null): void {
    const target = pop && pop.hidden ? pop : null
    for (const [p, b] of pops) {
      setHidden(p, p !== target)
      b.setAttribute('aria-expanded', String(p === target))
    }
  }
  const onDocDown = (e: PointerEvent) => {
    if (pops.some(([p]) => !p.hidden) && !(e.target as HTMLElement).closest('.b-pop, #quality-btn, #viewers-btn')) openPop(null)
  }
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && pops.some(([p]) => !p.hidden)) {
      e.stopPropagation()
      openPop(null)
    }
  }
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onDocKey, true)
  const dockSep = h('span', { class: 'b-dock-sep', 'aria-hidden': 'true' })
  const dock = h('footer', { class: 'b-dock' }, h('div', { class: 'b-dock-wrap' }, qualityPop, viewersPop, h('div', { class: 'b-dock-inner' }, mine, shareBtn, testBtn, switchBtn, qualityBtn, dockSep, stopBtn)))

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
    resSeg.set(settings.resolution === 'native' ? 2160 : resolutionFromValue(String(settings.resolution)))
    fpsSeg.set(settings.fps)
    contentSeg.set(settings.content === 'detail' ? 'detail' : 'motion')
    bitrate.value = String(kbpsToSlider(settings.bitrateKbps))
    setText(bitrateOut, labelKbps(settings.bitrateKbps))
  }

  function memberItem(m: TunnelMember): HTMLElement {
    const live = m.live
    const el = h('div', { class: `b-member${live ? ' is-live' : ''}`, role: 'listitem', 'data-member-id': m.id, 'data-live': live ? 'true' : 'false' })
    el.append(
      avatar(m.name, m.id),
      h('div', { class: 'b-mtext' }, h('div', { class: 'b-nm' }, h('span', { class: 'b-nmtext' }, m.name), m.self ? h('span', { class: 'b-you' }, t('tunnel.you')) : null), live ? h('div', { class: 'b-st b-livetitle' }, live.title || t('tunnel.screen')) : null),
    )
    if (m.self) {
      if (live) el.append(h('span', { class: 'b-live' }, 'LIVE'))
    } else if (live) {
      el.append(button(t('tunnel.watch'), { cls: 'b-btn b-primary b-sm watch-btn', onclick: () => actions.watch(m.id) }))
      el.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('button')) actions.watch(m.id)
      })
    }
    return el
  }

  function card(m: TunnelMember): HTMLElement {
    const live = m.live!
    const watch = () => actions.watch(m.id)
    return h(
      'article',
      { class: 'b-card', 'data-card-id': m.id, onclick: watch },
      h('div', { class: 'b-preview' }, h('span', { class: 'b-live b-tl' }, 'LIVE'), h('div', { class: 'b-play' }, h('span', null, icon('play'), t('tunnel.watch')))),
      h(
        'div',
        { class: 'b-card-info' },
        avatar(m.name, m.id, 'b-lgav'),
        h('div', { class: 'b-card-text' }, h('div', { class: 'b-t1' }, m.name), h('div', { class: 'b-t2' }, live.title || t('tunnel.screen'), ' · ', spec(live), live.audio ? '' : t('tunnel.noAudio'))),
      ),
    )
  }

  function render(): void {
    clear(list)
    for (const m of [...members].sort((a, b) => Number(b.self) - Number(a.self))) list.append(memberItem(m))
    setText(countEl, String(members.length))
    const otherLive = members.filter((m) => m.live && !m.self)
    clear(cards)
    for (const m of otherLive) cards.append(card(m))
    setHidden(empty, otherLive.length > 0)
    const alone = members.filter((m) => !m.self).length === 0
    setText(emptyTitle, alone ? t('tunnel.alone') : share ? t('tunnel.nobodyElse') : t('tunnel.nobodyLive'))
    setHidden(emptyCopy, !alone)
    const sharing = share !== null
    setHidden(shareBtn, sharing)
    if (testBtn) setHidden(testBtn, sharing)
    setHidden(switchBtn, !sharing)
    setHidden(stopBtn, !sharing)
    setHidden(qualityBtn, !sharing)
    setHidden(dockSep, !sharing)
    if (!sharing) openPop(null)
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
        setText(titleEl, next.title || t('tunnel.screen'))
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
      clear(requests)
      const connected = viewers.filter((v) => v.state === 'connected').length
      setText(viewerCount, String(connected + relayed))
      for (const v of viewers) {
        const st = v.state
        const row = h('div', { class: 'w-row', 'data-viewer-id': v.id, 'data-state': st })
        const dot = h('span', { class: `dot ${st === 'connected' ? 'ok' : st === 'pending' ? 'warn' : 'idle'}` })
        row.append(h('div', { class: 'w-name' }, dot, h('span', null, v.name)))
        if (st === 'pending') {
          requests.append(
            h(
              'div',
              { class: 'b-request', 'data-request-id': v.id },
              avatar(v.name, v.id),
              h('span', { class: 'b-request-text' }, t('tunnel.request', { name: v.name })),
              button(t('tunnel.allow'), { cls: 'b-btn b-primary b-sm', onclick: () => actions.decide(v.id, true) }),
              button(t('tunnel.deny'), { cls: 'b-btn b-secondary b-sm', onclick: () => actions.decide(v.id, false) }),
            ),
          )
          row.hidden = true
        } else {
          const tx = v.tx
          const rx = v.rx
          const pic = tx && tx.height > 0 ? `${tx.height}p${Math.round(rx?.fps ?? tx.fps)}` : '…'
          row.append(
            h('span', { class: 'w-num' }, pic),
            h('span', { class: 'w-num' }, rx?.latencyMs != null ? ms(rx.latencyMs, true) : ms(tx?.rttMs ?? null)),
            // native path (docs/NATIVE-PATH.md): a small "nativ" next to the connection, same secondary text
            h('span', { class: 'w-num' }, `${tx ? connLabel(tx.connType) : '–'}${v.native ? ` · ${t('tunnel.native')}` : ''}`),
            h('button', { type: 'button', class: 'icon-btn w-kick', title: t('tunnel.kick'), 'aria-label': t('tunnel.kickName', { name: v.name }), onclick: () => actions.kick(v.id) }, icon('x')),
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
      document.removeEventListener('pointerdown', onDocDown, true)
      document.removeEventListener('keydown', onDocKey, true)
    },
  }
}

// Tunnel screen: code, member list (who is here, who is live), share button, and — while we share — a dock
// with our watchers and live quality controls. No setup screen: "Teilen" opens the picker directly.
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

  // ── head ──
  const copyHint = h('span', { class: 'hint' }, 'kopieren')
  const codeBtn = h('button', { type: 'button', class: 'code', id: 'room-code', 'data-code': ctx.code, title: 'Code kopieren' }, h('span', null, pretty), copyHint)
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  const flashCopied = () => {
    codeBtn.classList.add('copied')
    setText(copyHint, 'kopiert')
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      codeBtn.classList.remove('copied')
      setText(copyHint, 'kopieren')
    }, 1200)
  }
  codeBtn.addEventListener('click', () => void copyText(pretty).then((ok) => ok && flashCopied()))
  const inviteBtn = button('Einladung kopieren', { cls: 'text', id: 'invite-btn', onclick: () => void copyText(inviteText(ctx.code)).then((ok) => ok && flashCopied()) })

  const shareBtn = button('Teilen', { id: 'share-btn', icon: 'monitor', onclick: () => actions.share() })
  const testBtn = ctx.showTest ? button('Testbild', { id: 'test-stream', cls: 'text', onclick: () => actions.shareTest() }) : null
  const leaveBtn = button('Tunnel verlassen', { id: 'leave-btn', cls: 'text', onclick: () => actions.leave() })
  const head = h(
    'div',
    { class: 't-head' },
    h('div', { class: 't-code' }, h('span', { class: 'label' }, 'Tunnel-Code'), codeBtn),
    inviteBtn,
    h('span', { class: 'spacer' }),
    h('div', { class: 'actions' }, testBtn, shareBtn, leaveBtn),
  )

  // ── members ──
  const countEl = h('span', { id: 'member-count' }, '0')
  const list = h('div', { id: 'members', role: 'list' })
  const busyLine = h('div', { class: 'empty-line', hidden: true, role: 'status', 'aria-live': 'polite' })
  const emptyStage = h(
    'div',
    { class: 'stage-empty', id: 'empty-stage' },
    h('h2', null, 'Gerade teilt niemand.'),
    button('Bildschirm teilen', { id: 'share-big', cls: 'primary big', onclick: () => actions.share() }),
    h('div', { class: 'steps' }, h('span', null, 'Im Dialog:'), h('span', null, h('b', null, '1'), 'Fenster'), h('span', null, h('b', null, '2'), 'Spiel wählen'), h('span', null, h('b', null, '3'), '„App-Audio ebenfalls teilen“ an')),
  )
  const membersBox = h('section', { class: 'members scroll', 'aria-label': 'Im Tunnel' }, h('div', { class: 'label', style: 'margin:14px 0 6px' }, 'Im Tunnel ', countEl), list, busyLine, emptyStage)

  // ── dock (our stream) ──
  const timer = h('span', { class: 'timer', id: 'live-timer' }, '00:00')
  const titleEl = h('div', { class: 't2', id: 'live-title' })
  const switchBtn = button('Quelle wechseln', { id: 'switch-btn', onclick: () => actions.switchSource() })
  const stopBtn = button('Beenden', { id: 'stop-btn', cls: 'danger', onclick: () => actions.stopShare() })
  const warn = h('div', { class: 'warnline', id: 'share-warn', role: 'status', 'aria-live': 'polite' })
  const viewerCount = h('span', { id: 'viewer-count' }, '0')
  const watchers = h('div', { class: 'watchers', id: 'watchers' })
  const noWatchers = h('div', { class: 'faint', style: 'font-size:13px;height:30px;display:flex;align-items:center' }, 'Noch schaut niemand zu.')

  const fpsSeg = seg<FpsPref>('fps-seg', 'Bilder pro Sekunde', FPS.map((f) => [f, String(f)] as const), (v) => change({ fps: v }))
  const contentSeg = seg<ContentMode>('content-seg', 'Bildcharakter', CONTENT, (v) => change({ content: v }))
  const bitrate = h('input', { id: 'bitrate', type: 'range', class: 'range', min: 1, max: 60, step: 1, 'aria-label': 'Bitrate' })
  const bitrateOut = h('output', { for: 'bitrate' }, 'Auto')
  bitrate.addEventListener('input', () => setText(bitrateOut, labelKbps(sliderToKbps(Number(bitrate.value)))))
  bitrate.addEventListener('change', () => change({ bitrateKbps: sliderToKbps(Number(bitrate.value)) }))
  const lockInput = h('input', { type: 'checkbox', id: 'lock', role: 'switch' })
  lockInput.addEventListener('change', () => actions.setLocked(lockInput.checked))

  const dock = h(
    'section',
    { class: 'dock', id: 'my-stream', hidden: true, 'aria-label': 'Dein Stream' },
    h(
      'div',
      { class: 'dock-top' },
      h('div', { class: 'what' }, h('div', { class: 't1' }, h('span', { class: 'dot live' }), h('span', null, 'Du teilst'), timer), titleEl),
      h('span', { class: 'spacer' }),
      switchBtn,
      stopBtn,
    ),
    warn,
    h('div', { class: 'w-head label' }, h('span', null, 'Zuschauer ', viewerCount), h('span', { class: 'col' }, 'Bild'), h('span', { class: 'col' }, 'Latenz'), h('span', { class: 'col' }, 'Verbindung'), h('span', null)),
    noWatchers,
    watchers,
    h(
      'div',
      { class: 'dock-ctl' },
      h('div', { class: 'grp' }, h('span', { class: 'faint' }, 'FPS'), fpsSeg.el),
      h('div', { class: 'grp' }, contentSeg.el),
      h('div', { class: 'bitrate' }, h('span', { class: 'faint' }, 'Bitrate'), bitrate, bitrateOut),
      h('label', { class: 'switch', for: 'lock' }, lockInput, h('span', null, 'Keine neuen Zuschauer')),
    ),
  )

  const root = h('main', { class: 'tunnel', id: 'tunnel' }, head, membersBox, dock)

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

  function memberRow(m: TunnelMember): HTMLElement {
    const live = m.live
    const row = h('div', {
      class: `m-row${live && !m.self ? ' live' : ''}`,
      role: 'listitem',
      'data-member-id': m.id,
      'data-live': live ? 'true' : 'false',
    })
    const dot = h('span', { class: `dot ${live ? 'live' : m.self ? 'ok' : 'idle'}` })
    const name = h('div', { class: 'm-name' }, m.name, m.self ? h('span', { class: 'you' }, '  (du)') : null)
    const meta = h('div', { class: 'm-meta' })
    const end = h('div', { class: 'm-end' })
    if (live) {
      meta.append(h('span', { class: 'live-tag' }, 'LIVE'), h('span', { class: 'title' }, live.title || 'Bildschirm'), h('span', { class: 'spec' }, spec(live)))
      if (!live.audio) meta.append(h('span', { class: 'faint', title: 'Ohne Ton' }, icon('mute')))
      end.append(h('span', { class: 'spec' }, live.viewers === 1 ? '1 schaut' : `${live.viewers} schauen`))
      if (!m.self) {
        end.append(button('Ansehen', { cls: 'watch-btn', onclick: () => actions.watch(m.id) }))
        row.addEventListener('click', (e) => {
          if (!(e.target as HTMLElement).closest('button')) actions.watch(m.id)
        })
      }
    }
    row.append(dot, name, meta, end)
    return row
  }

  function renderMembers(): void {
    clear(list)
    for (const m of members) list.append(memberRow(m))
    setText(countEl, String(members.length))
    const anyLive = members.some((m) => m.live)
    setHidden(emptyStage, anyLive || share !== null)
    // One accent element per screen: the big share button owns it while nobody is live.
    setHidden(shareBtn, share !== null || !anyLive)
    if (testBtn) setHidden(testBtn, share !== null)
  }

  let tick: ReturnType<typeof setInterval> | null = null

  return {
    el: root,
    setMembers(next) {
      if (destroyed) return
      members = next
      renderMembers()
    },
    setShare(next, s) {
      if (destroyed) return
      share = next
      settings = { ...s }
      setHidden(dock, next === null)
      if (next) {
        setText(titleEl, `${next.title || 'Bildschirm'} · ${next.audio ? 'mit Ton' : 'ohne Ton'}`)
        setText(timer, duration(next.since))
        tick ??= setInterval(() => share && setText(timer, duration(share.since)), 1000)
        renderControls()
      } else if (tick) {
        clearInterval(tick)
        tick = null
      }
      renderMembers()
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
              button('Zulassen', { cls: 'primary', onclick: () => actions.decide(v.id, true) }),
              button('Ablehnen', { onclick: () => actions.decide(v.id, false) }),
            ),
          )
        } else {
          const tx = v.tx
          const rx = v.rx
          const pic = tx && tx.height > 0 ? `${tx.height}p${Math.round(rx?.fps ?? tx.fps)}` : st === 'connecting' ? 'verbindet…' : '–'
          const kids = rx && rx.descendants > 0 ? ` +${rx.descendants}` : ''
          row.append(
            h('span', { class: 'w-num' }, pic),
            h('span', { class: 'w-num' }, rx?.latencyMs != null ? ms(rx.latencyMs, true) : ms(tx?.rttMs ?? null)),
            h('span', { class: 'w-num' }, `${tx ? connLabel(tx.connType) : '–'}${kids}`),
            h('button', { type: 'button', class: 'icon-btn w-kick', title: 'Entfernen', 'aria-label': `${v.name} entfernen`, onclick: () => actions.kick(v.id) }, icon('x')),
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
      const big = emptyStage.querySelector('button')
      if (big) big.disabled = text !== null
    },
    destroy() {
      destroyed = true
      if (tick) clearInterval(tick)
      if (copyTimer) clearTimeout(copyTimer)
    },
  }
}

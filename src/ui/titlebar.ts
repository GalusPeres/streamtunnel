// Our own 40 px window strip (the native title bar is off: decorations=false). The empty area drags the
// window and double-click maximizes (Tauri's data-tauri-drag-region). Window buttons only exist inside Tauri.
import { closeWindow, isTauri, minimizeWindow, toggleMaximizeWindow, watchMaximized } from '../platform.ts'
import { h, icon } from './dom.ts'
import { LOGO_SVG } from './icons.ts'

const GLYPH = { min: '', max: '', restore: '', close: '' }

export interface TitleBar {
  readonly el: HTMLElement
  /** quiet text next to the wordmark (e.g. the tunnel code) */
  setExtra(text: string): void
  destroy(): void
}

/** Window buttons only (used by the watch overlay, which draws its own left side). */
export function windowButtons(): { el: HTMLElement; destroy(): void } {
  const tools = h('div', { class: 'tb-tools' })
  if (!isTauri()) return { el: tools, destroy() {} }
  const maxBtn = h('button', { type: 'button', class: 'tb-btn', 'aria-label': 'Maximieren', title: 'Maximieren', onclick: toggleMaximizeWindow }, GLYPH.max)
  tools.append(
    h('button', { type: 'button', class: 'tb-btn', 'aria-label': 'Minimieren', title: 'Minimieren', onclick: minimizeWindow }, GLYPH.min),
    maxBtn,
    h('button', { type: 'button', class: 'tb-btn close', 'aria-label': 'Schließen', title: 'Schließen', onclick: closeWindow }, GLYPH.close),
  )
  const off = watchMaximized((m) => {
    maxBtn.textContent = m ? GLYPH.restore : GLYPH.max
    const label = m ? 'Wiederherstellen' : 'Maximieren'
    maxBtn.title = label
    maxBtn.setAttribute('aria-label', label)
  })
  return { el: tools, destroy: off }
}

export function titleBar(opts: { onSettings?: () => void } = {}): TitleBar {
  const extra = h('span', { class: 'tb-extra', 'data-tauri-drag-region': true })
  const wordmark = h('span', { class: 'wordmark', 'data-tauri-drag-region': true }, 'STREAMTUNNEL')
  wordmark.insertAdjacentHTML('afterbegin', LOGO_SVG)
  const drag = h('div', { class: 'drag', 'data-tauri-drag-region': true }, wordmark, extra)
  const buttons = windowButtons()
  if (opts.onSettings) {
    buttons.el.prepend(h('button', { type: 'button', class: 'tb-btn', id: 'settings-btn', 'aria-label': 'Einstellungen', title: 'Einstellungen', onclick: opts.onSettings }, icon('sliders')))
  }
  const el = h('header', { class: 'titlebar' }, drag, buttons.el)
  return {
    el,
    setExtra(text) {
      if (extra.textContent !== text) extra.textContent = text
    },
    destroy: buttons.destroy,
  }
}

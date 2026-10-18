// Our own 40 px window strip (the native title bar is off: decorations=false). The empty area drags the
// window and double-click maximizes (Tauri's data-tauri-drag-region; Electron uses CSS -webkit-app-region).
// Window buttons only exist in the desktop shells (Tauri, Electron).
import { closeWindow, isElectron, isTauri, minimizeWindow, toggleMaximizeWindow, watchMaximized } from '../platform.ts'
import { h, icon } from './dom.ts'
import { LOGO_SVG } from './icons.ts'

const GLYPH = { min: '', max: '', restore: '', close: '' }
type GlyphName = keyof typeof GLYPH

// Segoe Fluent Icons only exist on Windows: Electron (Linux) draws the same four glyphs as inline SVG.
const SVG_PATH: Record<GlyphName, string> = {
  min: 'M0 5.5h10',
  max: 'M.5 .5h9v9h-9z',
  restore: 'M2.5 2.5h7v7h-7zM2.5 .5h7v2M.5 2.5v7h2',
  close: 'M.5 .5l9 9M9.5 .5l-9 9',
}
const SVG_NS = 'http://www.w3.org/2000/svg'

function setGlyph(btn: HTMLElement, name: GlyphName): void {
  if (!isElectron()) {
    btn.textContent = GLYPH[name]
    return
  }
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('width', '10')
  svg.setAttribute('height', '10')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'tb-glyph')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', SVG_PATH[name])
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1')
  svg.append(path)
  btn.replaceChildren(svg)
}

function glyphButton(name: GlyphName, label: string, onclick: () => void, cls = 'tb-btn'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, 'aria-label': label, title: label, onclick })
  setGlyph(b, name)
  return b
}

export interface TitleBar {
  readonly el: HTMLElement
  /** quiet text next to the wordmark (e.g. the tunnel code) */
  setExtra(text: string): void
  destroy(): void
}

/** Window buttons only (used by the watch overlay, which draws its own left side). */
export function windowButtons(): { el: HTMLElement; destroy(): void } {
  const tools = h('div', { class: 'tb-tools' })
  if (!isTauri() && !isElectron()) return { el: tools, destroy() {} }
  const maxBtn = glyphButton('max', 'Maximieren', toggleMaximizeWindow)
  tools.append(glyphButton('min', 'Minimieren', minimizeWindow), maxBtn, glyphButton('close', 'Schließen', closeWindow, 'tb-btn close'))
  const off = watchMaximized((m) => {
    setGlyph(maxBtn, m ? 'restore' : 'max')
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

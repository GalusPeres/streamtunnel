// Minimal DOM helpers. Untrusted strings (peer names etc.) are always inserted as text nodes.
import { ICONS } from './icons.ts'
import type { IconName } from './icons.ts'

/** A mounted screen. destroy() must release timers, global listeners and media references. */
export interface View {
  readonly el: HTMLElement
  destroy(): void
}

type Child = Node | string | number | null | undefined | false
type AttrValue = string | number | boolean | null | undefined
type Handler = (ev: never) => void
export type Attrs = Record<string, AttrValue | Handler>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const key in attrs) {
      const v = attrs[key]
      if (v === null || v === undefined || v === false) continue
      if (typeof v === 'function') {
        if (key.startsWith('on')) el.addEventListener(key.slice(2), v as EventListener)
        continue
      }
      if (key === 'class') el.className = String(v)
      else if (key === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v)
      else if (key === 'checked' && el instanceof HTMLInputElement) el.checked = v === true
      else el.setAttribute(key, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

const iconCache = new Map<IconName, SVGSVGElement>()

/** Inline SVG icon (decorative: aria-hidden). */
export function icon(name: IconName, cls = ''): SVGSVGElement {
  let tpl = iconCache.get(name)
  if (!tpl) {
    const t = document.createElement('template')
    t.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`
    tpl = t.content.firstElementChild as SVGSVGElement
    iconCache.set(name, tpl)
  }
  const svg = tpl.cloneNode(true) as SVGSVGElement
  if (cls) svg.classList.add(cls)
  return svg
}

/** Replaces all children with text (no-op when unchanged, avoids layout work every stats tick). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/** Icon + label button. */
export function button(label: string, opts: { icon?: IconName; cls?: string; id?: string; title?: string; onclick?: (e: MouseEvent) => void; type?: 'button' | 'submit' } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: opts.type ?? 'button', class: `btn ${opts.cls ?? ''}`.trim(), id: opts.id, title: opts.title, onclick: opts.onclick },
    opts.icon ? icon(opts.icon) : null,
    label ? h('span', null, label) : null,
  )
}

/** Square icon-only button with an accessible label. */
export function iconButton(name: IconName, label: string, opts: { cls?: string; id?: string; onclick?: (e: MouseEvent) => void } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `icon-btn ${opts.cls ?? ''}`.trim(), id: opts.id, title: label, 'aria-label': label, onclick: opts.onclick }, icon(name))
}

/** Labelled <select>; options as [value, label]. */
export function select<T extends string | number>(id: string, options: ReadonlyArray<readonly [T, string]>, value: T, onchange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { id, class: 'input' })
  for (const [v, label] of options) el.appendChild(h('option', { value: String(v) }, label))
  el.value = String(value)
  el.addEventListener('change', () => {
    const found = options.find(([v]) => String(v) === el.value)
    if (found) onchange(found[0])
  })
  return el
}

/** Switch-style checkbox with label. */
export function toggle(id: string, label: string, checked: boolean, onchange: (on: boolean) => void, hint?: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked })
  input.addEventListener('change', () => onchange(input.checked))
  return h('label', { class: 'switch', for: id, title: hint ?? null }, input, h('span', null, label))
}

/** Form field: label above control. */
export function field(label: string, forId: string, control: HTMLElement, extra?: Child): HTMLDivElement {
  return h('div', { class: 'field' }, h('label', { for: forId }, label), control, extra ?? null)
}

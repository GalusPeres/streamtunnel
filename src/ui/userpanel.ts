// Bottom-left user panel (same place on every screen): avatar · your name (editable) · settings.
import type { AppSettings } from '../settings.ts'
import { cleanName, randomGuestName } from '../settings.ts'
import { h, icon } from './dom.ts'

export function userPanel(settings: AppSettings, opts: { onName(name: string): void; onSettings(): void }): HTMLElement {
  const initial = h('span', { class: 'b-avatar b-me', 'aria-hidden': 'true' }, (settings.name.trim()[0] ?? '?').toUpperCase())
  const name = h('input', { id: 'name', class: 'b-name', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', value: settings.name, 'aria-label': 'Dein Name', title: 'Namen ändern' })
  const commit = () => {
    const v = cleanName(name.value) || randomGuestName()
    if (name.value !== v) name.value = v
    settings.name = v
    initial.textContent = (v.trim()[0] ?? '?').toUpperCase()
    opts.onName(v)
  }
  name.addEventListener('input', () => {
    const v = cleanName(name.value)
    if (v) {
      settings.name = v
      initial.textContent = v[0].toUpperCase()
      opts.onName(v)
    }
  })
  name.addEventListener('blur', commit)
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur()
  })
  const edit = h('button', { type: 'button', class: 'icon-btn', title: 'Namen ändern', 'aria-label': 'Namen ändern', onclick: () => { name.focus(); name.select() } }, icon('pencil'))
  const gear = h('button', { type: 'button', class: 'icon-btn', id: 'user-settings-btn', title: 'Einstellungen', 'aria-label': 'Einstellungen', onclick: () => opts.onSettings() }, icon('sliders'))
  return h('div', { class: 'b-user' }, initial, name, edit, gear)
}

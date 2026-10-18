// Bottom-left user panel (same place on every screen): avatar · your name (editable) · settings.
import type { AppSettings } from '../settings.ts'
import { cleanName, randomGuestName } from '../settings.ts'
import { h, icon } from './dom.ts'
import { avatarColor } from './format.ts'
import { t } from '../i18n.ts'

/** Dispatched on document after the name was changed outside the panel. */
export const NAME_EVENT = 'streamtunnel:name'

export function userPanel(settings: AppSettings, opts: { onName(name: string): void; onSettings(): void }): HTMLElement {
  const initial = h('span', { class: 'b-avatar b-me', 'aria-hidden': 'true' }, (settings.name.trim()[0] ?? '?').toUpperCase())
  const paint = (n: string) => {
    initial.textContent = (n.trim()[0] ?? '?').toUpperCase()
    initial.style.background = avatarColor(n)
  }
  paint(settings.name)
  const name = h('input', { id: 'name', class: 'b-name', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', value: settings.name, 'aria-label': t('set.name'), title: t('tunnel.rename') })
  const commit = () => {
    const v = cleanName(name.value) || randomGuestName()
    if (name.value !== v) name.value = v
    settings.name = v
    paint(v)
    opts.onName(v)
  }
  // typing updates the local name at once (so Create/Join use it); peers get it only on commit (blur / Enter)
  name.addEventListener('input', () => {
    const v = cleanName(name.value)
    if (!v) return
    settings.name = v
    paint(v)
  })
  // name changed elsewhere (settings dialog): show it, never write the old one back
  const sync = () => {
    if (!name.isConnected) return document.removeEventListener(NAME_EVENT, sync)
    if (document.activeElement !== name) name.value = settings.name
    paint(settings.name)
  }
  document.addEventListener(NAME_EVENT, sync)
  name.addEventListener('blur', commit)
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur()
  })
  const edit = h('button', { type: 'button', class: 'icon-btn', title: t('tunnel.rename'), 'aria-label': t('tunnel.rename'), onclick: () => { name.focus(); name.select() } }, icon('pencil'))
  const gear = h('button', { type: 'button', class: 'icon-btn', id: 'user-settings-btn', title: t('tunnel.settings'), 'aria-label': t('tunnel.settings'), onclick: () => opts.onSettings() }, icon('sliders'))
  return h('div', { class: 'b-user' }, initial, name, edit, gear)
}

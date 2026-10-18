// Source picker for the Electron (Linux/X11) build: Chromium's own getDisplayMedia dialog does not exist in
// Electron, so main.cjs sends the desktopCapturer list here. Wayland never gets here (system portal dialog).
import type { CaptureSource } from '../platform.ts'
import { electron } from '../platform.ts'
import { h } from './dom.ts'

let open: Promise<string | null> | null = null

function showPicker(list: CaptureSource[]): Promise<string | null> {
  if (open) return Promise.resolve(null)
  const sources = [...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1))
  open = new Promise<string | null>((resolve) => {
    let selected: string | null = sources.find((s) => s.kind === 'screen')?.id ?? sources[0]?.id ?? null
    const shareBtn = h('button', { type: 'button', class: 'btn primary', id: 'picker-share' }, 'Teilen')
    const cancelBtn = h('button', { type: 'button', class: 'btn', id: 'picker-cancel' }, 'Abbrechen')
    const grid = h('div', { class: 'pk-grid', role: 'listbox', 'aria-label': 'Quellen' })
    const items = new Map<string, HTMLButtonElement>()

    const render = (): void => {
      for (const [id, el] of items) el.setAttribute('aria-selected', String(id === selected))
      shareBtn.disabled = !selected
    }
    const finish = (id: string | null): void => {
      document.removeEventListener('keydown', onKey, true)
      root.remove()
      open = null
      resolve(id)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault()
        e.stopPropagation()
        finish(selected)
      }
    }

    for (const s of sources) {
      const thumb = s.thumbnail
        ? h('img', { class: 'pk-thumb', src: s.thumbnail, alt: '', draggable: 'false' })
        : h('div', { class: 'pk-thumb empty' }, s.kind === 'screen' ? 'Bildschirm' : 'Fenster')
      const item = h(
        'button',
        {
          type: 'button',
          class: 'pk-item',
          role: 'option',
          title: s.name,
          onclick: () => {
            selected = s.id
            render()
          },
          ondblclick: () => finish(s.id),
        },
        thumb,
        h('span', { class: 'pk-name' }, h('span', { class: 'pk-kind' }, s.kind === 'screen' ? 'Bildschirm' : 'Fenster'), s.name || s.id),
      )
      items.set(s.id, item)
      grid.append(item)
    }
    shareBtn.addEventListener('click', () => selected && finish(selected))
    cancelBtn.addEventListener('click', () => finish(null))

    const root = h(
      'div',
      { class: 'pk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quelle wählen' },
      h('div', { class: 'pk-panel' }, h('div', { class: 'pk-head' }, 'Was möchtest du teilen?'), grid, h('div', { class: 'pk-foot' }, cancelBtn, shareBtn)),
    )
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) finish(null)
    })
    document.addEventListener('keydown', onKey, true)
    document.body.append(root)
    render()
    queueMicrotask(() => (items.get(selected ?? '') ?? shareBtn).focus({ preventScroll: true }))
  })
  return open
}

/** Registers the overlay as the Electron source picker. No-op outside Electron. */
export function installSourcePicker(): void {
  electron()?.pickSource(showPicker)
}

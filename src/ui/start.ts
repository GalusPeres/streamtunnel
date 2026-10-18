// Start screen — deliberately obvious: one big "create" button, or join with a code, plus your name.
import type { AppSettings } from '../settings.ts'
import { cleanName, randomGuestName } from '../settings.ts'
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../core/code.ts'
import { button, h, setText } from './dom.ts'
import type { View } from './dom.ts'

export interface StartActions {
  join(code: string): void
  create(): void
  nameChanged(): void
}

export interface StartView extends View {
  setBusy(busy: boolean): void
  showError(message: string): void
}

/** Typing-time filter: uppercase, Crockford look-alikes mapped, everything else dropped. */
function filterCode(raw: string): string {
  let out = ''
  for (const ch of raw.toUpperCase()) {
    const c = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch
    if (CODE_ALPHABET.includes(c)) out += c
    if (out.length >= CODE_LENGTH) break
  }
  return out
}

export function mountStart(ctx: { settings: AppSettings; prefill?: string; actions: StartActions }): StartView {
  const { settings, actions } = ctx

  const createBtn = button('Neuen Tunnel erstellen', { id: 'create-btn', cls: 'primary huge', icon: 'share', onclick: () => actions.create() })

  const input = h('input', {
    id: 'join-code',
    class: 'input code-input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: 'XXXXX-XXXXX',
    'aria-label': 'Tunnel-Code',
    maxlength: 64,
  })
  const joinBtn = button('Beitreten', { id: 'join-btn', cls: 'big', onclick: () => submit() })
  const err = h('div', { class: 'err', role: 'status', 'aria-live': 'polite' })

  const name = h('input', { id: 'name', class: 'input', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', value: settings.name })
  name.addEventListener('input', () => {
    settings.name = cleanName(name.value)
    actions.nameChanged()
  })
  name.addEventListener('blur', () => {
    if (!cleanName(name.value)) {
      settings.name = randomGuestName()
      name.value = settings.name
      actions.nameChanged()
    }
  })

  const root = h(
    'main',
    { class: 'start2' },
    h(
      'div',
      { class: 'start2-col' },
      h('h1', null, 'StreamTunnel'),
      h('p', { class: 'lead' }, 'Bildschirm oder Spiel mit Freunden teilen – direkt, ohne Server.'),
      createBtn,
      h('div', { class: 'or' }, h('span', null, 'oder mit Code beitreten')),
      h('div', { class: 'join-row' }, input, joinBtn),
      err,
      h('label', { class: 'name-row', for: 'name' }, h('span', null, 'Dein Name'), name),
    ),
  )

  function formatted(v: string): string {
    return v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
  }

  function setValue(raw: string): void {
    const pasted = raw.replace(/[\s-]/g, '').length > CODE_LENGTH ? normalizeCode(raw) : null
    const code = pasted ?? filterCode(raw)
    const shown = formatted(code)
    if (input.value !== shown) input.value = shown
    setText(err, '')
    joinBtn.classList.toggle('primary', code.length === CODE_LENGTH)
  }

  input.addEventListener('input', () => setValue(input.value))
  input.addEventListener('paste', (e) => {
    const code = normalizeCode(e.clipboardData?.getData('text') ?? '')
    if (code) {
      e.preventDefault()
      setValue(code)
    }
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })

  function submit(): void {
    const code = normalizeCode(input.value)
    if (!code) {
      setText(err, 'Der Code hat 10 Zeichen, z. B. K7F3Q-X9MZD.')
      input.focus({ preventScroll: true })
      return
    }
    actions.join(code)
  }

  if (ctx.prefill) setValue(ctx.prefill)

  return {
    el: root,
    setBusy(busy) {
      joinBtn.disabled = busy
      createBtn.disabled = busy
    },
    showError(message) {
      setText(err, message)
    },
    destroy() {},
  }
}

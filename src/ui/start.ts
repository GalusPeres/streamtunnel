// Start screen: enter a tunnel code (10 visual cells backed by ONE real input) or create a new tunnel.
import type { AppSettings } from '../settings.ts'
import { cleanName, randomGuestName } from '../settings.ts'
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../core/code.ts'
import { button, h, icon, setText } from './dom.ts'
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

  const input = h('input', {
    id: 'join-code',
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-label': 'Tunnel-Code',
    maxlength: 64,
  })
  const cells: HTMLElement[] = []
  const codebox = h('label', { class: 'codebox' })
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (i === 5) codebox.append(h('span', { class: 'sep', 'aria-hidden': 'true' }))
    const c = h('span', { class: 'cell', 'aria-hidden': 'true' })
    cells.push(c)
    codebox.append(c)
  }
  codebox.append(input)

  const err = h('div', { class: 'err', role: 'status', 'aria-live': 'polite' })
  const joinBtn = button('Beitreten', { id: 'join-btn', cls: 'primary big', onclick: () => submit() })
  joinBtn.append(icon('arrow'))
  const createBtn = button('Tunnel erstellen', { id: 'create-btn', cls: 'primary big', onclick: () => actions.create() })

  const name = h('input', { id: 'name', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Dein Name', value: settings.name })
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

  // Two equal blocks side by side (stacked when narrow); label, headline and button sit on shared lines.
  const root = h(
    'main',
    { class: 'start' },
    h(
      'div',
      { class: 's-cols' },
      h(
        'section',
        { class: 's-col', 'aria-label': 'Beitreten' },
        h('div', { class: 's-block' }, h('h1', null, 'Beitreten'), h('p', { class: 's-sub' }, 'Code von deinen Freunden eingeben:'), h('div', { class: 's-mid' }, codebox, err), h('div', { class: 's-act' }, joinBtn)),
      ),
      h(
        'section',
        { class: 's-col', 'aria-label': 'Neuer Tunnel' },
        h(
          'div',
          { class: 's-block' },
          h('h1', null, 'Neuer Tunnel'),
          h('p', { class: 's-sub' }, 'Du bekommst einen Code für deine Freunde.'),
          h('div', { class: 's-mid' }),
          h('div', { class: 's-act' }, createBtn),
        ),
      ),
    ),
    h(
      'footer',
      { class: 's-foot' },
      h('label', { class: 'namefield' }, h('span', { class: 'label' }, 'Dein Name'), name, icon('pencil')),
      
    ),
  )

  function render(): void {
    const v = input.value
    const focused = document.activeElement === input
    for (let i = 0; i < CODE_LENGTH; i++) {
      setText(cells[i], v[i] ?? '')
      cells[i].classList.toggle('cur', focused && i === Math.min(v.length, CODE_LENGTH - 1))
    }
    joinBtn.disabled = v.length !== CODE_LENGTH
  }

  function setValue(raw: string): void {
    const pasted = raw.length > CODE_LENGTH ? normalizeCode(raw) : null
    const next = pasted ?? filterCode(raw)
    if (input.value !== next) input.value = next
    setText(err, '')
    render()
  }

  input.addEventListener('input', () => setValue(input.value))
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? ''
    const code = normalizeCode(text)
    if (code) {
      e.preventDefault()
      input.value = code
      setText(err, '')
      render()
    }
  })
  input.addEventListener('focus', render)
  input.addEventListener('blur', render)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })

  function submit(): void {
    const code = normalizeCode(input.value)
    if (!code) {
      setText(err, 'Der Code hat 10 Zeichen, z. B. K7F3Q-X9MZD.')
      codebox.classList.remove('bad')
      void codebox.offsetWidth
      codebox.classList.add('bad')
      return
    }
    actions.join(code)
  }

  if (ctx.prefill) setValue(ctx.prefill)
  render()
  queueMicrotask(() => input.focus({ preventScroll: true }))

  return {
    el: root,
    setBusy(busy) {
      joinBtn.disabled = busy || input.value.length !== CODE_LENGTH
      createBtn.disabled = busy
    },
    showError(message) {
      setText(err, message)
    },
    destroy() {},
  }
}

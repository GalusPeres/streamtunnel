// Start screen (design B "Sprachkanal"): recent tunnels on the left, then 1 · name, 2 · create OR join.
import type { AppSettings } from '../settings.ts'
import { cleanName, randomGuestName } from '../settings.ts'
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../core/code.ts'
import { button, h, icon, setText } from './dom.ts'
import type { View } from './dom.ts'
import { prettyCode } from './format.ts'

export interface StartActions {
  join(code: string): void
  create(): void
  nameChanged(): void
}

export interface StartView extends View {
  setBusy(busy: boolean): void
  showError(message: string): void
}

const RECENT_KEY = 'streamtunnel.recent.v1'

/** Remembers a tunnel code for the "Zuletzt besucht" list (max 6, newest first). */
export function rememberTunnel(code: string, names: string[] = []): void {
  try {
    const list = recentTunnels().filter((r) => r.code !== code)
    list.unshift({ code, names: names.slice(0, 4), at: Date.now() })
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)))
  } catch {
    /* storage unavailable */
  }
}

function recentTunnels(): { code: string; names: string[]; at: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((r): r is { code: string; names: string[]; at: number } => !!r && typeof r.code === 'string' && normalizeCode(r.code) === r.code)
      .map((r) => ({ code: r.code, names: Array.isArray(r.names) ? r.names.filter((n) => typeof n === 'string').slice(0, 4) : [], at: Number(r.at) || 0 }))
  } catch {
    return []
  }
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

  // ── sidebar: recent tunnels ──
  const recent = recentTunnels()
  const side = h(
    'aside',
    { class: 'b-side' },
    h('div', { class: 'b-sec' }, 'Zuletzt besucht'),
    recent.length
      ? h(
          'div',
          { class: 'b-recent' },
          ...recent.map((r) =>
            h(
              'button',
              { type: 'button', class: 'b-recent-item', onclick: () => actions.join(r.code) },
              h('span', { class: 'b-tico' }, icon('share')),
              h('span', { class: 'b-rtext' }, h('span', { class: 'b-rcode' }, prettyCode(r.code)), h('span', { class: 'b-rwho' }, r.names.join(', ') || 'Tunnel')),
              h('span', { class: 'b-go' }, 'Beitreten'),
            ),
          ),
        )
      : h('p', { class: 'b-side-empty' }, 'Hier erscheinen Tunnel, in denen du schon warst.'),
    h('div', { class: 'b-side-foot' }, 'Alles läuft direkt zwischen euch (Peer-to-Peer). Kein Konto, kein Server, der mitschaut.'),
  )

  // ── step 1: name ──
  const name = h('input', { id: 'name', class: 'b-field', type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', value: settings.name })
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

  // ── step 2: create or join ──
  const createBtn = button('Tunnel erstellen', { id: 'create-btn', cls: 'b-btn b-primary b-lg', icon: 'plus', onclick: () => actions.create() })
  const input = h('input', {
    id: 'join-code',
    class: 'b-codefield',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: 'XXXXX-XXXXX',
    'aria-label': 'Tunnel-Code',
    maxlength: 64,
  })
  const joinBtn = button('Beitreten', { id: 'join-btn', cls: 'b-btn b-secondary b-lg', icon: 'arrow', onclick: () => submit() })
  const err = h('div', { class: 'b-err', role: 'status', 'aria-live': 'polite' })

  const main = h(
    'section',
    { class: 'b-start' },
    h('div', null, h('h1', null, 'Tunnel öffnen'), h('p', { class: 'b-lead' }, 'Ein Tunnel ist ein privater Raum. Jeder darin kann teilen und zuschauen.')),
    h('div', { class: 'b-step' }, h('div', { class: 'b-step-h' }, h('span', { class: 'b-num' }, '1'), 'Dein Name'), name, h('div', { class: 'b-hint' }, 'So sehen dich die anderen im Tunnel.')),
    h(
      'div',
      { class: 'b-step' },
      h('div', { class: 'b-step-h' }, h('span', { class: 'b-num' }, '2'), 'Neu erstellen oder einem Tunnel beitreten'),
      h(
        'div',
        { class: 'b-choices' },
        h('div', { class: 'b-choice b-create' }, h('h2', null, 'Neuen Tunnel erstellen'), h('p', null, 'Du bekommst sofort einen Code, den du deinen Freunden schickst.'), h('div', { class: 'b-act' }, createBtn)),
        h('div', { class: 'b-or' }, 'ODER'),
        h('div', { class: 'b-choice' }, h('h2', null, 'Mit Code beitreten'), h('p', null, 'Gib den 10-stelligen Code ein, den du bekommen hast.'), h('div', { class: 'b-act' }, input, joinBtn), err),
      ),
    ),
    h('div', { class: 'b-tags' }, h('span', null, 'Bildschirm oder einzelnes Spielfenster'), h('span', null, 'mit Ton'), h('span', null, 'mehrere können gleichzeitig teilen')),
  )

  const root = h('main', { class: 'b-view' }, side, main)

  function setValue(raw: string): void {
    const pasted = raw.replace(/[\s-]/g, '').length > CODE_LENGTH ? normalizeCode(raw) : null
    const code = pasted ?? filterCode(raw)
    const shown = code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code
    if (input.value !== shown) input.value = shown
    setText(err, '')
    joinBtn.classList.toggle('b-primary', code.length === CODE_LENGTH)
    joinBtn.classList.toggle('b-secondary', code.length !== CODE_LENGTH)
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

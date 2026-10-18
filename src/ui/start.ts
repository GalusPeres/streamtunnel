// Start screen — two choices only: create a tunnel, or join with a code. Recent tunnels + your name on the left.
import type { AppSettings } from '../settings.ts'
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../core/code.ts'
import { button, h, icon, setText } from './dom.ts'
import type { View } from './dom.ts'
import { prettyCode } from './format.ts'
import { t } from '../i18n.ts'

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

/** Remembers a tunnel code for the recent list (max 6, newest first). */
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

function filterCode(raw: string): string {
  let out = ''
  for (const ch of raw.toUpperCase()) {
    const c = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch
    if (CODE_ALPHABET.includes(c)) out += c
    if (out.length >= CODE_LENGTH) break
  }
  return out
}

export function mountStart(ctx: { settings: AppSettings; prefill?: string; actions: StartActions; user: HTMLElement }): StartView {
  const { actions } = ctx

  const recent = recentTunnels()
  const side = h(
    'aside',
    { class: 'b-side' },
    recent.length ? h('div', { class: 'b-sec' }, t('start.recent')) : null,
    h(
      'div',
      { class: 'b-side-scroll scroll' },
      h(
        'div',
        { class: 'b-recent' },
        ...recent.map((r) =>
          h(
            'button',
            { type: 'button', class: 'b-recent-item', title: t('start.join'), onclick: () => actions.join(r.code) },
            h('span', { class: 'b-rtext' }, h('span', { class: 'b-rcode' }, prettyCode(r.code)), r.names.length ? h('span', { class: 'b-rwho' }, r.names.join(', ')) : null),
            icon('arrow'),
          ),
        ),
      ),
    ),
    ctx.user,
  )

  const createBtn = button(t('start.create'),{ id: 'create-btn', cls: 'b-btn b-primary b-xl', icon: 'plus', onclick: () => actions.create() })
  const input = h('input', {
    id: 'join-code',
    class: 'b-codefield',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: t('start.enterCode'),
    'aria-label': t('start.codeLabel'),
    maxlength: 64,
  })
  const joinBtn = button(t('start.join'), { id: 'join-btn', cls: 'b-btn b-secondary b-xl', onclick: () => submit() })
  const err = h('div', { class: 'b-err', role: 'status', 'aria-live': 'polite' })

  const main = h('section', { class: 'b-start2' }, h('div', { class: 'b-start2-col' }, createBtn, h('div', { class: 'b-or2' }, t('start.or')), h('div', { class: 'b-join' }, input, joinBtn), err))

  const root = h('main', { class: 'b-view' }, side, main)

  function setValue(raw: string): void {
    const pasted = raw.replace(/[\s-]/g, '').length > CODE_LENGTH ? normalizeCode(raw) : null
    const code = pasted ?? filterCode(raw)
    const shown = code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code
    if (input.value !== shown) input.value = shown
    setText(err, '')
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
      setText(err, t('start.badCode'))
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

// Toast notifications (aria-live). At most 4 visible; each auto-dismisses.
import { h, icon } from './dom.ts'
import { t } from '../i18n.ts'

export type ToastKind = 'info' | 'ok' | 'warn' | 'error'

const MAX_TOASTS = 4
let container: HTMLElement | null = null

function host(): HTMLElement {
  if (container && container.isConnected) return container
  container = h('div', { class: 'toasts', id: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions' })
  document.body.appendChild(container)
  return container
}

export function toast(message: string, kind: ToastKind = 'info', durationMs?: number): void {
  const root = host()
  // Same message already visible → don't stack duplicates.
  for (const el of Array.from(root.children)) {
    if ((el as HTMLElement).dataset.msg === message) return
  }
  while (root.children.length >= MAX_TOASTS) root.firstElementChild?.remove()
  const ic = kind === 'error' || kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info'
  let timer: ReturnType<typeof setTimeout> | null = null
  const close = () => {
    if (timer) clearTimeout(timer)
    timer = null
    el.remove()
  }
  const el = h(
    'div',
    { class: `toast toast-${kind}`, 'data-msg': message, role: kind === 'error' ? 'alert' : null },
    icon(ic),
    h('span', { class: 'toast-msg' }, message),
    h('button', { type: 'button', class: 'toast-x', 'aria-label': t('toast.close'), title: t('toast.close'), onclick: close }, icon('x')),
  )
  root.appendChild(el)
  const ms = durationMs ?? (kind === 'error' ? 9000 : kind === 'warn' ? 7000 : 4000)
  timer = setTimeout(close, ms)
}

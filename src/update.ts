// In-app updates (src-tauri/src/update.rs). The desktop app asks the newest GitHub release a few seconds after start
// and every 6 hours; a newer version shows a button in the title bar that downloads it, checks its signature,
// installs it without any wizard and restarts the app. The browser file only links to the download page.
import { isElectron, isTauri } from './platform.ts'

const FIRST_CHECK_MS = 5000
const CHECK_EVERY_MS = 6 * 3600_000
const LATEST_API = 'https://api.github.com/repos/GalusPeres/streamtunnel/releases/latest'
const RELEASES = 'https://github.com/GalusPeres/streamtunnel/releases/latest'

export interface UpdateOffer {
  version: string
  /** desktop app: downloads (progress in %), verifies, installs and restarts — resolves only if nothing restarted */
  install: ((onProgress: (pct: number) => void) => Promise<void>) | null
  /** the download page (browser file) */
  url: string
}

/** `a` is a newer "x.y.z" version than `b` (a leading "v" is ignored). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** The newer version, if there is one (null when up to date or offline). */
export async function checkForUpdate(): Promise<UpdateOffer | null> {
  if (isTauri()) {
    const core = await import('@tauri-apps/api/core')
    const info = await core.invoke<{ version: string } | null>('update_check')
    if (!info) return null
    return {
      version: info.version,
      url: RELEASES,
      install: async (onProgress) => {
        const progress = new core.Channel<number>()
        progress.onmessage = onProgress
        await core.invoke('update_install', { progress })
      },
    }
  }
  if (isElectron() || typeof __APP_VERSION__ !== 'string') return null
  const res = await fetch(LATEST_API, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) return null
  const rel = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
  if (typeof rel.tag_name !== 'string' || !isNewer(rel.tag_name, __APP_VERSION__)) return null
  return { version: rel.tag_name.replace(/^v/, ''), install: null, url: typeof rel.html_url === 'string' ? rel.html_url : RELEASES }
}

/** Checks now (after a short delay) and every 6 hours; `onOffer` gets each newer version found. */
export function watchForUpdates(onOffer: (offer: UpdateOffer) => void): void {
  let shown = ''
  const check = () => {
    checkForUpdate()
      .then((offer) => {
        if (offer && offer.version !== shown) {
          shown = offer.version
          onOffer(offer)
        }
      })
      .catch((err) => console.info('[update] check failed', err instanceof Error ? err.message : String(err)))
  }
  setTimeout(check, FIRST_CHECK_MS)
  setInterval(check, CHECK_EVERY_MS)
}

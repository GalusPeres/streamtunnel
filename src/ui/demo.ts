// ?demo=<start|tunnel|empty|sharing|watch> — static previews with fake data (design review without a network).
import type { AppSettings } from '../settings.ts'
import type { InboundStats, IViewerSession, TunnelMember, ViewerInfo } from '../types.ts'
import { makeTestStream } from '../rtc/capture.ts'
import { mountStart } from './start.ts'
import { mountTunnel } from './tunnelview.ts'
import { mountWatch } from './watch.ts'
import { userPanel } from './userpanel.ts'
import { openSettings } from './settingsheet.ts'

const noop = () => {}
const now = Date.now()

const MEMBERS: TunnelMember[] = [
  { id: 'lena', name: 'Lena', self: false, lastSeen: now, live: { title: 'Forza Horizon 6', width: 2560, height: 1440, fps: 60, audio: true, viewers: 2, since: now - 754_000 } },
  { id: 'max', name: 'Max', self: false, lastSeen: now, live: null },
  { id: 'me', name: 'Seb', self: true, lastSeen: now, live: null },
  { id: 'tom', name: 'Tom', self: false, lastSeen: now, live: null },
]

const VIEWERS: ViewerInfo[] = [
  { id: 'max', name: 'Max', state: 'connected', connectedAt: now, codec: 'AV1', tx: { bitrateKbps: 12800, fps: 60, width: 2560, height: 1440, codec: 'AV1', encoder: '', hw: true, encodeMs: 4, qualityLimitation: 'none', rttMs: 18, connType: 'p2p', availableKbps: 40000, audioKbps: 160 }, rx: { t: 'rx', fps: 60, latencyMs: 31, lossPct: 0, width: 2560, height: 1440, children: 1, descendants: 1, canRelay: true } },
  { id: 'tom', name: 'Tom', state: 'connected', connectedAt: now, codec: 'AV1', tx: { bitrateKbps: 12100, fps: 59, width: 2560, height: 1440, codec: 'AV1', encoder: '', hw: true, encodeMs: 4, qualityLimitation: 'none', rttMs: 9, connType: 'lan', availableKbps: 90000, audioKbps: 160 }, rx: { t: 'rx', fps: 59, latencyMs: 22, lossPct: 0, width: 2560, height: 1440, children: 0, descendants: 0, canRelay: true } },
  { id: 'nina', name: 'Nina', state: 'pending', connectedAt: null, codec: null, tx: null, rx: null },
]

const tunnelActions = { share: noop, shareTest: noop, stopShare: noop, switchSource: noop, watch: noop, leave: noop, kick: noop, decide: noop, updateSettings: noop, setLocked: noop }

export function mountDemo(which: string, content: HTMLElement, settings: AppSettings): void {
  if (which === 'start' || which.startsWith('settings')) {
    content.append(mountStart({ settings, user: userPanel(settings, { onName: noop, onSettings: noop }), actions: { join: noop, create: noop, nameChanged: noop } }).el)
    if (which.startsWith('settings')) {
      openSettings(settings)
      const tab = document.getElementById(`set-tab-${which.slice(8) || '0'}`)
      tab?.click()
    }
    return
  }
  if (which === 'watch') {
    const v = mountWatch({ name: 'Lena', title: 'Forza Horizon 6', settings, actions: { back: noop, retry: noop, openSettings: noop, settingsChanged: noop } })
    document.body.append(v.el)
    const fake = {
      origin: 'lena',
      onState: noop,
      onVideo: noop,
      onAudio: noop,
      onHostInfo: noop,
      onHostTx: noop,
      onStats: noop,
      start: noop,
      handleSignal: () => false,
      nudge: noop,
      originGone: noop,
      state: () => 'connected',
      setLatencyMode: noop,
      relayChildren: () => 0,
      stop: noop,
    } as unknown as IViewerSession
    v.attach(fake)
    const s = makeTestStream(60)
    fake.onState('connected')
    fake.onVideo(new MediaStream(s.getVideoTracks()))
    fake.onHostInfo({ hostName: 'Lena', settings: null, viewers: 2, codec: 'AV1', hops: 1, paused: false })
    const stats: InboundStats = { bitrateKbps: 12800, fps: 60, width: 2560, height: 1440, codec: 'AV1', decoder: '', hw: true, rttMs: 18, jitterBufferMs: 6, decodeMs: 1.2, lossPct: 0, framesDropped: 0, freezeCount: 0, connType: 'p2p', latencyMs: 27, audioKbps: 160 }
    fake.onStats(stats)
    if (new URLSearchParams(location.search).has('hud')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    return
  }
  const t = mountTunnel({ code: 'K7F3QX9MZD', showTest: false, user: userPanel(settings, { onName: noop, onSettings: noop }), actions: tunnelActions })
  content.append(t.el)
  if (which === 'empty') {
    t.setMembers(MEMBERS.map((m) => ({ ...m, live: null })))
  } else if (which === 'sharing') {
    const me = { ...MEMBERS[2], live: { title: 'Elden Ring Nightreign', width: 2560, height: 1440, fps: 60, audio: true, viewers: 3, since: now - 1_234_000 } }
    t.setMembers([me, MEMBERS[0], MEMBERS[1], MEMBERS[3]])
    t.setShare({ title: 'Elden Ring Nightreign', audio: true, since: now - 1_234_000, test: false }, settings.stream)
    t.setViewers(VIEWERS, 1)
  } else {
    t.setMembers(MEMBERS)
  }
}

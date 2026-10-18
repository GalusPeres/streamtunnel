// TunnelSession against a fake room: presence (periodic, on change, throttled), member list + expiry (frozen while
// offline), leave, and the §9.5 dispatch table. No WebRTC needed: peer connections are never created here
// (HostSession's createPeer fails quietly without RTCPeerConnection; watching only gets as far as sending joins).
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TunnelSession, parseLiveInfo } from '../src/rtc/tunnel.ts'
import { DEFAULT_NET, DEFAULT_SETTINGS } from '../src/rtc/defaults.ts'
import type { ISignalingRoom, LiveInfo, SignalBody, SignalingStatus, TunnelMember, ViewerState } from '../src/types.ts'
import { delay, waitFor } from './signaling-fakes.ts'

// Minimal MediaStream stand-in (HostSession builds separate video/audio streams from the tracks).
class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks(): MediaStreamTrack[] {
    return [...this.tracks]
  }
  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  addTrack(t: MediaStreamTrack): void {
    this.tracks.push(t)
  }
}
if (typeof (globalThis as Record<string, unknown>).MediaStream === 'undefined') {
  ;(globalThis as Record<string, unknown>).MediaStream = FakeMediaStream
}

function fakeTrack(kind: 'video' | 'audio'): MediaStreamTrack {
  return {
    kind,
    id: `${kind}-${Math.random().toString(16).slice(2)}`,
    readyState: 'live',
    enabled: true,
    contentHint: '',
    getSettings: () => (kind === 'video' ? { width: 1920, height: 1080, frameRate: 60 } : {}),
  } as unknown as MediaStreamTrack
}

class FakeRoom implements ISignalingRoom {
  readonly selfId = 'self00000001'
  readonly code = 'K7F3QX9MZD'
  onSignal: (from: string, body: SignalBody) => void = () => {}
  onStatus: (status: SignalingStatus) => void = () => {}
  connected = 1
  readonly sent: Array<{ body: SignalBody; to?: string; at: number }> = []
  send(body: SignalBody, to?: string): void {
    this.sent.push({ body, to, at: performance.now() })
  }
  status(): SignalingStatus {
    return { connected: this.connected, total: 1 }
  }
  close(): void {}
  deliver(from: string, body: SignalBody, broadcast?: boolean): void {
    ;(this.onSignal as (f: string, b: SignalBody, bc?: boolean) => void)(from, body, broadcast)
  }
  of(t: SignalBody['t']): Array<{ body: SignalBody; to?: string; at: number }> {
    return this.sent.filter((s) => s.body.t === t)
  }
}

const TIMING = { presenceMs: 150, presenceMinGapMs: 40, expireMs: 300, tickMs: 20 }
const LIVE: LiveInfo = { title: 'Forza', width: 2560, height: 1440, fps: 60, audio: true, viewers: 0, since: 1 }

function setup(timing: Partial<typeof TIMING> = {}): { room: FakeRoom; tunnel: TunnelSession; members: TunnelMember[][] } {
  const room = new FakeRoom()
  const tunnel = new TunnelSession({ room, name: 'Seb', net: DEFAULT_NET, timing: { ...TIMING, ...timing } })
  const members: TunnelMember[][] = []
  tunnel.onMembers = (m) => members.push(m)
  return { room, tunnel, members }
}

test('tunnel: presence on start, periodically and (throttled) on change; members sorted live first', async () => {
  const { room, tunnel, members } = setup()
  try {
    tunnel.start()
    assert.equal(room.onSignal === undefined, false)
    assert.deepEqual(room.of('presence')[0], { body: { t: 'presence', name: 'Seb', live: null }, to: undefined, at: room.of('presence')[0].at })
    assert.deepEqual(members.at(-1)?.map((m) => [m.name, m.self]), [['Seb', true]])

    // periodic
    await waitFor(() => room.of('presence').length >= 3, 1000, 'periodic presence')
    const p = room.of('presence')
    for (let i = 1; i < p.length; i++) assert.ok(p[i].at - p[i - 1].at >= TIMING.presenceMinGapMs - 5, 'min gap respected')

    // other members appear; a newcomer triggers our presence soon; list is sorted live first, then by name
    room.deliver('bbbb', { t: 'presence', name: 'Zoe', live: null }, true)
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    room.deliver('cccc', { t: 'presence', name: 'anna', live: null }, true)
    const list = tunnel.members()
    assert.deepEqual(list.map((m) => m.name), ['Ben', 'anna', 'Seb', 'Zoe'])
    assert.deepEqual(list[0].live, LIVE)
    assert.equal(list.find((m) => m.self)?.id, room.selfId)
    assert.deepEqual(members.at(-1)?.map((m) => m.id), list.map((m) => m.id))

    // name change → presence soon (throttled), not immediately twice
    const before = room.of('presence').length
    tunnel.setName('Sebastian')
    tunnel.setName('Sebastian') // no-op
    await waitFor(() => room.of('presence').some((s) => (s.body as { name: string }).name === 'Sebastian'), 500, 'name presence')
    assert.ok(room.of('presence').length - before <= 2)
  } finally {
    tunnel.leave()
  }
})

test('tunnel: expiry after silence (frozen while our signaling is offline), leave removes at once', async () => {
  const { room, tunnel } = setup()
  try {
    tunnel.start()
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: null }, true)
    room.deliver('bbbb', { t: 'presence', name: 'Zoe', live: null }, true)
    assert.equal(tunnel.members().length, 3)

    room.deliver('bbbb', { t: 'leave' }, true)
    assert.deepEqual(tunnel.members().map((m) => m.name).sort(), ['Ben', 'Seb'])

    // offline: nobody expires even after the expiry time
    room.connected = 0
    await delay(TIMING.expireMs + 150)
    assert.equal(tunnel.members().length, 2, 'no expiry while offline')
    // back online: the offline time does not count, then the silent member expires
    room.connected = 1
    await delay(60)
    assert.equal(tunnel.members().length, 2, 'offline time is not counted')
    await waitFor(() => tunnel.members().length === 1, 1000, 'expiry')
    assert.equal(tunnel.members()[0].self, true)

    // a member that keeps announcing stays
    for (let i = 0; i < 6; i++) {
      room.deliver('dddd', { t: 'presence', name: 'Dora', live: null }, true)
      await delay(100)
    }
    assert.ok(tunnel.members().some((m) => m.id === 'dddd'))
  } finally {
    tunnel.leave()
  }
})

test('tunnel: watch → joins addressed to the origin, nudge on presence, ended on stream-end bye', async () => {
  const { room, tunnel } = setup({ expireMs: 10_000 })
  try {
    tunnel.start()
    assert.throws(() => tunnel.watch(room.selfId), /eigenen/)
    assert.throws(() => tunnel.watch('nobody'), /teilt gerade nichts/)
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: null }, true)
    assert.throws(() => tunnel.watch('aaaa'), /teilt gerade nichts/)
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)

    const v = tunnel.watch('aaaa')
    const states: ViewerState[] = []
    v.onState = (s) => states.push(s) // assigned after watch(): still gets the initial 'waiting' (start is deferred)
    assert.equal(tunnel.watching(), v)
    assert.equal(v.origin, 'aaaa')
    await waitFor(() => room.of('join').length >= 1, 2000, 'first join')
    const j = room.of('join')[0]
    assert.equal(j.to, 'aaaa')
    assert.equal((j.body as { origin: string }).origin, 'aaaa')
    assert.deepEqual(states, ['waiting'])

    // presence from the origin while waiting → join right away (same jid), not only every 2 s
    await delay(550)
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    assert.equal(room.of('join').length, 2)
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    assert.equal(room.of('join').length, 2, 'nudges are throttled')
    assert.equal((room.of('join')[1].body as { jid: string }).jid, (j.body as { jid: string }).jid)

    // an addressed sid-less bye (a watcher leaving us) is not "stream ended"
    room.deliver('aaaa', { t: 'bye' }, false)
    assert.equal(v.state(), 'waiting')
    assert.ok(tunnel.members().find((m) => m.id === 'aaaa')?.live)

    // the origin's broadcast bye ends the watch and marks it not live
    room.deliver('aaaa', { t: 'bye' }, true)
    assert.equal(v.state(), 'ended')
    assert.deepEqual(states, ['waiting', 'ended'])
    assert.equal(tunnel.members().find((m) => m.id === 'aaaa')?.live, null)
    const joins = room.of('join').length
    await delay(100)
    assert.equal(room.of('join').length, joins, 'no joins after ended')

    // presence with live:null / leave also end a watch
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    const v2 = tunnel.watch('aaaa')
    await waitFor(() => v2.state() === 'waiting' && room.of('join').length > joins, 2000, 'second watch joins')
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: null }, true)
    assert.equal(v2.state(), 'ended')

    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    const v3 = tunnel.watch('aaaa')
    assert.equal(v2.state(), 'ended')
    await delay(10)
    room.deliver('aaaa', { t: 'leave' }, true)
    assert.equal(v3.state(), 'ended')
    assert.equal(tunnel.members().some((m) => m.id === 'aaaa'), false)
    tunnel.stopWatching()
    assert.equal(tunnel.watching(), null)
  } finally {
    tunnel.leave()
  }
})

test('tunnel: dispatch of joins — foreign origin → reject full (rate-limited), own origin while not sharing → silent', async () => {
  const { room, tunnel } = setup()
  try {
    tunnel.start()
    room.deliver('xxxx', { t: 'join', jid: 'j1', origin: 'someone', name: 'X', dec: [], relay: true }, false)
    assert.deepEqual(room.of('reject').map((r) => [r.to, r.body]), [['xxxx', { t: 'reject', jid: 'j1', reason: 'full' }]])
    room.deliver('xxxx', { t: 'join', jid: 'j2', origin: room.selfId, name: 'X', dec: [], relay: true }, false)
    assert.equal(room.of('reject').length, 1, 'no reply for our own origin while not sharing')
    for (let i = 0; i < 20; i++) room.deliver('yyyy', { t: 'join', jid: `f${i}`, origin: 'someone', name: 'Y', dec: [], relay: true }, false)
    assert.ok(room.of('reject').length <= 5, `rejects are rate-limited (${room.of('reject').length})`)
    // garbage never throws
    room.deliver('zzzz', { t: 'join' } as unknown as SignalBody, false)
    room.deliver('zzzz', null as unknown as SignalBody)
    room.deliver('zzzz', { t: 'answer', sid: 's', sdp: 'x' }, false)
  } finally {
    tunnel.leave()
  }
})

test('tunnel: share → live presence (title, size, viewers), stopSharing → bye + live:null, leave', async () => {
  const { room, tunnel } = setup()
  const notices: string[] = []
  tunnel.onNotice = (m) => notices.push(m)
  try {
    tunnel.start()
    const stream = new MediaStream([fakeTrack('video'), fakeTrack('audio')])
    const host = tunnel.share(stream, DEFAULT_SETTINGS, 'Forza Horizon 6', { maxDirect: 2 })
    assert.equal(tunnel.sharing(), host)
    assert.equal(host.origin, room.selfId)
    assert.throws(() => tunnel.share(stream, DEFAULT_SETTINGS, 'again'), /teilst bereits/)
    await waitFor(() => room.of('presence').some((p) => (p.body as { live: unknown }).live !== null), 500, 'live presence')
    const live = (room.of('presence').find((p) => (p.body as { live: unknown }).live !== null)!.body as { live: LiveInfo }).live
    assert.equal(live.title, 'Forza Horizon 6')
    assert.equal(live.width, 1920)
    assert.equal(live.height, 1080)
    assert.equal(live.fps, 60)
    assert.equal(live.audio, true)
    assert.equal(live.viewers, 0)
    assert.ok(live.since > 0)
    assert.deepEqual(tunnel.members()[0].live?.title, 'Forza Horizon 6')

    // a join for our stream goes to the sharing session (no reject from the tunnel)
    room.deliver('wwww', { t: 'join', jid: 'j1', origin: room.selfId, name: 'W', dec: [], relay: true }, false)
    assert.equal(room.of('reject').length, 0)

    tunnel.setLiveTitle('Bildschirm')
    await waitFor(() => room.of('presence').some((p) => (p.body as { live: LiveInfo | null }).live?.title === 'Bildschirm'), 500, 'title presence')

    tunnel.stopSharing()
    assert.equal(tunnel.sharing(), null)
    assert.ok(room.of('bye').some((b) => b.to === undefined && !('sid' in b.body)), 'broadcast sid-less bye')
    await waitFor(() => (room.of('presence').at(-1)!.body as { live: unknown }).live === null, 500, 'presence live:null')

    tunnel.leave()
    assert.equal(room.of('leave').length, 1)
    assert.equal(room.of('leave')[0].to, undefined)
    const sent = room.sent.length
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    await delay(TIMING.presenceMs + 50)
    assert.equal(room.sent.length, sent, 'silent after leave')
    assert.throws(() => tunnel.watch('aaaa'), /verlassen/)
    assert.deepEqual(notices, [])
  } finally {
    tunnel.leave()
  }
})

test('parseLiveInfo: validates untrusted presence payloads', () => {
  assert.equal(parseLiveInfo(null), null)
  assert.equal(parseLiveInfo('x'), null)
  assert.equal(parseLiveInfo([]), null)
  const l = parseLiveInfo({ title: 'a\u0000b'.repeat(50), width: 1e9, height: -5, fps: 'x', audio: 'yes', viewers: 1e300, since: Number.NaN })
  assert.ok(l)
  assert.equal(l.title.length, 80)
  assert.ok(!l.title.includes('\u0000'))
  assert.equal(l.width, 16_384)
  assert.equal(l.height, 0)
  assert.equal(l.fps, 0)
  assert.equal(l.audio, false)
  assert.equal(l.viewers, 10_000)
  assert.equal(l.since, 0)
})

test('tunnel: the watched origin expires like any member → watch ended', async () => {
  const { room, tunnel } = setup()
  try {
    tunnel.start()
    room.deliver('aaaa', { t: 'presence', name: 'Ben', live: LIVE }, true)
    const v = tunnel.watch('aaaa')
    await waitFor(() => room.of('join').length >= 1, 2000, 'join')
    await waitFor(() => v.state() === 'ended', 2000, 'ended after expiry')
    assert.equal(tunnel.members().length, 1)
  } finally {
    tunnel.leave()
  }
})

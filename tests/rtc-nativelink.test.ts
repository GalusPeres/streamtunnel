// Native path, page side (docs/NATIVE-PATH.md): wire validation of the 'nv' signaling fields, codec choice, the
// Channel message layout shared with src-tauri/src/native_media.rs, the LAN rate vectors shared with st-media's
// rate.rs, the watcher's decisions (native or WebRTC, what 'no' / a closed link mean), and the NativeWatch /
// WatchSwitch / NativeShare flows through a TunnelSession against a fake room and a fake Rust side (no Tauri,
// no WebCodecs: no video is decoded here — tests/e2e/native-decode.mjs does that in headless Edge). Run: npm test
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { NV_VIDEO_HEADER, WatchSwitch, chooseNvCodec, fallbackMessage, isNvKey, isNvLinkId, nvClosedAction, nvMaxHeight, nvNoAction, nvSourceOf, nvVersionsMatch, nvWatchPlan, parseNvCandidates, parseNvLive, parseNvMessage, parseNvViewerCaps, setNativeBackend } from '../src/rtc/nativelink.ts'
import type { NativeBackend } from '../src/rtc/nativelink.ts'
import type { HostSession } from '../src/rtc/host.ts'
import { TunnelSession, parseLiveInfo } from '../src/rtc/tunnel.ts'
import { DEFAULT_NET, DEFAULT_SETTINGS, effectiveBitrateKbps } from '../src/rtc/defaults.ts'
import { nativeLine } from '../src/ui/format.ts'
import { hevcPictureSize } from '../src/rtc/nativeplayer.ts'
import { setLang } from '../src/i18n.ts'
import type { CtlMessage, InboundStats, ISignalingRoom, LiveInfo, NvCodec, NvViewerCaps, SignalBody, SignalingStatus, ViewerState } from '../src/types.ts'
import { delay, waitFor } from './signaling-fakes.ts'

test('parseNvLive accepts a valid field and rejects garbage', () => {
  assert.deepEqual(parseNvLive({ v: 1, min: 1, codecs: ['hevc', 'h264', 'hevc', 'av1'] }), { v: 1, min: 1, codecs: ['hevc', 'h264'] })
  assert.equal(parseNvLive({ v: 1, min: 2, codecs: ['h264'] }), null)
  assert.equal(parseNvLive({ v: 1, min: 1, codecs: [] }), null)
  assert.equal(parseNvLive('x'), null)
  assert.equal(parseNvLive(null), null)
})

test('parseLiveInfo keeps nv only when valid', () => {
  const base = { title: 'Spiel', width: 2560, height: 1440, fps: 60, audio: true, viewers: 0, since: 1 }
  assert.deepEqual(parseLiveInfo({ ...base, nv: { v: 1, min: 1, codecs: ['h264'] } })?.nv, { v: 1, min: 1, codecs: ['h264'] })
  assert.equal('nv' in (parseLiveInfo({ ...base, nv: { v: 'x' } }) ?? {}), false)
  assert.equal('nv' in (parseLiveInfo(base) ?? {}), false)
})

test('parseNvViewerCaps', () => {
  assert.deepEqual(parseNvViewerCaps({ v: 1, min: 1, dec: ['h264'], rfi: 'yes', audio: true }), { v: 1, min: 1, dec: ['h264'], rfi: false, audio: true })
  assert.equal(parseNvViewerCaps({ v: 1, min: 1, dec: [] }), null)
})

test('parseNvCandidates validates addresses, kinds and the cap', () => {
  const ok = parseNvCandidates([
    { a: '192.168.1.20:50123', k: 'host' },
    { a: '[2001:db8::1]:4000', k: 'srflx' },
    { a: '192.168.1.20:50123', k: 'host' },
    { a: '192.168.1.20:0', k: 'host' },
    { a: '192.168.1.20:70000', k: 'host' },
    { a: 'example.org:5', k: 'host' },
    { a: '1.2.3.4:5', k: 'relay' },
    'junk',
  ])
  assert.deepEqual(ok, [
    { a: '192.168.1.20:50123', k: 'host' },
    { a: '[2001:db8::1]:4000', k: 'srflx' },
  ])
  const many = Array.from({ length: 40 }, (_, i) => ({ a: `10.0.0.${i + 1}:1000`, k: 'host' }))
  assert.equal(parseNvCandidates(many).length, 16)
  assert.deepEqual(parseNvCandidates('x'), [])
})

test('keys, link ids, versions, codec choice', () => {
  assert.equal(isNvKey('ab'.repeat(32)), true)
  assert.equal(isNvKey('AB'.repeat(32)), false)
  assert.equal(isNvKey('ab'.repeat(31)), false)
  assert.equal(isNvLinkId(1), true)
  assert.equal(isNvLinkId(0), false)
  assert.equal(isNvLinkId(2 ** 32), false)
  assert.equal(nvVersionsMatch({ v: 2, min: 1 }, { v: 1, min: 1 }), true)
  assert.equal(nvVersionsMatch({ v: 3, min: 3 }, { v: 2, min: 1 }), false)
  assert.equal(chooseNvCodec(['hevc', 'h264'], ['hevc', 'h264']), 'hevc')
  assert.equal(chooseNvCodec(['hevc', 'h264'], ['h264']), 'h264')
  assert.equal(chooseNvCodec(['hevc'], ['h264']), null)
  // the sharer's codec setting: H.264 forces it, everything else (AV1 / VP9 do not exist here) keeps HEVC first
  assert.equal(chooseNvCodec(['hevc', 'h264'], ['hevc', 'h264'], 'H264'), 'h264')
  assert.equal(chooseNvCodec(['hevc', 'h264'], ['hevc', 'h264'], 'HEVC'), 'hevc')
  assert.equal(chooseNvCodec(['hevc', 'h264'], ['hevc', 'h264'], 'AV1'), 'hevc')
  assert.equal(chooseNvCodec(['hevc'], ['hevc'], 'H264'), null)
})

test('parseNvMessage reads the video and audio layout of native_media.rs', () => {
  const data = [0, 0, 0, 1, 0x40]
  const buf = new ArrayBuffer(NV_VIDEO_HEADER + data.length)
  const d = new DataView(buf)
  d.setUint8(0, 1)
  d.setUint8(1, 0b101)
  d.setUint8(2, 2)
  d.setUint32(4, 7, true)
  d.setBigUint64(8, 1_000_000n, true)
  d.setUint32(16, 12_345, true)
  d.setUint32(20, 3_000, true)
  d.setBigUint64(24, 5n, true)
  new Uint8Array(buf, NV_VIDEO_HEADER).set(data)
  const m = parseNvMessage(buf)
  assert.ok(m && 'video' in m)
  assert.deepEqual({ ...m.video, data: [...m.video.data] }, {
    key: true,
    recovered: false,
    afterLoss: true,
    codec: 'hevc',
    frameId: 7,
    ptsUs: 1_000_000,
    ageUs: 12_345,
    senderLatencyUs: 3_000,
    sentEpochUs: 5,
    data,
  })

  const abuf = new ArrayBuffer(16 + 960 * 4)
  const a = new DataView(abuf)
  a.setUint8(0, 2)
  a.setUint8(1, 2)
  a.setUint8(2, 1)
  a.setUint32(4, 9, true)
  a.setInt16(16, -1, true)
  const am = parseNvMessage(abuf)
  assert.ok(am && 'audio' in am)
  assert.equal(am.audio.seq, 9)
  assert.equal(am.audio.concealed, 1)
  assert.equal(am.audio.pcm.length, 1920)
  assert.equal(am.audio.pcm[0], -1)

  assert.equal(parseNvMessage(new ArrayBuffer(3)), null)
  const bad = new ArrayBuffer(NV_VIDEO_HEADER + 1)
  new DataView(bad).setUint8(0, 1)
  assert.equal(parseNvMessage(bad), null) // codec 0
})

test('hevcPictureSize: the picture size from an HEVC SPS (WebCodecs needs it in the HEVC config)', () => {
  const sps = (hex: string): Uint8Array => Uint8Array.from([0, 0, 0, 1, ...(hex.match(/../g) ?? []).map((x) => parseInt(x, 16))])
  // NVENC 2560x1440 (latency_win.rs), no conformance window
  assert.deepEqual(hevcPictureSize(sps('420101216000000300900000030000030096a001402005a1659b4a421191bd50c05a80808082000003000200000300785f1c2d')), { width: 2560, height: 1440 })
  // x265 1918x1078 coded as 1920x1080: conformance window in chroma samples, 4:2:0 and 4:4:4
  assert.deepEqual(hevcPictureSize(sps('420101016000000300900000030000030078a003c08010e75596566924caf0168080000003008000000f04')), { width: 1918, height: 1078 })
  assert.deepEqual(hevcPictureSize(sps('4201010408000003009e0800000300007890007810021ceef2cacd24995e02dc08080010000003001000000301e080')), { width: 1918, height: 1078 })
  // the committed NVENC fixture: VPS, SPS, PPS, IDR in one access unit
  const fixture = readFileSync(new URL('../src-tauri/st-media/tests/fixtures/pattern_720p30.hevc', import.meta.url))
  assert.deepEqual(hevcPictureSize(new Uint8Array(fixture.buffer, fixture.byteOffset, 4096)), { width: 1280, height: 720 })
  // no SPS, a cut SPS
  assert.equal(hevcPictureSize(sps('40010c01ffff016000000300900000030000030078959809')), null)
  assert.equal(hevcPictureSize(sps('4201012160000003009000')), null)
})

test('LAN rate vectors match st-media rate.rs (lan_bitrate_kbps)', () => {
  const s = { ...DEFAULT_SETTINGS, bitrateKbps: 0 }
  const vectors: Array<[number, number, number, 'H264' | 'AV1', number]> = [
    [1920, 1080, 60, 'AV1', 20_000],
    [1920, 1080, 60, 'H264', 30_000],
    [2560, 1440, 60, 'AV1', 35_600],
    [2560, 1440, 60, 'H264', 53_300],
    [2560, 1440, 120, 'AV1', 57_800],
    [3840, 2160, 60, 'AV1', 80_000],
    [3840, 2160, 60, 'H264', 100_000],
    [1280, 720, 30, 'AV1', 5_500],
    [640, 360, 30, 'H264', 3_000],
  ]
  // HEVC uses the same factor as AV1 (1.0) in the LAN model
  for (const [w, h, fps, codec, kbps] of vectors) assert.equal(effectiveBitrateKbps(s, codec, w, h, fps, true), kbps, `${w}x${h}@${fps} ${codec}`)
})

// ───────────────────────── decisions (pure) ─────────────────────────

test('nv decisions: what a watcher does with no / closed, when it tries native at all', () => {
  for (const r of ['unavailable', 'busy', 'full']) assert.deepEqual(nvNoAction(r), { fallback: true }, r)
  assert.deepEqual(nvNoAction('denied'), { state: 'rejected', detail: 'denied' })
  assert.deepEqual(nvNoAction('locked'), { state: 'rejected', detail: 'locked' })
  assert.deepEqual(nvNoAction('kicked'), { state: 'kicked', detail: 'kicked' })
  assert.equal(nvNoAction('whatever'), null)

  assert.equal(nvClosedAction('closed', false), null, 'our own close')
  assert.equal(nvClosedAction('kicked', false), 'kicked')
  assert.equal(nvClosedAction('ended', true), 'ended')
  assert.equal(nvClosedAction('bye', false), 'retry')
  assert.equal(nvClosedAction('timeout', false), 'retry')
  assert.equal(nvClosedAction('timeout', true), 'fallback')

  const live = { v: 1, min: 1, codecs: ['hevc', 'h264'] as NvCodec[] }
  const caps = (dec: NvCodec[], v = 1, min = 1): NvViewerCaps => ({ v, min, dec, rfi: false, audio: true })
  assert.equal(nvWatchPlan(null, live), 'webrtc')
  assert.equal(nvWatchPlan(caps(['h264']), live), 'native')
  assert.equal(nvWatchPlan(caps(['h264']), { ...live, codecs: ['hevc'] }), 'webrtc', 'no common codec')
  assert.equal(nvWatchPlan(caps(['hevc'], 3, 3), live), 'webrtc', 'versions do not match')

  assert.equal(nvMaxHeight({ ...DEFAULT_SETTINGS, resolution: 'native' }), 0)
  assert.equal(nvMaxHeight({ ...DEFAULT_SETTINGS, resolution: 1440 }), 1440)
})

test('nvSourceOf: only window / screen tracks can be captured natively', () => {
  assert.deepEqual(nvSourceOf(streamOf('window:4242:0')), { source: 'window:4242:0', width: 1920, height: 1080 })
  assert.deepEqual(nvSourceOf(streamOf('screen:1:0'))?.source, 'screen:1:0')
  assert.equal(nvSourceOf(streamOf('web-contents-media-stream://1:2')), null)
  assert.equal(nvSourceOf(streamOf('')), null)
  assert.equal(nvSourceOf(streamOf('window:1:0', 'ended')), null)
  assert.equal(nvSourceOf(new MediaStream([])), null)
})

test('stats line of the native path (German and English)', () => {
  const s: InboundStats = {
    bitrateKbps: 36_000, fps: 60, width: 2560, height: 1440, codec: 'HEVC', decoder: '', hw: true, rttMs: 0.6, jitterBufferMs: 0,
    decodeMs: 2, lossPct: 0, framesDropped: 0, freezeCount: 0, connType: 'lan', latencyMs: 20, audioKbps: 1536, transport: 'native',
  }
  const tx = { t: 'tx', encodeMs: 3, encoder: 'NVENC', hw: true, kbps: 36_000, upstreamLatencyMs: 0 } as const
  setLang('de')
  assert.equal(nativeLine(s, tx), 'Nativ · HEVC · NVENC · 36 Mbit/s · RTT <1 ms')
  assert.equal(nativeLine({ ...s, codec: 'H264', bitrateKbps: 8_500, rttMs: 1.4 }, tx), 'Nativ · H.264 · NVENC · 8,5 Mbit/s · RTT 1 ms')
  setLang('en')
  assert.equal(nativeLine({ ...s, rttMs: null }, null), 'Native · HEVC · – · 36 Mbit/s · RTT – ms')
  setLang('de')
})

// ───────────────────────── flows against a fake room + fake Rust side ─────────────────────────

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

function videoTrack(deviceId: string, readyState = 'live'): MediaStreamTrack {
  return {
    kind: 'video',
    id: `v-${Math.random().toString(16).slice(2)}`,
    readyState,
    enabled: true,
    contentHint: '',
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60, deviceId }),
  } as unknown as MediaStreamTrack
}

function streamOf(deviceId: string, readyState = 'live'): MediaStream {
  return new MediaStream([videoTrack(deviceId, readyState)])
}

type Sent = { body: SignalBody; to?: string }

class FakeRoom implements ISignalingRoom {
  readonly selfId = 'self00000001'
  readonly code = 'K7F3QX9MZD'
  onSignal: (from: string, body: SignalBody) => void = () => {}
  onStatus: (status: SignalingStatus) => void = () => {}
  readonly sent: Sent[] = []
  send(body: SignalBody, to?: string): void {
    this.sent.push({ body, to })
  }
  status(): SignalingStatus {
    return { connected: 1, total: 1 }
  }
  close(): void {}
  deliver(from: string, body: SignalBody, broadcast = false): void {
    ;(this.onSignal as (f: string, b: SignalBody, bc?: boolean) => void)(from, body, broadcast)
  }
  of(t: SignalBody['t']): Sent[] {
    return this.sent.filter((s) => s.body.t === t)
  }
  /** 'nv' messages of one kind */
  nv<K extends 'join' | 'offer' | 'wait' | 'no'>(k: K): Array<{ body: Extract<SignalBody, { t: 'nv'; k: K }>; to?: string }> {
    return this.sent.filter((s) => s.body.t === 'nv' && s.body.k === k) as Array<{ body: Extract<SignalBody, { t: 'nv'; k: K }>; to?: string }>
  }
}

/** The Rust side: records every command, hands out link ids, lets the test emit link events. */
class FakeBackend implements NativeBackend {
  readonly calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  readonly links = new Map<number, (m: unknown) => void>()
  shareEvents: ((m: unknown) => void) | null = null
  shareCodecs: NvCodec[] | null = ['hevc', 'h264']
  watchCaps: NvViewerCaps | null = { v: 1, min: 1, dec: ['h264'], rfi: false, audio: false }
  private next = 100

  async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ cmd, args })
    let r: unknown = null
    if (cmd === 'nm_caps') r = { v: 1, min: 1, share: this.shareCodecs ? { codecs: this.shareCodecs, gpu: 'Fake RTX' } : null, watch: true }
    else if (cmd === 'nm_link_open') {
      const link = this.next++
      this.links.set(link, args.events as (m: unknown) => void)
      r = { link, key: 'ab'.repeat(32), cand: [{ a: `192.168.1.10:${link}`, k: 'host' }] }
    } else if (cmd === 'nm_share_open') {
      this.shareEvents = args.events as (m: unknown) => void
      r = 7
    }
    return r as T
  }
  channel(onMessage: (m: unknown) => void): unknown {
    return onMessage
  }
  emit(link: number, m: unknown): void {
    this.links.get(link)?.(m)
  }
  of(cmd: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.cmd === cmd).map((c) => c.args)
  }
  /** App messages (CtlMessage) sent over a link */
  ctl(link: number): CtlMessage[] {
    return this.of('nm_link_send').filter((a) => a.link === link).map((a) => JSON.parse(a.text as string) as CtlMessage)
  }
}

const NV_LIVE: LiveInfo = { title: 'Forza', width: 2560, height: 1440, fps: 60, audio: false, viewers: 0, since: 1, nv: { v: 1, min: 1, codecs: ['hevc', 'h264'] } }
const PEER_KEY = 'cd'.repeat(32)
const NV_TIMING = { offerMs: 300, connectMs: 300, firstFrameMs: 200, joinMs: 100 }

function setupNative(opts: { nvTiming?: Partial<typeof NV_TIMING> } = {}): { room: FakeRoom; tunnel: TunnelSession; fake: FakeBackend } {
  const fake = new FakeBackend()
  setNativeBackend(fake)
  const room = new FakeRoom()
  const tunnel = new TunnelSession({
    room,
    name: 'Seb',
    net: DEFAULT_NET,
    timing: { presenceMs: 150, presenceMinGapMs: 40, expireMs: 10_000, tickMs: 20 },
    nvTiming: { ...NV_TIMING, ...(opts.nvTiming ?? {}) },
  })
  return { room, tunnel, fake }
}

/** Starts the tunnel, makes 'aaaa' a native-capable sharer, watches it and waits for the first 'nv' join. */
async function watchNative(room: FakeRoom, tunnel: TunnelSession): Promise<{ v: WatchSwitch; states: ViewerState[]; nid: string }> {
  tunnel.start()
  room.deliver('aaaa', { t: 'presence', name: 'Ben', live: NV_LIVE }, true)
  const v = tunnel.watch('aaaa')
  assert.ok(v instanceof WatchSwitch, 'a sharer with live.nv is watched through a WatchSwitch')
  const states: ViewerState[] = []
  v.onState = (s) => states.push(s)
  await waitFor(() => room.nv('join').length >= 1, 2000, 'nv join')
  return { v, states, nid: room.nv('join')[0].body.nid }
}

function offer(nid: string, extra: Partial<Extract<SignalBody, { t: 'nv'; k: 'offer' }>> = {}): SignalBody {
  return { t: 'nv', k: 'offer', nid, sid: 'sid00001', codec: 'h264', link: 555, key: PEER_KEY, cand: [{ a: '192.168.1.20:4000', k: 'host' }], hostName: 'Ben', fps: 60, kbps: 0, audio: false, ...extra }
}

test('native watch: join → offer → up; no picture in time → WebRTC (link closed, WebRTC join)', async () => {
  const { room, tunnel, fake } = setupNative()
  try {
    const { v, states, nid } = await watchNative(room, tunnel)
    const j = room.nv('join')[0]
    assert.equal(j.to, 'aaaa')
    assert.equal(j.body.origin, 'aaaa')
    assert.equal(j.body.link, 100)
    assert.equal(j.body.key, 'ab'.repeat(32))
    assert.deepEqual(j.body.caps, fake.watchCaps)
    assert.deepEqual(j.body.cand, [{ a: '192.168.1.10:100', k: 'host' }])
    assert.deepEqual(fake.of('nm_link_open')[0].role, 'watch')
    assert.deepEqual(fake.of('nm_link_open')[0].stun, DEFAULT_NET.stun)
    // re-sent with the same nid until the offer
    await waitFor(() => room.nv('join').length >= 2, 1000, 'join re-sent')
    assert.equal(room.nv('join')[1].body.nid, nid)
    // late local candidates travel with the next join
    fake.emit(100, { t: 'cand', cand: [{ a: '5.6.7.8:100', k: 'srflx' }] })
    await waitFor(() => room.nv('join').at(-1)!.body.cand.length === 2, 1000, 'join with srflx')

    room.deliver('aaaa', offer(nid))
    assert.equal(v.state(), 'connecting')
    await waitFor(() => fake.of('nm_link_remote').length === 1, 1000, 'nm_link_remote')
    assert.deepEqual(fake.of('nm_link_remote')[0], { link: 100, peerLink: 555, key: PEER_KEY, cand: [{ a: '192.168.1.20:4000', k: 'host' }] })
    const joins = room.nv('join').length
    await delay(150)
    assert.equal(room.nv('join').length, joins, 'no joins after the offer')
    // the sharer's late candidates, our late candidates
    room.deliver('aaaa', { t: 'nvice', sid: 'sid00001', cand: [{ a: '1.2.3.4:5', k: 'srflx' }] })
    await waitFor(() => fake.of('nm_link_cand').length === 1, 1000, 'nm_link_cand')
    fake.emit(100, { t: 'cand', cand: [{ a: '5.6.7.9:100', k: 'srflx' }] })
    assert.deepEqual(room.of('nvice').at(-1), { body: { t: 'nvice', sid: 'sid00001', cand: [{ a: '5.6.7.9:100', k: 'srflx' }] }, to: 'aaaa' })

    fake.emit(100, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 0.8 })
    assert.equal(v.state(), 'connected')
    assert.equal(v.upstreamAlive(), true)
    await waitFor(() => fake.ctl(100).some((m) => m.t === 'hello'), 1000, 'ctl hello')
    fake.emit(100, { t: 'msg', m: JSON.stringify({ t: 'info', hostName: 'Ben', settings: DEFAULT_SETTINGS, viewers: 1, codec: 'H264', hops: 1 }) })

    // no picture within firstFrameMs → WebRTC
    await waitFor(() => v.transport() === 'webrtc', 2000, 'fallback')
    assert.match(v.fallbackReason, /no picture/)
    await waitFor(() => fake.of('nm_link_close').some((a) => a.link === 100), 1000, 'native link closed')
    await waitFor(() => room.of('join').length >= 1, 2000, 'WebRTC join')
    assert.equal(room.of('join')[0].to, 'aaaa')
    assert.equal(room.of('bye').length, 0, 'the link was up: no signaling bye')
    assert.deepEqual(states.slice(0, 3), ['waiting', 'connecting', 'connected'])
    assert.equal(states.at(-1), 'waiting', 'the WebRTC session starts over')
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test("native watch: 'no' unavailable → WebRTC at once; 'no' denied → rejected (no WebRTC)", async () => {
  {
    const { room, tunnel } = setupNative()
    try {
      const { v, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', { t: 'nv', k: 'no', nid, reason: 'unavailable' })
      assert.equal(v.transport(), 'webrtc')
      assert.match(v.fallbackReason, /unavailable/)
      await waitFor(() => room.of('join').length >= 1, 2000, 'WebRTC join')
      assert.equal(room.of('bye').length, 0, 'no sid-less bye on a fallback (it would overtake the WebRTC join)')
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, states, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', { t: 'nv', k: 'no', nid: 'someone-else', reason: 'denied' })
      assert.equal(v.state(), 'waiting', 'a no for another nid is ignored')
      room.deliver('aaaa', { t: 'nv', k: 'no', nid, reason: 'denied' })
      assert.equal(v.state(), 'rejected')
      assert.equal(v.transport(), 'native')
      assert.deepEqual(states, ['waiting', 'rejected'])
      await waitFor(() => fake.of('nm_link_close').length === 1, 1000, 'link closed')
      await delay(150)
      assert.equal(room.of('join').length, 0, 'no WebRTC attempt')
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
})

test("native watch: no offer in time → WebRTC; 'wait' (approval pending) cancels that timer", async () => {
  {
    const { room, tunnel } = setupNative()
    try {
      const { v } = await watchNative(room, tunnel)
      await waitFor(() => v.transport() === 'webrtc', 2000, 'offer timeout')
      assert.match(v.fallbackReason, /no offer/)
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', { t: 'nv', k: 'wait', nid })
      await delay(NV_TIMING.offerMs + 200)
      assert.equal(v.transport(), 'native', 'still waiting for the approval')
      assert.ok(room.nv('join').length >= 3, 'joins keep coming while waiting')
      // the user leaves while still waiting: the sharer drops the request at once
      tunnel.stopWatching()
      assert.deepEqual(room.of('bye').at(-1), { body: { t: 'bye' }, to: 'aaaa' })
      await waitFor(() => fake.of('nm_link_close').length === 1, 1000, 'link closed')
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
})

test('native watch: a link that never comes up → sid bye + WebRTC; a live link that dies → one native retry, then WebRTC', async () => {
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', offer(nid))
      fake.emit(100, { t: 'fail', reason: 'no pair answered' })
      assert.equal(v.transport(), 'webrtc')
      assert.deepEqual(room.of('bye').at(-1), { body: { t: 'bye', sid: 'sid00001' }, to: 'aaaa' })
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, states, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', offer(nid))
      fake.emit(100, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
      fake.emit(100, { t: 'closed', reason: 'timeout' })
      assert.equal(v.state(), 'reconnecting')
      await waitFor(() => room.nv('join').some((j) => j.body.link === 101), 1000, 'retry with a new link')
      const retry = room.nv('join').find((j) => j.body.link === 101)!
      assert.notEqual(retry.body.nid, nid, 'new nid')
      assert.ok(fake.of('nm_link_close').some((a) => a.link === 100))
      // events of the old link are ignored now
      fake.emit(100, { t: 'up', remote: 'x', lan: true, rttMs: 1 })
      assert.equal(v.state(), 'reconnecting')
      room.deliver('aaaa', offer(retry.body.nid, { sid: 'sid00002' }))
      fake.emit(101, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
      assert.equal(v.state(), 'connected')
      fake.emit(101, { t: 'closed', reason: 'bye' })
      assert.equal(v.transport(), 'webrtc', 'the second loss falls back')
      assert.deepEqual(states.slice(0, 5), ['waiting', 'connecting', 'connected', 'reconnecting', 'connecting'])
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
})

/** A key frame as native_media.rs sends it (layout: the parseNvMessage test). */
function keyFrame(codec: NvCodec): ArrayBuffer {
  const data = [0, 0, 0, 1, 0x40]
  const buf = new ArrayBuffer(NV_VIDEO_HEADER + data.length)
  const d = new DataView(buf)
  d.setUint8(0, 1)
  d.setUint8(1, 0b001)
  d.setUint8(2, codec === 'hevc' ? 2 : 1)
  d.setUint32(4, 1, true)
  d.setBigUint64(8, 1_000_000n, true)
  new Uint8Array(buf, NV_VIDEO_HEADER).set(data)
  return buf
}

test('native watch: HEVC that does not decode here → remembered, one native retry with H.264 (no WebRTC)', async () => {
  // just enough of a page for NvVideoRenderer: a canvas, storage, and WebCodecs without an HEVC decoder (as on a
  // machine where HEVC fails)
  const store = new Map<string, string>()
  const fakes: Record<string, unknown> = {
    document: { createElement: () => ({ getContext: () => null, remove: () => {}, width: 0, height: 0 }) },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, val: string) => void store.set(k, val) },
    VideoDecoder: class {
      static async isConfigSupported(c: { codec: string }): Promise<{ supported: boolean }> {
        return { supported: !c.codec.startsWith('hvc1') }
      }
    },
    EncodedVideoChunk: class {},
  }
  const saved = Object.keys(fakes).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const)
  for (const [k, value] of Object.entries(fakes)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true })
  const { room, tunnel, fake } = setupNative()
  fake.watchCaps = { v: 1, min: 1, dec: ['hevc', 'h264'], rfi: false, audio: false }
  try {
    const { v, nid } = await watchNative(room, tunnel)
    room.deliver('aaaa', offer(nid, { codec: 'hevc' }))
    fake.emit(100, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
    fake.emit(100, keyFrame('hevc'))
    await waitFor(() => room.nv('join').some((j) => j.body.link === 101), 1000, 'native retry with a new link')
    const retry = room.nv('join').find((j) => j.body.link === 101)!
    assert.deepEqual(retry.body.caps.dec, ['h264'], 'the retry asks for H.264 only')
    assert.equal(v.transport(), 'native')
    assert.equal(v.state(), 'reconnecting')
    assert.equal(store.get('streamtunnel.nv.noHevc'), '1', 'this machine remembers it')
    assert.ok(fake.of('nm_link_close').some((a) => a.link === 100))
    room.deliver('aaaa', offer(retry.body.nid, { sid: 'sid00002' }))
    fake.emit(101, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
    assert.equal(v.state(), 'connected')
    // no third native attempt: the next failure goes to WebRTC
    await waitFor(() => v.transport() === 'webrtc', 2000, 'fallback after the H.264 attempt')
    assert.match(v.fallbackReason, /no picture/)
  } finally {
    tunnel.leave()
    setNativeBackend(null)
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc)
      else delete (globalThis as Record<string, unknown>)[k]
    }
  }
})

test('native watch: kicked / ended over the link end the watch (no fallback); without caps → WebRTC; no live.nv → ViewerSession', async () => {
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', offer(nid))
      fake.emit(100, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
      fake.emit(100, { t: 'msg', m: JSON.stringify({ t: 'kick' }) })
      assert.equal(v.state(), 'kicked')
      assert.equal(v.transport(), 'native')
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel, fake } = setupNative()
    try {
      const { v, nid } = await watchNative(room, tunnel)
      room.deliver('aaaa', offer(nid))
      fake.emit(100, { t: 'up', remote: '192.168.1.20:4000', lan: true, rttMs: 1 })
      fake.emit(100, { t: 'closed', reason: 'ended' })
      assert.equal(v.state(), 'ended')
      // the sharer's broadcast bye after that changes nothing
      room.deliver('aaaa', { t: 'bye' }, true)
      assert.equal(v.state(), 'ended')
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel, fake } = setupNative()
    fake.watchCaps = null
    try {
      tunnel.start()
      room.deliver('aaaa', { t: 'presence', name: 'Ben', live: NV_LIVE }, true)
      const v = tunnel.watch('aaaa') as WatchSwitch
      await waitFor(() => room.of('join').length >= 1, 2000, 'WebRTC join')
      assert.equal(v.transport(), 'webrtc')
      assert.equal(room.nv('join').length, 0)
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
  {
    const { room, tunnel } = setupNative()
    try {
      tunnel.start()
      room.deliver('aaaa', { t: 'presence', name: 'Ben', live: { ...NV_LIVE, nv: undefined } }, true)
      const v = tunnel.watch('aaaa')
      assert.equal(v instanceof WatchSwitch, false)
    } finally {
      tunnel.leave()
      setNativeBackend(null)
    }
  }
})

// ───────────────────────── sharer ─────────────────────────

function join(nid: string, extra: Partial<Extract<SignalBody, { t: 'nv'; k: 'join' }>> = {}): SignalBody {
  return {
    t: 'nv',
    k: 'join',
    nid,
    origin: 'self00000001',
    name: 'Ben',
    caps: { v: 1, min: 1, dec: ['hevc', 'h264'], rfi: false, audio: true },
    link: 900,
    key: PEER_KEY,
    cand: [{ a: '192.168.1.30:6000', k: 'host' }],
    ...extra,
  }
}

async function shareNative(room: FakeRoom, tunnel: TunnelSession, opts: { maxDirect?: number; requireApproval?: boolean } = {}): Promise<HostSession> {
  tunnel.start()
  const host = tunnel.share(new MediaStream([videoTrack('window:4242:0')]), DEFAULT_SETTINGS, 'Forza', opts) as HostSession
  await waitFor(() => room.of('presence').some((p) => (p.body as { live: LiveInfo | null }).live?.nv !== undefined), 2000, 'presence with live.nv')
  return host
}

test('native share: presence live.nv; join → capture, probing, offer; up → info; kick ends the link', async () => {
  const { room, tunnel, fake } = setupNative()
  try {
    const host = await shareNative(room, tunnel)
    const live = (room.of('presence').find((p) => (p.body as { live: LiveInfo | null }).live?.nv)!.body as { live: LiveInfo }).live
    assert.deepEqual(live.nv, { v: 1, min: 1, codecs: ['hevc', 'h264'] })
    assert.deepEqual(fake.of('nm_share_open')[0].cfg, { source: 'window:4242:0', width: 1920, height: 1080, fps: 60, maxHeight: 1440, kbps: 0, audio: false })
    const changes: number[] = []
    host.onViewersChanged = (v) => changes.push(v.length)

    room.deliver('wwww', join('nid00001'))
    await waitFor(() => room.nv('offer').length === 1, 2000, 'offer')
    // the capture starts before probing (its deadline must not run while NVENC starts)
    const order = fake.calls.map((c) => c.cmd).filter((c) => c === 'nm_share_add' || c === 'nm_link_remote')
    assert.deepEqual(order, ['nm_share_add', 'nm_link_remote'])
    assert.deepEqual(fake.of('nm_link_open')[0].role, 'share')
    assert.deepEqual(fake.of('nm_share_add')[0], { share: 7, link: 100, codec: 'hevc', rfi: false })
    assert.deepEqual(fake.of('nm_link_remote')[0], { link: 100, peerLink: 900, key: PEER_KEY, cand: [{ a: '192.168.1.30:6000', k: 'host' }] })
    const o = room.nv('offer')[0]
    assert.equal(o.to, 'wwww')
    assert.equal(o.body.nid, 'nid00001')
    assert.equal(o.body.codec, 'hevc')
    assert.equal(o.body.link, 100)
    assert.equal(o.body.key, 'ab'.repeat(32))
    assert.equal(o.body.hostName, 'Seb')
    assert.equal(o.body.fps, 60)
    assert.match(o.body.sid, /^[0-9a-f]{16}$/)
    assert.deepEqual(host.viewers().map((v) => [v.id, v.state, v.native]), [['wwww', 'connecting', true]])

    // a duplicate join re-sends the same offer (not more often than ~1/s), never a second link
    await delay(1000)
    room.deliver('wwww', join('nid00001'))
    assert.equal(room.nv('offer').length, 2)
    assert.equal(room.nv('offer')[1].body.sid, o.body.sid)
    assert.equal(fake.of('nm_link_open').length, 1)

    fake.emit(100, { t: 'up', remote: '192.168.1.30:6000', lan: true, rttMs: 0.5 })
    await waitFor(() => fake.ctl(100).some((m) => m.t === 'info'), 1000, 'ctl info')
    fake.emit(100, { t: 'msg', m: JSON.stringify({ t: 'hello', name: 'Wanda' }) })
    assert.deepEqual(host.viewers().map((v) => [v.name, v.state]), [['Wanda', 'connected']])
    assert.equal(host.connectedCount(), 1)
    assert.ok(changes.length > 0, 'viewer list re-emitted')

    host.kick('wwww')
    await waitFor(() => fake.of('nm_link_close').some((a) => a.link === 100 && a.reason === 'kicked'), 1000, 'link closed (kicked)')
    assert.ok(fake.ctl(100).some((m) => m.t === 'kick'))
    assert.equal(host.viewers().length, 0)
    room.deliver('wwww', join('nid00002'))
    assert.deepEqual(room.nv('no').at(-1)?.body, { t: 'nv', k: 'no', nid: 'nid00002', reason: 'kicked' })
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test('native share: approval through the HostSession, slots shared with WebRTC (maxDirect)', async () => {
  const { room, tunnel } = setupNative()
  try {
    const host = await shareNative(room, tunnel, { maxDirect: 1, requireApproval: true })
    const asked: Array<{ id: string; allow: (ok: boolean) => void }> = []
    host.onJoinRequest = (v, allow) => asked.push({ id: v.id, allow })
    room.deliver('wwww', join('nid00001'))
    assert.deepEqual(room.nv('wait').map((w) => [w.to, w.body.nid]), [['wwww', 'nid00001']])
    assert.deepEqual(asked.map((a) => a.id), ['wwww'])
    assert.deepEqual(host.viewers().map((v) => [v.id, v.state]), [['wwww', 'pending']])
    room.deliver('wwww', join('nid00001'))
    assert.equal(asked.length, 1, 'asked once')
    asked[0].allow(true)
    room.deliver('wwww', join('nid00001'))
    await waitFor(() => room.nv('offer').length === 1, 2000, 'offer after approval')

    // the only direct slot is taken by the native watcher
    room.deliver('xxxx', join('nid00003', { name: 'Xaver' }))
    assert.equal(asked.length, 2)
    asked[1].allow(true)
    room.deliver('xxxx', join('nid00003', { name: 'Xaver' }))
    assert.deepEqual(room.nv('no').at(-1)?.body, { t: 'nv', k: 'no', nid: 'nid00003', reason: 'full' })

    // denied
    room.deliver('yyyy', join('nid00004'))
    asked[2].allow(false)
    room.deliver('yyyy', join('nid00004'))
    assert.deepEqual(room.nv('no').at(-1)?.body, { t: 'nv', k: 'no', nid: 'nid00004', reason: 'denied' })
    assert.equal(room.of('reject').length, 0, 'native requests never get a WebRTC reject')
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test('native share: a source that cannot be captured ends the links and drops live.nv; stop ends everything', async () => {
  const { room, tunnel, fake } = setupNative()
  try {
    const host = await shareNative(room, tunnel)
    room.deliver('wwww', join('nid00001'))
    await waitFor(() => room.nv('offer').length === 1, 2000, 'offer')
    fake.emit(100, { t: 'up', remote: '192.168.1.30:6000', lan: true, rttMs: 0.5 })

    host.setPaused(true)
    await waitFor(() => fake.ctl(100).some((m) => m.t === 'paused'), 1000, 'paused handed on')
    await host.updateSettings({ ...DEFAULT_SETTINGS, fps: 120, bitrateKbps: 30_000 })
    await waitFor(() => fake.of('nm_share_update').length === 1, 1000, 'nm_share_update')
    assert.deepEqual(fake.of('nm_share_update')[0], { share: 7, cfg: { fps: 120, maxHeight: 1440, kbps: 30_000 } })

    await host.replaceStream(streamOf('web-contents-media-stream://1:2'))
    await waitFor(() => fake.of('nm_link_close').some((a) => a.link === 100 && a.reason === 'closed'), 1000, 'native link ended')
    await waitFor(() => (room.of('presence').at(-1)!.body as { live: LiveInfo | null }).live?.nv === undefined, 2000, 'presence without nv')
    room.deliver('wwww', join('nid00002'))
    assert.deepEqual(room.nv('no').at(-1)?.body, { t: 'nv', k: 'no', nid: 'nid00002', reason: 'unavailable' })

    // capturable again
    await host.replaceStream(streamOf('screen:1:0'))
    assert.deepEqual(fake.of('nm_share_source').at(-1), { share: 7, source: 'screen:1:0', width: 1920, height: 1080 })
    await waitFor(() => (room.of('presence').at(-1)!.body as { live: LiveInfo | null }).live?.nv !== undefined, 2000, 'presence with nv again')
    room.deliver('wwww', join('nid00003'))
    await waitFor(() => room.nv('offer').length === 2, 2000, 'second offer')
    fake.emit(101, { t: 'up', remote: '192.168.1.30:6000', lan: true, rttMs: 0.5 })

    tunnel.stopSharing()
    await waitFor(() => fake.of('nm_share_close').length === 1, 1000, 'nm_share_close')
    await waitFor(() => fake.of('nm_link_close').some((a) => a.link === 101 && a.reason === 'ended'), 1000, 'link ended')
    assert.ok(fake.ctl(101).some((m) => m.t === 'bye'))
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test("native share: the encoder fails for good (ended 'error') → links end, joins get 'unavailable', WebRTC goes on", async () => {
  const { room, tunnel, fake } = setupNative()
  try {
    await shareNative(room, tunnel)
    room.deliver('wwww', join('nid00001'))
    await waitFor(() => room.nv('offer').length === 1, 2000, 'offer')
    fake.emit(100, { t: 'up', remote: '192.168.1.30:6000', lan: true, rttMs: 0.5 })
    // a closed window is the web track's business (main.ts): nothing happens here
    fake.shareEvents!({ t: 'ended', reason: 'closed' })
    await delay(50)
    assert.equal(fake.of('nm_link_close').length, 0)
    fake.shareEvents!({ t: 'ended', reason: 'error' })
    await waitFor(() => fake.of('nm_link_close').some((a) => a.link === 100 && a.reason === 'closed'), 1000, 'native link ended')
    await waitFor(() => (room.of('presence').at(-1)!.body as { live: LiveInfo | null }).live?.nv === undefined, 2000, 'presence without nv')
    assert.ok((room.of('presence').at(-1)!.body as { live: LiveInfo | null }).live, 'still sharing (WebRTC)')
    room.deliver('wwww', join('nid00002'))
    assert.deepEqual(room.nv('no').at(-1)?.body, { t: 'nv', k: 'no', nid: 'nid00002', reason: 'unavailable' })
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test("tunnel: an 'nv' join while we share without the native side → 'no unavailable'; not sharing → silent", async () => {
  const { room, tunnel, fake } = setupNative()
  fake.shareCodecs = null // this machine cannot share natively
  try {
    tunnel.start()
    room.deliver('wwww', join('nid00001'))
    assert.equal(room.nv('no').length, 0, 'silent while not sharing')
    tunnel.share(new MediaStream([videoTrack('window:4242:0')]), DEFAULT_SETTINGS, 'Forza')
    await delay(50)
    room.deliver('wwww', join('nid00002'))
    assert.deepEqual(room.nv('no').map((n) => [n.to, n.body.reason]), [['wwww', 'unavailable']])
    assert.equal(fake.of('nm_share_open').length, 0)
  } finally {
    tunnel.leave()
    setNativeBackend(null)
  }
})

test('fallbackMessage: every fall-back reason gets a sentence the user understands', () => {
  const msgs = ['no offer', 'connect timeout', 'fail: timeout', 'no picture', 'decoder errors', 'no: unavailable'].map(fallbackMessage)
  assert.equal(new Set(msgs.slice(0, 1).concat(msgs.slice(1, 2), msgs.slice(3))).size, 5, 'distinct messages per cause')
  assert.equal(fallbackMessage('connect timeout'), fallbackMessage('fail: timeout'), 'connection problems share one hint')
  assert.ok(fallbackMessage('something odd').includes('something odd'), 'unknown reasons are shown verbatim')
})

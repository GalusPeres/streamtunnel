// Unit tests for the pure RTC helpers (bitrate model, SDP munging, codec ordering, latency estimate).
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, effectiveBitrateKbps, iceServers } from '../src/rtc/defaults.ts'
import { degradationFor } from '../src/rtc/tuning.ts'
import { mungeAnswer, negotiatedVideoCodec, preferH264High, sameNetwork, startBitrateKbps } from '../src/rtc/tuning.ts'
import { chooseCodec, classifyEncoder, orderCodecs } from '../src/rtc/codecs.ts'
import { estimateLatencyMs, hostPairIsLan, isLocalAddress, windowFps } from '../src/rtc/stats.ts'
import type { StreamSettings } from '../src/types.ts'

const auto = (patch: Partial<StreamSettings> = {}): StreamSettings => ({ ...DEFAULT_SETTINGS, ...patch })

test('effectiveBitrateKbps: model values from the spec', () => {
  assert.equal(effectiveBitrateKbps(auto(), 'H264', 1920, 1080, 60), 8700)
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 1920, 1080, 60), 5600)
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 2560, 1440, 60), 10000)
  assert.equal(effectiveBitrateKbps(auto(), 'VP9', 1920, 1080, 60), 6800)
})

test('effectiveBitrateKbps: explicit bitrate, detail factor, clamps, fallback size', () => {
  assert.equal(effectiveBitrateKbps(auto({ bitrateKbps: 8000 }), 'AV1', 1920, 1080, 60), 8000)
  assert.equal(effectiveBitrateKbps(auto({ content: 'detail' }), 'H264', 1920, 1080, 60), 7000)
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 1280, 720, 30), 1500)
  assert.equal(effectiveBitrateKbps(auto(), 'H264', 3840, 2160, 120), 40000)
  // unknown track size → nominal size of the resolution preference (1440p)
  assert.equal(effectiveBitrateKbps(auto({ resolution: 1440 }), 'AV1', 0, 0, 60), 10000)
  const v = effectiveBitrateKbps(auto(), 'H264', 1920, 1080, 120)
  assert.equal(v % 100, 0)
  assert.ok(v > 8700 && v < 17400)
})

test('iceServers: one STUN entry, TURN entries, empties skipped', () => {
  assert.deepEqual(
    iceServers({
      brokers: [],
      stun: ['stun:a:1', ' ', 'stun:b:2'],
      turn: [{ urls: '' }, { urls: 'turn:t:3478', username: 'u', credential: 'p' }],
    }),
    [{ urls: ['stun:a:1', 'stun:b:2'] }, { urls: 'turn:t:3478', username: 'u', credential: 'p' }],
  )
  assert.deepEqual(iceServers({ brokers: [], stun: [], turn: [] }), [])
})

const ANSWER = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'm=video 9 UDP/TLS/RTP/SAVPF 45 102 103 116 117',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=recvonly',
  'a=rtpmap:45 AV1/90000',
  'a=rtcp-fb:45 nack',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:116 red/90000',
  'a=rtpmap:117 ulpfec/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=recvonly',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:2',
  'a=sctp-port:5000',
  '',
].join('\r\n')

test('mungeAnswer: start bitrate on video codecs, opus params, CRLF, idempotent', () => {
  const out = mungeAnswer(ANSWER, { startKbps: 7440, audioKbps: 192 })
  const lines = out.split('\r\n')
  assert.ok(out.endsWith('\r\n'))
  assert.ok(!/[^\r]\n/.test(out), 'only CRLF line endings')
  // AV1 had no fmtp → created right after its rtpmap
  const av1 = lines.indexOf('a=rtpmap:45 AV1/90000')
  assert.equal(lines[av1 + 1], 'a=fmtp:45 x-google-start-bitrate=7440')
  assert.ok(lines.includes('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f;x-google-start-bitrate=7440'))
  // rtx / red / ulpfec untouched, no fmtp invented for them
  assert.ok(lines.includes('a=fmtp:103 apt=102'))
  assert.ok(!lines.some((l) => l.startsWith('a=fmtp:116') || l.startsWith('a=fmtp:117')))
  // opus: existing keys replaced, no duplicates
  assert.ok(lines.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;usedtx=0'))
  assert.ok(lines.includes('a=fmtp:63 111/111'))
  // nothing leaks into the data channel section
  assert.ok(lines.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'))
  assert.equal(mungeAnswer(out, { startKbps: 7440, audioKbps: 192 }), out)
  // changing the value replaces it
  const again = mungeAnswer(out, { startKbps: 3000, audioKbps: 128 })
  assert.ok(again.includes('a=fmtp:45 x-google-start-bitrate=3000\r\n'))
  assert.ok(again.includes('maxaveragebitrate=128000'))
  assert.equal((again.match(/x-google-start-bitrate/g) ?? []).length, 2)
})

test('mungeAnswer: LF input is normalized to CRLF', () => {
  const out = mungeAnswer(ANSWER.replace(/\r\n/g, '\n'), { startKbps: 5000, audioKbps: 192 })
  assert.ok(!/[^\r]\n/.test(out))
  assert.ok(out.includes('a=fmtp:45 x-google-start-bitrate=5000\r\n'))
})

test('negotiatedVideoCodec: first payload type of the video m-line', () => {
  assert.equal(negotiatedVideoCodec(ANSWER), 'AV1')
  assert.equal(negotiatedVideoCodec(ANSWER.replace('SAVPF 45 102', 'SAVPF 102 45')), 'H264')
  assert.equal(negotiatedVideoCodec('v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\n'), null)
})

test('startBitrateKbps: 60 % clamped to [3000, 10000]', () => {
  assert.equal(startBitrateKbps(12400), 7440)
  assert.equal(startBitrateKbps(2500), 3000)
  assert.equal(startBitrateKbps(60000), 10000)
})

const caps: RTCRtpCodec[] = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=64001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f' },
  { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'level-idx=5;profile=0;tier=0' },
  { mimeType: 'video/H265', clockRate: 90000 },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
  { mimeType: 'video/flexfec-03', clockRate: 90000, sdpFmtpLine: 'repair-window=10000000' },
]

const label = (c: RTCRtpCodec) => {
  const name = c.mimeType.slice(6)
  if (name !== 'H264') return name
  const pl = /profile-level-id=(\w{4})/.exec(c.sdpFmtpLine ?? '')?.[1]
  const pm = /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1]
  return `H264-${pl}-${pm}`
}

test('orderCodecs: H.264 primary with profile order, aux last, H.265 dropped', () => {
  assert.deepEqual(orderCodecs(caps, 'H264').map(label), [
    'H264-6400-1',
    'H264-4d00-1',
    'H264-42e0-1',
    'H264-4200-1',
    'H264-6400-0',
    'AV1',
    'VP9',
    'VP8',
    'rtx',
    'red',
    'ulpfec',
    'flexfec-03',
  ])
})

test('orderCodecs: AV1 primary, then H264, VP9, VP8', () => {
  const order = orderCodecs(caps, 'AV1').map(label)
  assert.equal(order[0], 'AV1')
  assert.equal(order[1], 'H264-6400-1')
  assert.deepEqual(order.slice(6), ['VP9', 'VP8', 'rtx', 'red', 'ulpfec', 'flexfec-03'])
  assert.ok(!order.includes('H265'))
  assert.equal(orderCodecs(caps, 'VP9').map(label)[0], 'VP9')
})

test('chooseCodec', () => {
  assert.equal(chooseCodec('auto', { av1: true, h264: true }, ['AV1', 'H264']), 'AV1')
  assert.equal(chooseCodec('auto', { av1: true, h264: true }, ['H264']), 'H264')
  assert.equal(chooseCodec('auto', { av1: false, h264: true }, ['AV1']), 'H264')
  assert.equal(chooseCodec('VP9', { av1: true, h264: true }, ['AV1']), 'VP9')
})

test('classifyEncoder', () => {
  assert.equal(classifyEncoder('MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)', undefined), true)
  assert.equal(classifyEncoder('libaom', undefined), false)
  assert.equal(classifyEncoder('OpenH264', false), false)
  assert.equal(classifyEncoder('', true), true)
  assert.equal(classifyEncoder('', undefined), null)
})

test('estimateLatencyMs', () => {
  assert.equal(estimateLatencyMs({ hostEncodeMs: null, rttMs: null, jitterBufferMs: 10, decodeMs: 2, fps: 60, upstreamLatencyMs: 0 }), null)
  // 6 (default encode) + 20/2 + 15 + 3 + 8 + 1000/60/2 ≈ 50.3
  assert.equal(estimateLatencyMs({ hostEncodeMs: null, rttMs: 20, jitterBufferMs: 15, decodeMs: 3, fps: 60, upstreamLatencyMs: 0 }), 50)
  // 4 + 10/2 + 0 + 0 + 8 + 0 (fps unknown) + 40 upstream
  assert.equal(estimateLatencyMs({ hostEncodeMs: 4, rttMs: 10, jitterBufferMs: 0, decodeMs: 0, fps: 0, upstreamLatencyMs: 40 }), 57)
  // unknown jitter buffer / decode time → no estimate (never counted as 0)
  assert.equal(estimateLatencyMs({ hostEncodeMs: 4, rttMs: 10, jitterBufferMs: null, decodeMs: 2, fps: 60, upstreamLatencyMs: 0 }), null)
  assert.equal(estimateLatencyMs({ hostEncodeMs: 4, rttMs: 10, jitterBufferMs: 5, decodeMs: null, fps: 60, upstreamLatencyMs: 0 }), null)
})

test('hostPairIsLan / isLocalAddress: public IPv6 host candidates are not LAN', () => {
  assert.equal(isLocalAddress('192.168.1.5'), true)
  assert.equal(isLocalAddress('10.0.0.1'), true)
  assert.equal(isLocalAddress('172.20.1.1'), true)
  assert.equal(isLocalAddress('172.32.1.1'), false)
  assert.equal(isLocalAddress('100.100.1.1'), true) // CGNAT / VPN overlay
  assert.equal(isLocalAddress('fe80::1%12'), true)
  assert.equal(isLocalAddress('fd12:3456::1'), true)
  assert.equal(isLocalAddress('abcd-1234.local'), true)
  assert.equal(isLocalAddress('2003:e1:1f00::5'), false)
  assert.equal(isLocalAddress('8.8.8.8'), false)
  assert.equal(hostPairIsLan('192.168.1.5', '192.168.1.9'), true)
  assert.equal(hostPairIsLan('2003:e1:1f00:aa00::5', '2003:e1:1f00:aa00:1:2:3:4'), true, 'same /64 = same home network')
  assert.equal(hostPairIsLan('2003:e1:1f00:aa00::5', '2a02:8070:1:2::9'), false, 'global IPv6 across the internet')
  assert.equal(hostPairIsLan('192.168.1.5', '2a02:8070:1:2::9'), false)
  assert.equal(hostPairIsLan('85.1.2.3', '85.1.2.3'), true)
  assert.equal(hostPairIsLan('85.1.2.3', '91.1.2.3'), false)
  assert.equal(hostPairIsLan(undefined, '91.1.2.3'), true, 'unknown address keeps the old verdict')
})

test('windowFps: steady over a 3 s window although single intervals jitter (59 / 61 / 58 / 62)', () => {
  const hist: Array<{ id: string; ts: number; frames: number }> = []
  let frames = 0
  const out: number[] = []
  for (const [i, n] of [59, 61, 58, 62, 60, 59, 61, 60].entries()) {
    frames += n
    out.push(windowFps(hist, { id: 'v', ts: (i + 1) * 1000, frames }))
  }
  assert.equal(out[0], 0) // one sample: no rate yet
  for (const v of out.slice(3)) assert.ok(Math.abs(v - 60) <= 0.7, `fps ${v}`)
  assert.ok(hist.length <= 5)
  // new stream id or a counter going backwards starts over
  assert.equal(windowFps(hist, { id: 'w', ts: 9000, frames: 10 }), 0)
  assert.equal(hist.length, 1)
})

test('degradationFor: frame rate stays constant except for text (detail)', () => {
  assert.equal(degradationFor('motion'), 'maintain-framerate')
  assert.equal(degradationFor('balanced'), 'maintain-framerate')
  assert.equal(degradationFor('detail'), 'maintain-resolution')
})

test('sameNetwork: same public address or same private /24 → LAN; mDNS-only / different networks → not', () => {
  const sdp = (...c: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', ...c.map((x) => `a=candidate:${x}`)].join('\r\n')
  const offer = sdp('1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0', '2 1 udp 1686052607 84.10.20.30 50001 typ srflx raddr 192.168.1.20 rport 50000')
  assert.equal(sameNetwork(offer, sdp('3 1 udp 1686052607 84.10.20.30 61000 typ srflx raddr 0.0.0.0 rport 0', '4 1 udp 2122260223 abc.local 61000 typ host')), true)
  assert.equal(sameNetwork(offer, sdp('5 1 udp 2122260223 192.168.1.77 61000 typ host')), true)
  assert.equal(sameNetwork(offer, sdp('6 1 udp 1686052607 91.1.2.3 61000 typ srflx raddr 10.0.0.5 rport 61000', '7 1 udp 2122260223 10.0.0.5 61000 typ host')), false)
  assert.equal(sameNetwork(offer, sdp('8 1 udp 2122260223 abc.local 61000 typ host')), false)
})

test('mungeAnswer: x-google-min-bitrate only when asked (LAN)', () => {
  const ans = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1'].join('\r\n')
  assert.ok(!mungeAnswer(ans, { startKbps: 9000, audioKbps: 160 }).includes('x-google-min-bitrate'))
  const lan = mungeAnswer(ans, { startKbps: 15000, minKbps: 12000, audioKbps: 160 })
  assert.ok(lan.includes('x-google-start-bitrate=15000') && lan.includes('x-google-min-bitrate=12000'), lan)
})

test('effectiveBitrateKbps on the same LAN: Moonlight-like fixed rates, H.264 × 1.5, clamp 100 Mbit/s', () => {
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 1920, 1080, 60, true), 20000)
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 2560, 1440, 60, true), 35600)
  assert.equal(effectiveBitrateKbps(auto(), 'H264', 2560, 1440, 60, true), 53300)
  assert.equal(effectiveBitrateKbps(auto(), 'AV1', 3840, 2160, 60, true), 80000)
  assert.equal(effectiveBitrateKbps(auto(), 'H264', 3840, 2160, 120, true), 100000)
  assert.equal(effectiveBitrateKbps(auto({ bitrateKbps: 12000 }), 'H264', 2560, 1440, 60, true), 12000, 'explicit setting wins')
})

test('preferH264High: High-profile H.264 payload type moves to the front of the answer', () => {
  const lines = [
    'm=video 9 UDP/TLS/RTP/SAVPF 102 106 98',
    'a=rtpmap:102 H264/90000',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:106 H264/90000',
    'a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
    'a=rtpmap:98 VP9/90000',
  ]
  assert.equal(preferH264High(lines)[0], 'm=video 9 UDP/TLS/RTP/SAVPF 106 102 98')
  // already High, other codec first, or no High offered → unchanged
  assert.equal(preferH264High(['m=video 9 X 106 102', ...lines.slice(1)])[0], 'm=video 9 X 106 102')
  assert.equal(preferH264High(['m=video 9 X 98 102 106', ...lines.slice(1)])[0], 'm=video 9 X 98 102 106')
  const noHigh = lines.filter((l) => !l.startsWith('a=rtpmap:106') && !l.startsWith('a=fmtp:106'))
  assert.equal(preferH264High(noHigh)[0], 'm=video 9 UDP/TLS/RTP/SAVPF 102 106 98')
  const ans = ['v=0', ...lines].join('\r\n')
  assert.equal(negotiatedVideoCodec(mungeAnswer(ans, { startKbps: 9000, audioKbps: 160 })), 'H264')
  assert.ok(mungeAnswer(ans, { startKbps: 9000, audioKbps: 160 }).includes('SAVPF 106 102 98'))
})

// Native path, page side (docs/NATIVE-PATH.md): wire validation of the 'nv' signaling fields, codec choice, the
// Channel message layout shared with src-tauri/src/native_media.rs, and the LAN rate vectors shared with
// st-media's rate.rs. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseNvCodec,
  isNvKey,
  isNvLinkId,
  nvVersionsMatch,
  parseNvCandidates,
  parseNvLive,
  parseNvMessage,
  parseNvViewerCaps,
  NV_VIDEO_HEADER,
} from '../src/rtc/nativelink.ts'
import { parseLiveInfo } from '../src/rtc/tunnel.ts'
import { DEFAULT_SETTINGS, effectiveBitrateKbps } from '../src/rtc/defaults.ts'

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

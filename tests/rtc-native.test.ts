// Unit tests for the pure helpers of the Linux native media path (src/rtc/native.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addCandidatesToSdp, avcCodecString, ensureTransportCc, filterOfferForNative, nativeRtcActive, sdpMids } from '../src/rtc/native.ts'

// Shape of a Chrome/WebView2 offer from HostSession (AV1 preferred, then H.264 profiles, VP9, VP8, rtx/red/ulpfec).
const OFFER = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=video 9 UDP/TLS/RTP/SAVPF 45 46 102 103 104 105 98 99 96 97 116 117',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=fingerprint:sha-256 00:11',
  'a=setup:actpass',
  'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:toffset',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=sendonly',
  'a=msid:- v1',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  'a=rtpmap:45 AV1/90000',
  'a=rtcp-fb:45 goog-remb',
  'a=rtcp-fb:45 transport-cc',
  'a=rtcp-fb:45 nack',
  'a=rtcp-fb:45 nack pli',
  'a=fmtp:45 level-idx=5;profile=0;tier=0',
  'a=rtpmap:46 rtx/90000',
  'a=fmtp:46 apt=45',
  'a=rtpmap:102 H264/90000',
  'a=rtcp-fb:102 goog-remb',
  'a=rtcp-fb:102 transport-cc',
  'a=rtcp-fb:102 nack',
  'a=rtcp-fb:102 nack pli',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:104 H264/90000',
  'a=rtcp-fb:104 nack',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  'a=rtpmap:105 rtx/90000',
  'a=fmtp:105 apt=104',
  'a=rtpmap:98 VP9/90000',
  'a=fmtp:98 profile-id=0',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:116 red/90000',
  'a=rtpmap:117 ulpfec/90000',
  'a=ssrc-group:FID 1111 2222',
  'a=ssrc:1111 cname:x',
  'a=ssrc:2222 cname:x',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=sendonly',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000',
  'a=rtpmap:110 telephone-event/48000',
  'a=rtpmap:126 telephone-event/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:2',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n')

test('filterOfferForNative: video keeps H.264 packetization-mode=1 + its RTX only', () => {
  const out = filterOfferForNative(OFFER)
  const lines = out.split('\r\n')
  assert.ok(lines.includes('m=video 9 UDP/TLS/RTP/SAVPF 102 103'))
  for (const pt of ['45', '46', '104', '105', '98', '99', '96', '97', '116', '117']) {
    assert.ok(!lines.some((l) => l.startsWith(`a=rtpmap:${pt} `) || l.startsWith(`a=fmtp:${pt} `) || l.startsWith(`a=rtcp-fb:${pt} `)), `pt ${pt} removed`)
  }
  assert.ok(lines.includes('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034'))
  assert.ok(lines.includes('a=fmtp:103 apt=102'))
  assert.ok(lines.includes('a=rtcp-fb:102 nack pli'))
  // transport-cc stays (Chrome's bandwidth estimate needs TWCC feedback)
  assert.ok(lines.includes('a=rtcp-fb:102 transport-cc'))
  assert.ok(lines.includes('a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'))
  // other attributes survive
  for (const keep of ['a=mid:0', 'a=setup:actpass', 'a=ssrc-group:FID 1111 2222', 'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=group:BUNDLE 0 1 2']) {
    assert.ok(lines.includes(keep), keep)
  }
  assert.ok(out.endsWith('\r\n'))
})

test('filterOfferForNative: audio keeps Opus only, data channel untouched', () => {
  const out = filterOfferForNative(OFFER)
  const lines = out.split('\r\n')
  assert.ok(lines.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111'))
  assert.ok(lines.includes('a=rtpmap:111 opus/48000/2'))
  assert.ok(lines.includes('a=fmtp:111 minptime=10;useinbandfec=1'))
  assert.ok(!lines.some((l) => /^a=(rtpmap|fmtp):(63|9|0|8|13|110|126) /.test(l)))
  assert.ok(lines.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'))
  assert.ok(lines.includes('a=sctp-port:5000'))
})

test('filterOfferForNative: falls back to any H.264 when no packetization-mode=1 exists', () => {
  const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 104', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:104 H264/90000', 'a=fmtp:104 profile-level-id=42e01f', ''].join('\r\n')
  assert.ok(filterOfferForNative(sdp).includes('m=video 9 UDP/TLS/RTP/SAVPF 104\r\n'))
})

test('ensureTransportCc: restores extmap + rtcp-fb dropped by the answerer, leaves complete answers alone', () => {
  const offer = filterOfferForNative(OFFER)
  const bare = [
    'v=0',
    'a=group:BUNDLE 0 1 2',
    'm=video 9 UDP/TLS/RTP/SAVPF 102 103',
    'a=mid:0',
    'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=recvonly',
    'a=rtpmap:102 H264/90000',
    'a=rtcp-fb:102 nack pli',
    'a=rtpmap:103 rtx/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    'a=rtpmap:111 OPUS/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:2',
    '',
  ].join('\r\n')
  const fixed = ensureTransportCc(bare, offer).split('\r\n')
  const vEnd = fixed.indexOf('m=audio 9 UDP/TLS/RTP/SAVPF 111')
  const video = fixed.slice(0, vEnd)
  const audio = fixed.slice(vEnd)
  const ext = 'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
  assert.equal(video.filter((l) => l === ext).length, 1)
  assert.equal(video.indexOf(ext), video.indexOf('a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid') + 1)
  assert.equal(video.indexOf('a=rtcp-fb:102 transport-cc'), video.indexOf('a=rtpmap:102 H264/90000') + 1)
  assert.ok(!video.includes('a=rtcp-fb:103 transport-cc')) // rtx had none in the offer
  assert.ok(audio.includes(ext) && audio.includes('a=rtcp-fb:111 transport-cc'))
  // idempotent, and untouched when nothing is missing
  const again = fixed.join('\r\n')
  assert.equal(ensureTransportCc(again, offer), again)
  // offer without transport-cc → nothing added
  const noTcc = offer.split('\r\n').filter((l) => !l.includes('transport-cc') && !l.includes('transport-wide-cc')).join('\r\n')
  assert.equal(ensureTransportCc(bare, noTcc), bare)
  // rejected m-line stays rejected
  const rejected = bare.replace('m=video 9 ', 'm=video 0 ')
  assert.ok(!ensureTransportCc(rejected, offer).split('m=audio')[0].includes('transport-cc'))
})

test('addCandidatesToSdp / sdpMids', () => {
  const answer = ['v=0', 'a=group:BUNDLE 0 1 2', 'm=video 9 UDP/TLS/RTP/SAVPF 102', 'a=mid:0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:1', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2', ''].join('\r\n')
  assert.deepEqual(sdpMids(answer), ['0', '1', '2'])
  const c1 = 'candidate:1 1 UDP 2015363327 192.168.1.5 50000 typ host'
  const out = addCandidatesToSdp(answer, [
    { mline: 0, candidate: c1 },
    { mline: 0, candidate: 'a=' + c1 }, // duplicate (with prefix) → once
    { mline: 1, candidate: 'candidate:2 1 UDP 1677721855 1.2.3.4 50001 typ srflx raddr 0.0.0.0 rport 0' },
    { mline: 7, candidate: 'candidate:9 1 UDP 1 1.1.1.1 1 typ host' }, // no such section → ignored
  ])
  const lines = out.split('\r\n')
  assert.equal(lines.filter((l) => l === 'a=' + c1).length, 1)
  assert.ok(lines.indexOf('a=' + c1) > lines.indexOf('a=mid:0') && lines.indexOf('a=' + c1) < lines.indexOf('m=audio 9 UDP/TLS/RTP/SAVPF 111'))
  assert.ok(lines.indexOf('a=candidate:2 1 UDP 1677721855 1.2.3.4 50001 typ srflx raddr 0.0.0.0 rport 0') > lines.indexOf('a=mid:1'))
  assert.ok(!out.includes('1.1.1.1'))
  assert.equal(addCandidatesToSdp(answer, []), answer)
})

test('avcCodecString: profile/constraints/level from the SPS', () => {
  // AUD, then SPS (High 4.0: 64 00 28), PPS, IDR
  const au = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88])
  assert.equal(avcCodecString(au), 'avc1.640028')
  assert.equal(avcCodecString(new Uint8Array([0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0x00])), 'avc1.42e01f')
  assert.equal(avcCodecString(new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x00, 0x00])), null) // P slice only
  assert.equal(avcCodecString(new Uint8Array([])), null)
})

test('nativeRtcActive is false outside the Tauri/WebKitGTK app', () => {
  assert.equal(nativeRtcActive(), false)
})

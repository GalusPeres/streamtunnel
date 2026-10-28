# StreamTunnel — Architecture & Implementation Spec

Tauri 2 desktop app (primary target: Windows 10/11 with WebView2 ≥ 150) for Discord-like screen /
**game-window** sharing with **application audio**, lowest latency, best quality, minimal CPU, tiny
binary and **no own server**. Viewers join with a 10-character code.

Everything in this document marked **[measured]** was verified on the target machine
(WebView2 155, RTX 4080, Windows 11 26200) on 2026-10-18.

---

## 1. Big picture

```
 Host (StreamTunnel)                                      Viewer (StreamTunnel)
 ┌──────────────────────────────┐   encrypted signaling   ┌──────────────────────────────┐
 │ getDisplayMedia (window+app  │◄──── public MQTT ──────►│ ViewerSession                │
 │ audio or monitor+system aud.)│   brokers (4 in parallel)│  └ optional relay HostSession │
 │ HostSession: 1 RTCPeerConn.  │                          │     (re-shares to children)   │
 │ per direct viewer            │════ WebRTC P2P (DTLS) ══►│ <video> + <audio>             │
 └──────────────────────────────┘   AV1/H.264 HW encode    └──────────────────────────────┘
```

* **Media**: native WebRTC inside WebView2 (Chromium). Hardware encode (NVENC/AMF/QSV via
  MediaFoundation) and hardware decode (D3D11) — both require the engine flags in §7.
* **Topology**: star from the host for up to `maxDirect` (default 4) viewers; further viewers are
  redirected to **relays** (viewers that re-share their received stream) → tree. Relays re-encode
  (≈ +20–40 ms per hop). Max 3 children per relay.
* **Signaling**: hand-written MQTT 3.1.1 over WebSocket to 4 public brokers simultaneously, all
  payloads AES-GCM encrypted with a key derived from the room code. Brokers never see SDP/IPs in
  clear text and never carry media.
* **Rust side**: practically empty (Tauri builder + one tiny `keep_awake` command).

## 2. Global coding rules (all agents)

* TypeScript strict; `erasableSyntaxOnly` → **no enums, no namespaces, no constructor parameter
  properties**. Imports use explicit `.ts` extensions and `import type` for types.
* **No new npm dependencies.** Only `@tauri-apps/api` is available at runtime.
* Code comments in English; **all user-facing text in German** (informal "du").
* Do **not** change `src/types.ts` (shared contract). If you believe a change is required, put it
  in your final report instead.
* `src/core/*` and `src/signaling/*` must also run under Node 24 (global `WebSocket`,
  `crypto.subtle`, `crypto.getRandomValues`, `TextEncoder`) — no DOM APIs there.
* Keep it small and fast: no polling faster than needed, no allocations in hot loops, clean up
  every timer/listener/PeerConnection on stop.
* Typecheck: `npx tsc --noEmit` must pass for the whole project at all times.

## 3. Module map & ownership

| File | Owner | Purpose |
|---|---|---|
| `src/types.ts` | lead (frozen) | shared contracts |
| `src/core/code.ts` | signaling agent | room code generate/normalize/format |
| `src/core/crypto.ts` | signaling agent | PBKDF2/HKDF key + topic derivation, seal/unseal, randomId |
| `src/signaling/mqtt.ts` | signaling agent | minimal MQTT 3.1.1-over-WS client |
| `src/signaling/room.ts` | signaling agent | multi-broker encrypted room |
| `tests/*.test.ts` | signaling agent | `node --test` unit + live broker tests |
| `src/rtc/defaults.ts` | rtc agent | defaults, ICE servers, bitrate model |
| `src/rtc/capture.ts` | rtc agent | getDisplayMedia, test stream |
| `src/rtc/codecs.ts` | rtc agent | HW encode probe, HW decode caps, codec preference ordering |
| `src/rtc/tuning.ts` | rtc agent | SDP munging, sender params, receiver tuning |
| `src/rtc/stats.ts` | rtc agent | getStats sampling → Outbound/InboundStats |
| `src/rtc/host.ts` | rtc agent | HostSession (root + relay role) |
| `src/rtc/viewer.ts` | rtc agent | ViewerSession (+ embedded relay) |
| `index.html`, `src/main.ts`, `src/ui/*`, `src/styles.css`, `src/platform.ts`, `src/settings.ts` | ui agent | whole UI |
| `src-tauri/*`, `README.md` | lead | Tauri config, Rust, docs |

Public APIs other agents rely on are exactly the stubs currently in the files plus `src/types.ts`.
Internal helpers are free.

---

## 4. Signaling layer (signaling agent)

### 4.1 Room code (`core/code.ts`)
* Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, **10 chars = 50 bits**,
  generated with `crypto.getRandomValues` (byte & 31 is uniform).
* `formatCode("K7F3QX9MZD") === "K7F3Q-X9MZD"`.
* `normalizeCode`: uppercase; map `O→0`, `I→1`, `L→1`; drop `U` → invalid; strip whitespace, `-`,
  `_`; if the input is longer (pasted invite text like `"Code: K7F3Q-X9MZD (StreamTunnel)"`),
  extract the first run of 10 valid chars once separators are removed **within a `XXXXX-XXXXX`
  or 10-char token** (keep it simple: regex for `[0-9A-Z]{5}[-\s]?[0-9A-Z]{5}` after uppercasing,
  then normalize). Return `null` if not exactly 10 valid chars.

### 4.2 Crypto (`core/crypto.ts`)
* `deriveRoomKeys(code)`:
  1. `ikm = PBKDF2-HMAC-SHA256(password = code, salt = utf8("streamtunnel/v1/room"), 250_000 iterations, 256 bits)`
  2. HKDF-SHA256 (salt empty) from `ikm`: `info="key"` → 256-bit AES-GCM key (non-extractable,
     encrypt/decrypt); `info="topic"` → 128 bits → hex (32 chars).
  3. `topic = "st1/" + hex32` (base topic; room.ts appends sub-topics).
* `seal(key, value, aad)` / `unseal(key, data, aad)` — **add an `aad: string` parameter** (the
  base topic) used as AES-GCM additionalData. Output: 12-byte random IV ‖ ciphertext. `unseal`
  returns `null` on any error. (The stub lacks `aad`; adding it is allowed — only room.ts uses it.)
* `randomId(bytes = 8)` → lowercase hex.

### 4.3 MQTT client (`signaling/mqtt.ts`) — verified rules [measured by broker test]
* `new WebSocket(url, ['mqtt'])`, `binaryType = 'arraybuffer'`. Strip userinfo from the URL and
  use it as MQTT username/password (`new URL(url)`, `decodeURIComponent`).
* CONNECT: protocol "MQTT", level 4, flags `0x02` (clean session) | `0x80` username | `0x40`
  password (password requires username), keepalive **30 s**, client id `"st" + 20 hex` (22 chars,
  never empty, new random id per connection).
* **SUBSCRIBE fixed header 0x82** (not 0x80!), QoS 0. Re-subscribe all topics after every
  (re)connect. `unsubscribe` not needed.
* PUBLISH QoS0: header `0x30`, topic, payload (no packet id). When parsing incoming PUBLISH, skip
  2 bytes packet id if QoS bits `(h>>1)&3` > 0.
* Remaining-length varint (≤ 4 bytes). **Stream parser**: a WS message may contain several MQTT
  packets or a fragment — buffer and loop. Copy payloads (`slice`) before handing them out.
* **CONNACK timeout 4 s** (HiveMQ silently hangs on ~25 % of connects) → close + retry.
* PINGREQ every 20 s; if no PINGRESP/any packet within 10 s after a ping → reconnect.
* Reconnect with exponential backoff 0.5 s → 1 → 2 → 4 → … max 15 s, ±20 % jitter, reset after
  a successful CONNACK. `close()` stops everything (send DISCONNECT if open).
* Status callback: `connecting | connected | disconnected`.
* Limits to respect: payload ≤ 60 KB, ≤ ~8 publishes/s per connection (callers batch).

### 4.4 Room (`signaling/room.ts`)
* `SignalingRoom.open({code, selfId, role, brokers})`: derive keys, create one `MqttClient` per
  broker, subscribe, return immediately after key derivation.
* Topics (base `B = keys.topic`):
  * host inbox: `B/h` — subscribed by **role host** (receives broadcast joins)
  * peer inbox: `B/p/<peerId>` — subscribed by everybody for their own id
  * broadcast: `B/b` — subscribed by **role viewer**
* `send(body, to?)` routing: `to` given → `B/p/<to>`; else if `body.t === 'join'` → `B/h`;
  else → `B/b`.
* Envelope `{v, id: randomId(8), from: selfId, to, ts: Date.now(), body}` → `seal(key, env, B)`
  once → publish to every **connected** client. If no broker is connected, queue (max 50 msgs,
  drop entries older than 15 s) and flush on the first connect.
* Receive: `unseal` (drop on null) → validate shape (`v === PROTOCOL_VERSION`, string `id`/`from`,
  number `ts` within ±10 min, object `body` with string `t`) → drop own messages (`from ===
  selfId`) → drop if `to` set and `!== selfId` → **dedupe by `id`** (LRU of last 4096 ids) →
  `onSignal(from, body)`.
* Abuse guard: drop payloads > 64 KB; per broker, if > 60 messages/s arrive, ignore that broker for
  30 s.
* `status()` / `onStatus` with `{connected, total}` on every change.
* `close()` closes all clients and clears timers.

### 4.5 Tests (`tests/`, run with `node --test tests/`)
* Unit: code round-trips/normalization, varint boundaries (0,127,128,16383,16384,2097151,2097152),
  parser fed 1 byte at a time / odd splits / coalesced, seal/unseal round-trip + wrong key + wrong
  aad → null, deriveRoomKeys determinism and timing (< 1.5 s in Node).
* Live (skippable with env `ST_OFFLINE=1`): two `SignalingRoom`s (host + viewer) on the same
  fresh code exchange join → offer-shaped messages through the real default brokers; dedupe
  works (each message delivered exactly once despite 4 brokers); wrong code gets nothing.
* Add `"test": "node --test tests/"` to package.json scripts.

---

## 5. RTC layer (rtc agent)

### 5.1 Facts the design relies on [measured]
* WebView2 155 + flags (§7): AV1 encode = `MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)`,
  H.264 encode = `... (NVIDIA H.264 Encoder MFT)`, decode = `ExternalDecoder (D3D11VideoDecoder)`
  for both. Without `WebRtcAV1HWEncode` AV1 is libaom (software); without disabling
  `WebRTCColorAccuracy` decode falls back to FFmpeg/dav1d.
* H.265 is **not** offered for sending in WebView2 even with flags — never negotiate it.
* `mediaCapabilities.encodingInfo({type:'webrtc'})` reports `powerEfficient:false` even for
  hardware encoders → **unreliable for encode**. `decodingInfo` correctly reports HW decode.
* `encoderImplementation` / `powerEfficientEncoder` are only exposed while the page captures
  (host: yes). Viewers do not see `decoderImplementation`.
* Window capture with **application audio** works: picker tab "Fenster" + toggle
  "App-Audio ebenfalls teilen" → audio track labelled `"Application Audio"` that contains only that
  app's sound. Track settings `displaySurface: 'window'`, `deviceId: 'window:<hwnd>:0'`.
  Monitor capture offers system audio. `windowAudio` option is not supported (ignore).
* Capture at 2560×1440 @ 120 fps works. Chromium's default capture cap is 2880×1800 / 30 fps unless
  width/height/frameRate constraints are given.
* MF encoder caps reported: up to 1920×1080 @ 120 fps and 3840×2160 @ 30 fps (H.264 and AV1).
  4K60 may fall back to software → detect and warn.
* Chromium forces software codecs below 360p (270p AV1) → start with a high start bitrate so the
  first frames are full resolution.
* `jitterBufferTarget` is a *minimum* (floor) in ms; 0 = default behaviour.
* Default libwebrtc max bitrate without `maxBitrate` is 2.5 Mbps → always set it.
* `x-google-start-bitrate` (kbps) must be in the SDP the **sender applies as remote description**
  → host munges the viewer's answer before `setRemoteDescription`. `maxBitrate` from
  `setParameters` overrides `x-google-max-bitrate`. Never use `x-google-min-bitrate`.
* Opus params (stereo etc.) are read from the receiver's fmtp → also munge the answer on the host.
* Audio and video in the same MediaStream are lip-synced (video may be delayed to match audio) →
  send them in **separate streams** (different msid).

### 5.2 `defaults.ts`
* `DEFAULT_SETTINGS` and `DEFAULT_NET` as in the stub (keep values).
* `iceServers(net)`: `[{urls: net.stun}, ...net.turn]` (skip empty).
* `effectiveBitrateKbps(settings, codec, w, h, fps)`: if `settings.bitrateKbps > 0` return it.
  Else `bpp = codec === 'AV1' ? 0.06 : codec === 'VP9' ? 0.07 : 0.1`;
  `kbps = w*h*60*bpp/1000 * (fps/60)^0.7`; `detail` content ×0.8; clamp **[2500, 60000]**;
  round to 100. (1080p60 H.264 ≈ 12.4 Mbps, AV1 ≈ 7.5 Mbps; 1440p60 AV1 ≈ 13 Mbps.)

### 5.3 `capture.ts`
* `captureScreen(settings)`:
  ```
  navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: {ideal: fps, max: fps},
             width: {max: res==='native' ? 3840 : round(res*16/9)}, height: {max: res==='native' ? 2160 : res} },
    audio: settings.audio ? { echoCancellation:false, noiseSuppression:false, autoGainControl:false,
                              channelCount: 2, sampleRate: 48000, suppressLocalAudioPlayback: false } : false,
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  })
  ```
  then set `contentHint` per content mode (`detail` → `'detail'`, else `'motion'`).
  Errors: `NotAllowedError` → `CaptureError('cancelled', 'Freigabe abgebrochen.')`;
  missing API → `'unsupported'`; else `'failed'` with a German message incl. `err.name`.
* `describeCapture(stream)`: surface from `getSettings().displaySurface`, label from track label
  (for `window:`/`screen:` ids use "Fenster"/"Bildschirm"), `hasAudio`.
* `applyCaptureSettings(stream, settings)`: `applyConstraints` for fps/size (ignore failures),
  update `contentHint`, `audioTrack.enabled = settings.audio`.
* `makeTestStream(fps = 60)`: 1280×720 canvas animation (moving bars, big ms clock
  `Date.now() % 100000`, frame counter) via `canvas.captureStream(fps)`, plus a quiet 440 Hz
  beep for 100 ms every second through `AudioContext` → `MediaStreamDestination`. Drive drawing
  with `setInterval(1000/fps)` (rAF stops when hidden). Stopping the video track stops the
  interval and closes the AudioContext.

### 5.4 `codecs.ts` (new file)
* `probeHardwareEncoders(videoTrack): Promise<{av1: boolean, h264: boolean}>` — loopback test:
  two local RTCPeerConnections (no ICE servers), `addTransceiver(track.clone(), sendonly)` with
  AV1 preferred, run ~1.2 s, read `outbound-rtp.encoderImplementation`/`powerEfficientEncoder`;
  then same for H.264 only if AV1 was not HW. Hardware = `powerEfficientEncoder === true` or name
  matches `/MediaFoundation|NVENC|AMF|QSV|D3D12|VideoToolbox|VAAPI|V4L2|ExternalEncoder/i`;
  software = `/libaom|libvpx|OpenH264|SVT/i`. Close everything, stop the clone. Total timeout 4 s;
  on failure `{av1:false, h264:true}`. Cache per session.
* `hardwareDecoders(): Promise<CodecName[]>` — `mediaCapabilities.decodingInfo({type:'webrtc',
  video:{contentType:'video/AV1'|'video/H264'|'video/VP9', width:1920, height:1080, bitrate:10e6,
  framerate:60}})`, keep codecs with `supported && powerEfficient`. Cache.
* `chooseCodec(pref, hostHw, viewerDec)`: explicit pref → it; auto → `AV1` if `hostHw.av1 &&
  viewerDec.includes('AV1')`, else `H264`.
* `orderCodecs(caps: RTCRtpCodec[], primary: CodecName)`: primary first; for H.264 order profiles
  High (`profile-level-id=64…`) > Main (`4d…`) > Constrained Baseline (`42e0…`) > Baseline
  (`4200…`), packetization-mode=1 before 0; then the other codecs in order AV1, H264, VP9, VP8;
  `rtx`, `red`, `ulpfec`, `flexfec` last. Use `RTCRtpSender.getCapabilities('video')` for sendonly
  transceivers (fall back to receiver caps if `setCodecPreferences` throws).

### 5.5 `tuning.ts`
* `mungeAnswer(sdp, {startKbps, audioKbps})`: in the **video** m-section add
  `x-google-start-bitrate=<startKbps>` to each `a=fmtp` of real video codecs (AV1/H264/VP8/VP9 —
  look up payload types via `a=rtpmap`), creating `a=fmtp:<pt> x-google-start-bitrate=…` if a codec
  has no fmtp line (AV1/VP8 sometimes). In the **audio** m-section add to opus fmtp:
  `stereo=1;sprop-stereo=1;maxaveragebitrate=<audioKbps*1000>;useinbandfec=1;usedtx=0`
  (replace existing keys, no duplicates). Keep CRLF line endings. Pure string function — unit-test
  friendly.
* `startBitrateKbps(maxKbps) = clamp(round(maxKbps*0.6), 3000, 10000)`.
* `applySenderParams(sender, {maxKbps, fps, content, kind})`: fresh `getParameters()`; ensure
  `encodings[0]`; video: `maxBitrate`, `maxFramerate`, `priority:'high'`, `networkPriority:'high'`,
  `degradationPreference`: motion→`'maintain-framerate'`, balanced→`'balanced'`,
  detail→`'maintain-resolution'`; audio: `maxBitrate = 192000`, `priority:'high'`. Serialize calls
  per sender (promise chain); on failure retry once without `degradationPreference`.
* `tuneReceiver(receiver, mode)`: `jitterBufferTarget = mode === 'smooth' ? 120 : 0` (guard with
  `'jitterBufferTarget' in receiver`, try/catch).

### 5.6 `stats.ts`
* `class StatsSampler { constructor(pc); outbound(): Promise<OutboundStats|null>; inbound(hwHint): Promise<InboundStats|null> }`
  keeps the previous report for interval deltas (bitrate, fps fallback, loss %, jitter-buffer ms,
  decode ms, encode ms).
* connType from the selected candidate pair (`transport.selectedCandidatePairId`, fallback:
  `candidate-pair` with `nominated && state==='succeeded'`): any side `relay` → `'relay'`; both
  `host` → `'lan'`; else `'p2p'`.
* Inbound latency estimate: `hostEncodeMs (from ctl 'tx', default 6) + rtt/2 + jitterBufferMs +
  decodeMs + 8 (render) + 1000/fps/2 (capture) + upstreamLatencyMs`; `null` while rtt unknown
  (RTT for a receive-only peer comes from `remote-outbound-rtp.roundTripTime` or candidate-pair
  `currentRoundTripTime`).

### 5.7 `host.ts` — `HostSession`
State per viewer (`Peer`): `{id, name, jid, sid, pc, dc, codec, state, createdAt, connectedAt,
pendingRemoteIce[], localDescSent, answerApplied, sampler, tx, rx, timers}`.

**Start**: `room.onSignal` handler (keep previous handler chaining irrelevant — HostSession owns the
room while live). Root: broadcast `{t:'host', hostName}` immediately and every 3 s. Run
`probeHardwareEncoders` once on start (async; until it resolves treat AV1 as unavailable — or
await it before answering the first join; joins just wait for the next retry).

**Join** `{jid, name, dec, relay}` from `id` (root: only joins without `to`, i.e. arriving via the
host inbox; relay: only joins addressed to us — room already filters by `to`):
1. banned (kicked) → `reject kicked`. locked → `reject locked`.
2. existing peer with the **same jid** → idempotent: if its offer was sent > 1.5 s ago and it is
   not connected, re-send the cached offer (+ late candidates); else ignore.
3. existing peer with a **different jid** → close old pc, continue as new.
4. root + `requireApproval` + not yet approved id → state `pending`, call `onJoinRequest` once;
   ignore repeated joins while pending; on deny → `reject denied` (and remember denial for the
   session); on allow → continue.
5. direct peers (not failed) ≥ `maxDirect` (or upload budget exhausted) →
   root: pick a relay: connected direct viewer with `rx.canRelay`, `rx.children < 3`, connType ≠
   relay, lowest `children` then lowest rtt → `redirect {jid, relay}`; none → `reject full`.
   relay role: `reject full`.
6. Create peer: `new RTCPeerConnection({iceServers, bundlePolicy:'max-bundle', rtcpMuxPolicy:'require'})`;
   `dc = pc.createDataChannel('ctl', {negotiated: true, id: 0, ordered: true})`;
   video transceiver: `addTransceiver(videoTrack ?? 'video', {direction:'sendonly', streams:[videoStream], sendEncodings:[{maxBitrate, maxFramerate, priority:'high', networkPriority:'high'}]})`;
   audio transceiver: `addTransceiver(audioTrack ?? 'audio', {direction:'sendonly', streams:[audioStream]})`
   — **always create both** so `replaceTrack` can add/remove audio later without renegotiation;
   video and audio use **different** MediaStream objects (separate msid). `setCodecPreferences` with
   `orderCodecs(..., chooseCodec(settings.codec, hostHw, dec))`.
7. **Half-trickle**: `setLocalDescription()`, wait until `iceGatheringState === 'complete'` or
   800 ms, then send `offer {jid, sid, sdp: pc.localDescription.sdp, hostName}` (candidates gathered
   so far are inside the SDP). Later candidates: batch for 300 ms → `ice {sid, c}`.
8. On `answer {sid}` from the right id: only if `pc.signalingState === 'have-local-offer'` and sid
   matches; `mungeAnswer` → `setRemoteDescription` → flush buffered remote ICE → `applySenderParams`
   for both senders. Duplicates ignored.
9. On `ice {sid}` from viewer: buffer until remote description set, then `addIceCandidate` (ignore
   errors).
10. Connection state: `connected` → state connected, `connectedAt`, start per-peer stats; `failed`
    → close peer + remove; `disconnected` > 10 s → close + remove. Not connected within 25 s after
    offer → close + remove (viewer will retry with a new jid).
11. DataChannel: on open send `info {hostName, settings, viewers, codec, hops}`; every 2 s send
    `tx` from the sampler; receive `hello` (name) and `rx` (store). Queue sends until open.
12. `bye {sid}` from viewer → close + remove.

**Stats loop**: one 2 s interval for all connected peers (`sampler.outbound()`); emit
`onViewersChanged`. If a peer's `tx.hw === false` for 2 consecutive samples → `onNotice` once:
"Software-Encoder aktiv (hohe CPU-Last) – niedrigere Auflösung/FPS oder H.264 wählen."

**Upload budget**: if `uploadLimitKbps > 0`, per-peer max = `min(effective, limit / directCount)`
(re-applied whenever the direct count changes).

**updateSettings**: `applyCaptureSettings`; recompute max bitrate per peer from the actual capture
size (`track.getSettings()`), `applySenderParams` all peers; send new `info`.
**replaceStream**: `replaceTrack` on every peer's video/audio sender (audio may become null), keep new
stream, re-apply contentHint/params, `setPaused(false)`.
**setPaused**: send ctl `paused`.
**kick**: ctl `kick`, `room.send(reject kicked)`, ban id, close after 300 ms.
**stop**: ctl `bye` to all, root broadcasts `{t:'bye'}`, close all pcs, clear timers, detach from
room (`room.onSignal = () => {}`).
`viewers()` returns direct viewers incl. pending; `relayedCount()` = Σ `rx.descendants`.

### 5.8 `viewer.ts` — `ViewerSession`
* `start()`: compute `dec = await hardwareDecoders()`; state `waiting`; `jid = randomId()`; send
  `join {jid, name, dec, relay: allowRelay}` (no `to`) immediately and every 2 s while no offer for
  this jid; on `{t:'host'}` while waiting → send join immediately (throttle 500 ms).
* `redirect {jid, relay}` for current jid → target = relay id; keep the jid; send joins with
  `to = relay` every 2 s; if no offer within 8 s → back to the host (new jid).
* `offer {jid, sid}`: ignore if `jid !== current jid`. If a pc for this sid exists → resend cached
  answer (+ local candidates). Else create pc (same config, `negotiated` ctl channel id 0),
  `ontrack`: `tuneReceiver`; video tracks → `onVideo(new MediaStream([track]))`, audio →
  `onAudio(new MediaStream([track]))`. `setRemoteDescription(offer)` → flush buffered ICE →
  `createAnswer`/`setLocalDescription` → wait gathering complete or 800 ms → send `answer` to the
  sender of the offer. Late candidates batched → `ice`. Lock onto this host/relay id.
* States: `connecting` on offer; `connected` on `pc.connectionState === 'connected'`;
  `disconnected` > 5 s or `failed` → close pc, `reconnecting`, new jid, rejoin the **host** (not
  the relay); connect timeout 20 s → same. After 4 consecutive attempts that never reached
  `connected` → state `failed` (stop retrying; UI offers retry = `start()` again).
* `reject` for current jid → `kicked` (reason kicked) or `rejected` (detail = reason), stop retrying.
* `bye` broadcast from the host, or ctl `bye` → `ended`, close pc, stop retrying. (Relays forward
  `bye` to their children via ctl.)
* ctl: on open send `hello {name}`; handle `info` (→ `onHostInfo`), `tx` (feed latency estimate),
  `paused`, `kick` (→ `kicked`), `bye`. Every 2 s (1 s if the UI asks? — keep 1 s) sample inbound
  stats → `onStats`, and send `rx {fps, latencyMs, lossPct, width, height, children, descendants,
  canRelay}`.
* **Relay**: when connected and `allowRelay` and our connType ≠ relay, lazily create an embedded
  `HostSession({role:'relay', room, stream: <video+audio received tracks>, settings: info.settings,
  hostName: name, originName: hostInfo.hostName, hops: hostInfo.hops, maxDirect: 3,
  upstreamLatencyMs: () => lastLatency})` and `start()` it. It answers joins addressed to our id.
  On upstream reconnect, call `relay.replaceStream(newStream)` (children stay connected, see
  `paused` while upstream is down). On `stop()`/ended/kicked → `relay.stop()`. Children count →
  `rx.children`, `descendants = children + Σ children's descendants`.
* Room sharing: host and relay roles both use the viewer's room; the viewer's `onSignal` dispatcher
  forwards `join`/`answer`/`ice`/`bye`-with-sid messages that belong to the relay's peers to the
  relay session (expose an internal `handleSignal(from, body): boolean` on HostSession and use it
  from the viewer instead of letting both overwrite `room.onSignal`).
* `stop()`: send `bye {sid}` to current upstream, stop relay, close pc, clear timers.

---

## 6. UI (ui agent)

Vanilla TS, no framework. Single page with views; German text; dark theme by default with
optional light theme following `prefers-color-scheme`; accent gradient `#6d5dfc → #22c3ee`
(matches the app icon). System font stack (`"Segoe UI Variable", "Segoe UI", system-ui, …`),
no web fonts, no external assets (CSP).

### 6.1 Views
1. **Home**: logo + "StreamTunnel", tagline "Bildschirm & Spiele teilen – direkt von PC zu PC.
   Ohne Server.", name input (persisted), two cards:
   * **Teilen** → host setup.
   * **Zuschauen** → code input (auto-format `XXXXX-XXXXX`, accepts paste of invite text, Enter
     submits) + "Beitreten".
   * Gear → "Erweitert" dialog: broker list (textarea, one per line), STUN list, TURN (url/user/
     pass), "Zuschauer dürfen weiterleiten" (allowRelay), latency mode, reset to defaults.
2. **Host setup**: presets (chips): "Spiel (flüssig)" = 1440p60 motion, "Spiel 120 FPS" =
   1080p120 motion, "Text/Code (scharf)" = native 30 detail, "4K" = 2160p30 balanced,
   "Sparsam" = 1080p30 balanced 4 Mbit; plus advanced selects: Auflösung, FPS, Bitrate (Auto or
   2–60 Mbit/s slider), Inhalt, Codec (Auto/AV1/H.264/VP9), Ton an/aus, max. direkte Zuschauer
   (1–8, default 4), Upload-Limit (Auto / Mbit/s), "Zuschauer bestätigen" toggle.
   **Before** the picker show a hint card: "Spiel mit Ton teilen: im nächsten Dialog Tab
   **Fenster** wählen, dein Spiel anklicken und **„App-Audio ebenfalls teilen“** einschalten.
   Tipp: Spiel im randlosen Fenstermodus starten." Button "Teilen starten" (user gesture →
   `captureScreen`). Window must be ≥ 640 px tall when the picker opens (the picker breaks below
   600 px) — call `platform.ensureMinWindowHeight(680)` first.
   With `?test` in the URL (or a hidden toggle in Erweitert) show "Testbild senden" which uses
   `makeTestStream()`.
3. **Host live**: big code `XXXXX-XXXXX` + "Code kopieren" + "Einladung kopieren"
   (`"Schau meinen Stream in StreamTunnel: Code XXXXX-XXXXX"`); LIVE badge; source chip (Fenster/
   Bildschirm + label, 🔊/🔇); warning chip if no audio track ("Kein Ton – Quelle wechseln und
   „App-Audio ebenfalls teilen“ aktivieren"); signaling status (x/4 Broker); encoder chip from
   stats ("AV1 · Hardware" / "H.264 · Software ⚠"); viewer list (name, state, conn type
   LAN/P2P/Relay, sent res@fps, Mbit/s, RTT, viewer-reported fps/latency, children "+N über
   Weiterleitung", kick button; pending viewers get Annehmen/Ablehnen); "+N weitere über
   Weiterleitung" total; live controls: bitrate slider, FPS, Inhalt (apply immediately via
   `updateSettings`), "Quelle wechseln" (new `captureScreen` → `replaceStream` → stop old tracks),
   "Raum sperren" toggle, preview toggle (default **off**; when on, small muted `<video>` of the
   local stream), "Beenden". Track `ended` (user stopped sharing via OS/Chromium UI) →
   `setPaused(true)` + prominent "Quelle wechseln oder beenden" banner. Tip text: "Du kannst
   dieses Fenster minimieren – der Stream läuft weiter."
4. **Viewer**: full-window `<video>` (black bg, `object-fit: contain`, **no** CSS filters /
   transforms / rounded corners / backdrop-filter on or over the video), separate hidden
   `<audio>`. Overlay top bar: host name, LIVE, latency badge ("~45 ms"), connection type,
   "über Weiterleitung" if hops > 1. Bottom bar: volume slider + mute, stats toggle, latency mode
   (Niedrigste Latenz / Flüssig), mini-player (always on top), fullscreen, leave. Overlays
   auto-hide after 2.5 s without mouse movement; cursor hidden while idle in fullscreen.
   Stats panel (monospace): resolution, fps, Mbit/s, codec, decoder (HW/SW/unbekannt), host
   encoder (from `tx`), RTT, jitter buffer, decode, loss, dropped, freezes, connection type,
   latency estimate, hops. Keys: F/double-click fullscreen, Esc exit, S stats, M mute,
   L latency mode. State overlays with spinner/text: waiting ("Warte auf Host… Code XXXXX-XXXXX"),
   connecting, reconnecting, paused ("Host hat die Übertragung pausiert"), ended (with "Erneut
   warten" → new session), kicked, rejected (full/locked/denied texts), failed (explain NAT/
   firewall, suggest other network/VPN off/TURN in Erweitert, "Erneut versuchen").
   Autoplay: `video.muted = true` always (video only), `audio.play()` after the Join click
   (gesture); if it rejects show "Klicken für Ton". Wake lock via `platform.keepAwake(true)`
   while connected.
5. **Toasts** for notices/errors.

### 6.2 `platform.ts`
`isTauri()` (`'__TAURI_INTERNALS__' in window`), `setFullscreen(on)` / `isFullscreen()` (Tauri
window API, fallback Fullscreen API), `setAlwaysOnTop(on)` (Tauri only; returns false otherwise),
`ensureMinWindowHeight(px)` (Tauri `getCurrentWindow().innerSize()` / `setSize`, scale factor
aware; no-op in browser), `keepAwake(on)` (Tauri: `invoke('keep_awake', {on})`; plus
`navigator.wakeLock.request('screen')` re-acquired on `visibilitychange`; all errors swallowed).

### 6.3 `settings.ts`
localStorage (try/catch everywhere; work without it): name (default "Gast-XXXX"), last
StreamSettings, NetConfig (merged with defaults; empty broker list → defaults), allowRelay,
latencyMode, host room options (maxDirect, uploadLimitKbps, requireApproval).

### 6.4 Flow glue (`main.ts`)
* Host: `captureScreen` → `code = generateCode()` → `room = await SignalingRoom.open({code,
  selfId: randomId(), role:'host', brokers})` → `new HostSession({...}).start()`. Stop: session
  stop, room close (after 300 ms so bye goes out), stop tracks, back to home.
* Viewer: `normalizeCode` → `room = await SignalingRoom.open({..., role:'viewer'})` →
  `new ViewerSession({...}).start()`. Leave: stop, close room.
* Single-flight all actions (double clicks must not start two sessions).
* `pagehide`/`beforeunload`: stop sessions (sends bye).
* Expose `window.__st = { host, viewer, room }` for debugging/E2E tests.

---

## 7. Tauri / engine configuration (lead)

* `app.windows[0]`: 1100×760, min 760×640 (picker needs ≥ 600 px height).
* `additionalBrowserArgs` (replaces wry defaults, so they are re-added):
  `--enable-features=WebRtcAV1HWEncode --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,WebRTCColorAccuracy,WebRtcHideLocalIpsWithMdns --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
* CSP: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost wss:; media-src 'self' blob: mediastream:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`
* Capabilities: `core:default`, `core:window:allow-set-fullscreen`,
  `core:window:allow-set-always-on-top`, `core:window:allow-set-size`, `allow-keep-awake`.
* Rust: `keep_awake(on)` → `SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED |
  ES_SYSTEM_REQUIRED)` / `ES_CONTINUOUS` (Windows only; no-op elsewhere).
* Release profile: `opt-level="s"`, `lto`, `codegen-units=1`, `panic="abort"`, `strip`;
  `build.removeUnusedCommands: true`. NSIS installer, WebView2 `downloadBootstrapper`.

## 8. Known limits (documented for users)
* ~10–20 % of NAT combinations can't connect directly without TURN (CGNAT/symmetric NAT,
  corporate firewalls). Relay via another viewer or a user-supplied TURN server helps.
* Exclusive-fullscreen games may not be capturable → use borderless window mode.
* 4K60 may exceed the hardware encoder's reported limit → software fallback warning.
* Each direct viewer costs one encoder session + upload; NVIDIA consumer GPUs allow ~8 sessions.

---

## 9. Tunnel model (v2 — REPLACES the host/viewer roles above)

The user does **not** want a "host". A **tunnel** is a room identified by the code. Everyone in it is an
equal **member**. Any member can share a stream (screen/window + audio); any member can watch any live
member. Several members may share at the same time. Media still flows P2P (star from the sharer + relay
tree through watchers). Sections 4–6 stay valid except where this section overrides them.

### 9.1 Signaling changes (`room.ts`)
* No roles. `RoomOptions` loses `role`. Every member subscribes to the broadcast topic `B/b` and its own
  inbox `B/p/<selfId>`. The host inbox `B/h` is gone.
* `send(body, to?)`: `to` → `B/p/<to>`, else `B/b`. Joins are always addressed.
* Envelope AAD must bind the **full topic** the ciphertext is published on (confirmed finding: replay onto
  another sub-topic) — e.g. AAD = `<full topic>` and the receiver checks the topic it arrived on matches the
  envelope's `to` (inbox) / broadcast.
* Broadcast now carries `presence` every 3 s per member → keep the per-connection rate limit in mind
  (≤ 8 msg/s): fine for ~20 members.

### 9.2 Presence & members (`tunnel.ts`, new)
* `start()`: install `room.onSignal = dispatch`, broadcast `presence {name, live}` immediately and every 3 s;
  also immediately on any change (share start/stop, title, viewer count change — throttle to ≥ 1 s).
* Members map `id → {name, live, lastSeen}`; expire after 12 s without presence; `leave` removes at once;
  emit `onMembers` (self included, `self: true`; sorted live first, then name).
* `live` for self = `{title, width, height, fps, audio, viewers: connectedCount()+relayedCount(), since}`.

### 9.3 Sharing
* `share(stream, settings, title, opts)` → `new HostSession({room, stream, settings, hostName: name, net,
  role:'host', origin: selfId, maxDirect, uploadLimitKbps, requireApproval})`, `start()`, forward its
  `onNotice` to `tunnel.onNotice`; presence switches to live. `stopSharing()` → `host.stop()` (broadcasts
  `{t:'bye'}` without sid = "my stream ended"), presence `live: null`.
* HostSession: never touches `room.onSignal`; no 'host' announce timer anymore (presence replaces it);
  accepts `join` only if `body.origin === this.origin` (root: origin = own id). Everything else as before
  (idempotent joins, approval, lock, kick = ban from this stream, redirect to relays, expect-vouching …).

### 9.4 Watching
* `watch(memberId)` → stop current watch, `new ViewerSession({room, name, net, origin: memberId,
  allowRelay, latencyMode})`, `start()`. Joins go to `to = origin` (or to the relay after a redirect) with
  `origin` set. No "host inbox", no 'host' announces: `nudge()` is called by the tunnel when presence
  from the origin arrives while waiting.
* `originGone()` (called by the tunnel when the origin broadcasts `bye` without sid, announces
  `live: null`, sends `leave` or expires) → state `ended`, embedded relay `stop()` (children end too).
* Watching ends → UI returns to the tunnel view; the session object is dead (create a new one to rewatch).
* The embedded relay HostSession uses `role:'relay', origin: <watched member>`; children's joins carry the
  same origin.

### 9.5 Dispatch (`tunnel.ts`)
```
presence → members (+ watching.nudge() if from watched origin and waiting)
leave    → remove member (+ watching.originGone() if it was the origin)
bye (no sid, broadcast) → member.live = null (+ originGone if watched)
join     → if body.origin === selfId → sharing?.handleSignal ; else watching?.handleSignal (its relay)
           else (not for us) → reply reject 'full' so the joiner falls back quickly
other    → sharing?.handleSignal(from, body) || watching?.handleSignal(from, body)
```

### 9.6 UI wording (German, no jargon)
"Tunnel erstellen", "Tunnel beitreten", "Im Tunnel", "Teilen", "Ansehen", "Du teilst", "schauen zu",
"Tunnel verlassen". **Never** "Host", "Broker", "Encoder", "Hops", "Signaling" in the UI. Connection kinds:
"Lokal" (LAN), "Direkt" (P2P), "Relay" (TURN). Relayed watch: "über <Name>".

### 9.7 Implementation notes (as built)
* Topic prefix is `st2/` (incompatible with the pre-tunnel builds). AES-GCM AAD = the full topic; each topic
  accepts only its own body types (`B/b`: presence, leave, sid-less bye; inbox: everything addressed).
* `room.onSignal(from, body, broadcast)` passes a third, non-contract argument so the tunnel can tell a sharer's
  broadcast "stream ended" bye from an addressed bye.
* Relays only admit viewers the sharer vouched for over the relay's data channel (ctl `expect`), so the sharer's
  lock / ban / approval also apply one hop down. Relaying is disabled in the "Flüssig" latency mode.
* Member ids are random per tunnel join (`randomId(8)`): a kick bans an id from one stream only; rejoining the
  tunnel yields a new id (deliberate — two app windows on one PC must not share an id).

---

## 10. Native path (as built — contract in docs/NATIVE-PATH.md, plan in docs/MEDIA-PLAN.md)

Between two StreamTunnel **apps** the picture can skip WebRTC: a Windows sharer with NVIDIA captures and encodes in
Rust (Windows.Graphics.Capture → D3D11 → NVENC, crate `src-tauri/st-media`), sends over our own encrypted UDP
protocol `stm/1`, and the watcher's page decodes with WebCodecs. Everything else (tunnel, presence, admission,
viewer list, relays for WebRTC watchers) is unchanged; WebRTC stays the "Kompatibel" path for browsers, old
versions and every case where the native link does not come up.

```
sharer page                                  Rust (both apps)                               watcher page
picker → track (kept) ─ HostSession          nm_* commands (src-tauri/src/native_media.rs)  WatchSwitch
         NativeShare ── nm_share_* ────────► CaptureSession → Sender ═ UDP stm/1 ═► Receiver ─► NativeWatch
           admission: host.admitNative        one Endpoint (UDP socket) per app               raw Channel:
           'nv' offer / wait / no ◄──── E2E-encrypted signaling ────► 'nv' join, 'nvice'       AU  → NvVideoRenderer
                                              sysaudio.rs tap → 5 ms s16 chunks                PCM → NvAudioPlayer
```

| Piece | Where | Does |
|---|---|---|
| Glue | `src-tauri/src/native_media.rs` | `nm_caps`, the link commands (`nm_link_*`) and share commands (`nm_share_*`, Windows only). Link events go to the link's Channel as JSON; watch links also get every access unit and every 20 ms PCM block as raw bytes. Blocking work runs on the blocking pool. `ST_NATIVE=0` turns the path off. |
| Share sound | `src-tauri/src/sysaudio.rs` `set_tap` | the page's own WASAPI capture is tapped (no second client) and pushed to every sender of the share |
| Sessions | `src/rtc/nativelink.ts` | `NativeShare` (next to the HostSession), `NativeWatch`, `WatchSwitch`; the 'nv' validation helpers; the decisions `nvNoAction`, `nvClosedAction`, `nvWatchPlan` |
| Picture + sound | `src/rtc/nativeplayer.ts`, `src/rtc/pcmworklet.js` | WebCodecs decode, every frame drawn at once on a 2D canvas (no jitter buffer); an AudioWorklet ring buffer (40 ms target) whose MediaStream plays in the watch view's `<audio>` |
| Admission | `src/rtc/host.ts` | `admitNative` (ban, deny, lock, approval, slots shared with WebRTC), `attachNative` (viewer list, kick; settings / source / pause handed on) |
| Routing | `src/rtc/tunnel.ts` | `watch()` returns a `WatchSwitch` when the sharer's presence has `live.nv`; `share()` opens a `NativeShare` when this app can; 'nv' joins while sharing without it get 'no unavailable' |
| UI | `src/ui/format.ts` `nativeLine`, `watch.ts`, `tunnelview.ts` | stats panel "Nativ · HEVC · NVENC · 36 Mbit/s · RTT 1 ms"; "nativ" next to a native watcher's connection |

**When native is used.** Watcher: Tauri app, `nm_caps().watch`, WebCodecs decodes H.264 (or HEVC in hardware, never
on WebKit), and the sharer announces `live.nv` with a common codec and version. Sharer: Windows app, NVENC usable,
the track is a window or screen, and its sound (if any) comes from the app's own capture.

**Fallback to WebRTC** (at most once per watch, decided by the watcher's `WatchSwitch`): 'nv' no `unavailable` /
`busy` / `full`; no offer 4 s after the first join (a 'wait' for approval stops that timer); no link 3.5 s after the
offer (Rust fails it after 2.5 s); no decoded picture 2 s after the link is up; 3 decoder errors within 5 s; a live
link that dies twice (one native retry in between). `locked` / `denied` / `kicked` end the watch like the WebRTC
rejects.

**Tests.** `tests/rtc-nativelink.test.ts` (validation, decisions, the watcher and sharer flows through a
TunnelSession against a fake room and a fake Rust side), the `native_media.rs` unit tests (page message layouts,
event JSON), `node tests/e2e/native-decode.mjs` (headless Edge: a recorded H.264 stream through the renderer, sound
through the AudioWorklet). The transport and the Windows sender have their own tests in `st-media`.

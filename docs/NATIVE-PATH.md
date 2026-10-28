# Native media path: contract for the first milestone

Status: contract + compiling skeleton, 2026-10-28. Plan and research: `docs/MEDIA-PLAN.md` (§2, §3, §4, Phase 1a).

Three builders work on this in parallel without talking to each other. This file is the whole agreement.
Everything named here exists in the skeleton commit and compiles. Bodies are `todo!()` (Rust) or stubs (TypeScript).

| Owner | Builds |
|---|---|
| **NET** | `st-media` transport: `net/*`, `clock.rs`, `stats.rs`, `send.rs`, `recv.rs`, loopback tests |
| **WIN** | `st-media` Windows sender: `win/*` (WGC, D3D11, NVENC), its tests |
| **APP** | Tauri glue `src-tauri/src/native_media.rs`, all TypeScript, i18n, docs |

The exact file lists are in §13.

---

## 1. Scope of this milestone

**In scope**
- Windows sharer with NVIDIA:
  - capture: Windows.Graphics.Capture of the window or monitor picked in the *existing* getDisplayMedia dialog;
  - frames stay on the GPU (D3D11);
  - encode: NVENC through `nvEncodeAPI64.dll`, loaded at runtime;
  - codecs: H.264 High and HEVC Main.
- Our own UDP protocol `stm/1`:
  - AES-256-GCM with a replay window;
  - per-frame Reed-Solomon FEC;
  - pacing;
  - ICE-lite: host candidates plus STUN, simultaneous probing.
- Viewer in the Windows, Mac and Linux apps:
  - Rust receives and reassembles;
  - the page decodes with WebCodecs and draws the newest frame on a canvas;
  - sound is PCM, played through an AudioWorklet.
- Automatic fallback to today's WebRTC path ("Kompatibel") when the native path is impossible or fails.

**Out of scope here** (later phases of MEDIA-PLAN): AMD/Intel encoders, Mac and Linux sharers, relays and fan-out trees, TURN, Opus, NACK, VideoToolbox/Metal presenter, HDR, RFI on WebCodecs viewers, a measurement log.

### 1.1 Deliberate differences from MEDIA-PLAN.md

These are owner decisions for this milestone. Do not "fix" them back.

| MEDIA-PLAN | This milestone | Why |
|---|---|---|
| Noise `NNpsk0` handshake (snow) | Each side sends a random 32-byte **key half** inside the E2E-encrypted signaling; HKDF turns both halves into the keys (§5) | Same threat model (room member = authenticated) and one dependency fewer. The signaling is already AES-GCM end to end. |
| Access units to the page over a 127.0.0.1 WebSocket | **Tauri raw `Channel`**, as `src/rtc/native.ts` already does on Linux | Proven in the repo. A WebSocket stays a later option if the measured IPC delay (§9.3, `sentEpochUs`) is bad. |
| Mac viewer: VideoToolbox + Metal | **WebCodecs in the page** on every OS. WebKit always gets **H.264 High** | Uses one decoder and one presenter in TypeScript. WebKit's WebCodecs HEVC is unreliable. |
| RFI on loss | **IDR on loss** for every viewer (`rfi: false`). NVENC still implements `InvalidateRefs` | RFI on WebCodecs is unproven (MEDIA-PLAN §3.1 rule 2). |
| "Stop the browser track" (task text) | The getDisplayMedia track is **kept** | `track.stop()` cannot be undone. The WebRTC fallback and WebRTC viewers in mixed rooms need the track. With no WebRTC peer, nothing encodes it, so only the browser's capture copy remains. |

### 1.2 Hard rules

- **Resolution and fps stay fixed.**
  - Only the bitrate may change automatically.
  - A size changes only on a user action (settings, new source) or when the captured window itself is resized. Every size change sends an IDR.
- **A bitrate set by hand never changes.** "Auto" uses the LAN model: `effectiveBitrateKbps(…, lan = true)`, ported 1:1 in `rate::lan_bitrate_kbps`.
- **No NVENC → the native path is not offered** (`nm_caps().share = null`), and everything stays on WebRTC.
- **Size budget.** Only small pure-Rust crates or OS/driver APIs. The full list is in `st-media/Cargo.toml`, and **no owner adds a crate**.
- **Tests never open a window and never capture the real screen.**
  - Use `Source::TestPattern` and in-process loopback.
  - Bind `127.0.0.1` in tests so no firewall prompt appears.
- UI words follow `docs/ARCHITECTURE.md` §9.6. Never show "Host", "Encoder", "Signaling" or "stm". German and English strings go through `src/i18n.ts`.

---

## 2. Architecture

```
SHARER (Windows app)                                                 VIEWER (any app)
page: picker → getDisplayMedia track (kept) ── HostSession (WebRTC viewers, admission)
      NativeShare ── nm_share_* ──┐                                  page: WatchSwitch → NativeWatch
Rust  win::CaptureSession (per codec)                                      WebCodecs → canvas, AudioWorklet
        WGC → CopyResource → VideoProcessor BGRA→NV12 → NVENC              ▲ raw Channel (AU / PCM), JSON events
        └─ EncodedFrame ─► send::Sender ─► net::Link ═══ UDP stm/1 ═══► net::Link ─► recv::Receiver
      sysaudio.rs tap (f32 20 ms) ─► AudioChunk 5 ms ─┘                    (reassembly, FEC, loss → FrameLost)
both: one net::Endpoint = one UDP socket per app; candidates + key halves travel in 'nv' signaling (E2E MQTT)
```

**Threads**
- `st-capture`: one per capture session (WIN).
- `st-net-rx` and `st-net-tx`: per endpoint (NET).
- `st-recv`: per watch link, for delivery to the glue (NET).
- WGC's frame-pool thread: copies the frame and signals `st-capture`.

---

## 3. Windows sender (WIN, `st-media/src/win/`)

### 3.1 Source

The track's `deviceId` goes through `capture::parse_source(device_id, hint_w, hint_h)`:
- `window:<hwnd>:0` → `Source::Window(hwnd)`;
- `screen:<id>:0` → `wgc::resolve_screen`, which tries in this order:
  1. the id as an HMONITOR;
  2. the monitor at that index in `EnumDisplayMonitors` order;
  3. the only monitor;
  4. the only monitor whose size equals the track size.
- Anything else, or an ambiguous screen, returns `Err`, and that share stays on WebRTC with no UI.
- `Source::TestPattern { width, height }`: synthetic frames for tests.

### 3.2 Capture (`wgc.rs`)

- Item: `IGraphicsCaptureItemInterop::CreateForWindow` / `CreateForMonitor`.
- Frame pool: `Direct3D11CaptureFramePool::CreateFreeThreaded`, 2 buffers, `B8G8R8A8UIntNormalized`.
- Session settings:
  - `IsCursorCaptureEnabled(cursor)`;
  - `IsBorderRequired(false)` and `MinUpdateInterval(1/fps)` where the API exists (check with `ApiInformation`);
  - `IncludeSecondaryWindows(true)` for windows.
- The handler copies the surface (`CopyResource` into the converter's input) **before returning**, because WGC recycles its surfaces.
- `ContentSize` change → `Recreate` the pool. The session then resizes the encoder (IDR).
- `Closed` → `closed() = true`. Minimized (WGC delivers nothing) → `minimized() = true`, and the last frame is repeated.

### 3.3 GPU and encoder (`d3d.rs`, `nvenc.rs`, `nvenc_sys.rs`)

**Device and conversion**
- One `Gpu::nvidia()`: the first DXGI adapter with VendorId `0x10DE`, `BGRA_SUPPORT | VIDEO_SUPPORT`, multithread protection on.
- `Converter`: `ID3D11VideoProcessor`, BGRA → NV12, BT.709 limited range, scaling to `d3d::output_size` (already implemented). Letterbox, never stretch.
- NVENC therefore never gets RGB, which would need its CUDA path.

**Loading NVENC**
- Use `LoadLibraryExW("nvEncodeAPI64.dll", LOAD_LIBRARY_SEARCH_SYSTEM32)`.
- Require `NvEncodeAPIGetMaxSupportedVersion` ≥ 12.0.
- Then `NvEncodeAPICreateInstance`, then `NvEncOpenEncodeSessionEx(NV_ENC_DEVICE_TYPE_DIRECTX)`.
- Headers: NVIDIA Video Codec SDK **12.0** (nv-codec-headers `n12.0.16.1`, MIT). Transcribe the needed structs into `nvenc_sys.rs` and keep the MIT notice there.

**Encoder settings** (both codecs)

| Setting | Value |
|---|---|
| Preset | P3 up to 1440p60; P1 for anything larger or above 60 fps |
| Tuning | `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY` |
| Rate control | `NV_ENC_PARAMS_RC_CBR`, `multiPass = NV_ENC_TWO_PASS_QUARTER_RESOLUTION` |
| VBV | `vbvBufferSize = vbvInitialDelay = vbv_frames × bitrate / fps`, with `vbv_frames = 2.0` |
| GOP | `gopLength = idrPeriod = NVENC_INFINITE_GOPLENGTH`, `frameIntervalP = 1` (no B-frames), `repeatSPSPPS = 1` |
| Latency | `zeroReorderDelay = 1`, `enableLookahead = 0`; no AQ |
| References | DPB `maxNumRefFrames = 5`, `numRefL0 = 1` |
| Profiles | H.264 High; HEVC Main (8-bit 4:2:0) |
| VUI | BT.709 primaries / transfer / matrix, `videoFullRangeFlag = 0` |
| Input | `INPUT_SLOTS = 3` NV12 textures, registered once and mapped per frame |
| Mode | Synchronous. `inputTimeStamp = frame_id` |

### 3.4 Session (`capture.rs`)

`CaptureSession::start(source, cfg, sink)` runs one `st-capture` thread per session:

- **Frame flow:** frame arrived → convert into the next NV12 slot → encode → call `sink(EncodedFrame)`.
- **Frame ids:** count encoded frames from 1. `capture_us` is `clock::now_us()` at FrameArrived; `encoded_us` is taken after the bitstream is locked.
- **Too many frames:** frames faster than `fps` are skipped.
- **Static content:** when nothing new arrives for 2/fps, re-encode the last slot with `repeat = true`.
- **Requests**, applied before the next encode:
  - `Keyframe` → IDR;
  - `InvalidateRefs{first,last}` → `Encoder::invalidate`; if that returns `false` or `Err`, send an IDR;
  - `Bitrate{kbps}` → `Encoder::set_bitrate`, with no IDR.
- **Targets:** `cfg.bitrate_kbps == 0` means Auto, which is `rate::lan_bitrate_kbps(width, height, fps, codec)`, recomputed at every size change. `stats().target_kbps` reports that target. `stats().bitrate_kbps` reports the encoder's current rate.
- **User changes:**
  - `set_source(source)`: new item, new size, IDR;
  - `reconfigure(fps, max_height)`: new fps or resolution cap, IDR;
  - `set_target(kbps)`: no IDR.
- **Window closed:** frames stop and `stats().closed = true`.

`capture::probe() -> NvencCaps` is cached. It checks:
- the driver library is present;
- the API is ≥ 12.0;
- an NVIDIA adapter exists;
- `GraphicsCaptureSession::IsSupported()` is true;
- `nvenc::query` reports which codecs exist and the maximum size.

Optional, best effort, results logged with `eprintln!("[native] …")`:
- `D3DKMTSetProcessSchedulingPriorityClass(HIGH)` (never REALTIME);
- `IDXGIDevice::SetGPUThreadPriority(7)`;
- MMCSS "Games" on `st-capture`.

---

## 4. Wire format `stm/1` (NET, `net/wire.rs`)

All multi-byte fields are **big-endian**.

**Datagrams**
- Every datagram is at most `MAX_DATAGRAM = 1200` bytes.
- A datagram is `header (14) ‖ AES-256-GCM(plaintext) ‖ tag (16)`, and the header is the AEAD's associated data.

```
header  [0]     u8  version(2 bits)=1 << 6 | kind(6 bits): 1 Probe, 2 Ctrl, 3 Video, 4 Audio
        [1]     u8  key epoch = (pn >> 24) as u8
        [2..6]  u32 link id of the RECEIVER (it told the sender through signaling)
        [6..14] u64 packet number, per link and direction, from 1; also the nonce
STUN    first byte's top two bits 00 + cookie 0x2112A442 at [4..8] (wire::is_stun)
```

**Video plaintext** (`VIDEO_HEADER_LEN = 26`). Every shard repeats the frame fields.

```
[0..4] u32 frame id   [4..6] u16 shard index (data first, then parity)   [6..8] u16 data shards k
[8..10] u16 parity shards m   [10] u8 flags: 1 key, 2 after-RFI, 4 repeat   [11] u8 codec: 1 H.264, 2 HEVC
[12..16] u32 access-unit bytes   [16..24] u64 capture µs (sender clock)   [24..26] u16 sender latency (0.1 ms)
[26..] shard: frame::shard_len(au bytes, k) bytes (≤ MAX_SHARD = 1144, even; last data shard zero-padded)
```

**Audio plaintext** (`AUDIO_HEADER_LEN = 16`), 5 ms per packet, 976 bytes:

```
[0..4] u32 seq   [4..12] u64 capture µs   [12..14] u16 frames (240)   [14] u8 channels (2)   [15] u8 flags (0)
[16..] s16 LITTLE-endian interleaved PCM (the page's format; 960 bytes)
```

**Probe plaintext** (`PROBE_LEN = 13`): `[0..8] u64 sender µs (echoed in the reply) [8..12] u32 seq [12] u8 flags (bit0 = reply)`.

**Control plaintext:** see §6.4.

---

## 5. Crypto (NET, `net/crypto.rs`)

- **Key halves.** Each side draws a key half with `random_key_half()`, 32 bytes from the OS RNG via `getrandom`. It travels in signaling as 64 lowercase hex digits. `parse_hex32` and `to_hex` are in `lib.rs`.
- **Key derivation:**
  - `okm = HKDF-SHA256(salt = "stm/1 salt", ikm = sharer half ‖ viewer half, info = "stm/1 keys" ‖ sharer link id u32 BE ‖ viewer link id u32 BE, L = 64)`;
  - the sharer → viewer key is `okm[0..32]`; the viewer → sharer key is `okm[32..64]`.
- **AEAD:** AES-256-GCM (`aes-gcm`, no default features). Nonce = `[0,0,0,0] ‖ pn (u64 BE)`. AAD = the 14 header bytes.
- **Rekey every `2^24` packets:**
  - `key(e+1) = HKDF-Expand(PRK = key(e), info = "stm/1 rekey", 32)`;
  - the epoch byte must equal `(pn >> 24) as u8`;
  - the receiver keeps the keys for epochs e−1, e and e+1.
- **Replay window:** 2048 packets per direction. It advances only after the tag verifies. Too old or duplicate → `OpenError::Replay`.
- **Unauthenticated traffic.** No packet is acted on before it authenticates, and probes are sealed too.
  - We never reply to a datagram that failed AEAD.
  - Each source address gets a token bucket of 50 AEAD failures per second. Beyond that, drop without trying.
  - STUN responses are accepted only from configured servers with a matching 96-bit transaction id.

---

## 6. Media over a link (NET)

### 6.1 Sharding (`net/frame.rs`)

An access unit of n bytes is split as follows:
- `k = data_shard_count(n) = ⌈n / 1144⌉` data shards;
- each shard is `shard_len(n, k) = even(⌈n / k⌉)` bytes;
- `m = fec::parity_count(k, pct)` parity shards on top.

`shard_frame` builds all plaintexts once per frame. The `Sender` hands the same plaintexts to every link, and each link encrypts them with its own keys.

### 6.2 FEC (`net/fec.rs`)

- Library: `reed-solomon-simd` 3.1 (MIT AND BSD-3-Clause). **APP adds its BSD notice to the licences text.**
- One block per frame.
- Parity count: `max(2, ⌈k × pct / 100⌉)`.
  - `pct` is `FEC_PCT_LAN = 10` when every link of the sender is "lan", else `FEC_PCT_WAN = 20`.
  - No parity above 800 data shards.

### 6.3 Pacing (`net/pace.rs`)

- Each link has a token bucket with a 1 ms burst.
- Rate: `pace_bps(lan, target)`. A "lan" link paces at 800 Mbit/s; any other link at 3 × target, at least 20 Mbit/s.
- Audio goes ahead of queued video.
- A frame is never cut once its first datagram has left.
- Queue limit: if more than 2 whole frames wait, drop the waiting frames that have not started. Their ids then count as lost on that link, and the `Sender` requests a key frame for that link.

### 6.4 Control (`net/ctrl.rs`)

Plaintext header: `[0] u8 type`, `[1..5] u32 reliable seq` (0 = unreliable), then the body.

| Type | Body | Direction / rule |
|---|---|---|
| 1 Ping | u64 t1 | Both directions, every `PING_MS = 200` |
| 2 Pong | u64 t1, t2, t3 | Answer to a Ping at once. Gives RTT and clock offset (`clock::ClockSync`, min-RTT filter over 32 samples) |
| 3 Ack | u32 seq | Sent immediately for every reliable message |
| 4 FrameLost | u32 first, u32 last | Viewer → sharer, at once. Repeated every max(2 × RTT, 10 ms) until a key or after-RFI frame newer than `last` arrives; after 3 repeats, send a Keyframe request instead |
| 5 Keyframe | — | Viewer → sharer (decoder error, decoder configured). Repeated the same way |
| 6 Report | u32 frames, recovered, lost, packets expected, packets received, kbps; i32 delay trend µs/s | Viewer → sharer every 200 ms |
| 7 App | u16 length + UTF-8 (≤ 1000 bytes) | Reliable and in order. Retransmitted every max(2 × RTT, 20 ms). Unacked for 5 s → the link is dead |
| 8 Bye | u8 reason: 0 closed, 1 kicked, 2 ended | Sent 3× 20 ms apart, no ack |

App messages carry the **existing `CtlMessage` JSON** (`types.ts`): info, tx, paused, kick, bye, hello, rx. That lets NativeShare and NativeWatch reuse `parseCtl` and the same flows as the WebRTC data channel.

### 6.5 Rate (`net/rate.rs`)

**Starting target**
- The user's value is fixed and never changes.
- Auto is `lan_bitrate_kbps(w, h, fps, codec)`: 20 Mbit/s × pixels/1080p × (fps/60)^0.7, × 1.5 for H.264, clamped to 3000..100000 and rounded to 100. Rust and TypeScript share test vectors (`rate.rs` tests and `tests/rtc-nativelink.test.ts`).

**Auto back-off** (`RateCtl`)
- **When:** post-FEC frame loss above 2 % over 1 s, **or** the delay trend above 2 ms/s for 1 s.
- **Step:** × 0.8.
- **Recovery:** +5 % of the target per second.
- **Floor:** 50 % of the target.
- **Limit:** at most one change per 500 ms.
- A change becomes `EncoderRequest::Bitrate`.

### 6.6 Sender (`send.rs`)

- **New links:** a link added with `add_link` gets frames only from the next key frame on. Joins within 250 ms share one key frame.
- **Loss:**
  - `FrameLost` → `InvalidateRefs` only if **every** link of the sender has `rfi = true`, otherwise `Keyframe`;
  - at most one `Keyframe` per 200 ms, and requests during that hold merge into one at its end.
- **Rate:** reports → `RateCtl` (the minimum over the links) → `Bitrate`.
- **Threads:** `Sender` has no thread of its own.

### 6.7 Receiver (`recv.rs`, `frame::Reassembler`)

**No jitter buffer** for video:
- A frame is delivered when its k data shards are in, or when any k shards allow an RS decode (`recovered`).
- If a shard of a newer frame arrives while an older frame cannot be recovered, the older one is lost. `Lost{first,last}` covers the oldest missing id up to newest − 1.
- After a loss, delta frames are not delivered until a key frame or an after-RFI frame newer than the loss.
- Access units are delivered **in order** (a decoder needs every delta frame). "Newest wins" happens when the page draws.

**Delivery**
- Delivery runs on the `st-recv` thread through a queue of at most 8 access units.
- On overflow: drop the queue, wait for a key frame and request one.
- `VideoAu.age_us` = `now_us() − link.peer_to_local_us(capture_us)`, or 0 before the first pong.

**Audio**
- Packets are reordered within 20 ms. A missing 5 ms packet becomes silence.
- One `AudioBlock` (960 frames) goes out every 4 packets, or after 25 ms.

---

## 7. ICE-lite and fallback timing (NET `net/ice.rs`, `net/link.rs`; APP for the page timers)

**Socket and candidates**
- One `Endpoint` per app: a `socket2` dual-stack socket `[::]:0` with V6ONLY off; `0.0.0.0:0` if IPv6 is unavailable. Tests bind `127.0.0.1:0` (`EndpointConfig.loopback`).
- Host candidates: interface addresses (IPv4 private and public, IPv6 global or unique-local; no loopback, no link-local) with the socket's port.
  - Windows: `GetAdaptersAddresses`.
  - Unix: `getifaddrs` (libc).
- Server-reflexive candidates: an RFC 8489 Binding Request from the **same** socket to every `NetConfig.stun` entry (`stun:host[:3478]`).
  - Retransmit at 0, 250 and 750 ms; give up after 1.5 s.
  - Results are cached for 30 s. Late results go out as `LinkEvent::Candidates`.

**Probing**
- `set_remote` derives the keys and starts probing. The deadline (`DEADLINE_MS = 2500`) runs from there.
- Every remote candidate (at most 16) is probed every 20 ms.
- A valid probe is answered at once to its source address, which may be a new peer-reflexive one.
- The **first remote address whose reply arrives wins**, on each side independently.

**After the link is up**
- `PathInfo.lan` = `ice::is_lan`: the same /24 for RFC 1918 IPv4 addresses, the same /64 for IPv6.
- Pings every 200 ms also serve as keepalive. Nothing heard for 5 s → `Closed("timeout")`.

**Page timers** (APP, `nativelink.ts`)

| Timer | Value |
|---|---|
| Join re-send | every `NV_JOIN_MS = 1000` |
| No offer / wait after the first join | `NV_OFFER_TIMEOUT_MS = 4000` → WebRTC. A 'wait' cancels this timer while approval is pending |
| From the offer, no `up` | `NV_CONNECT_TIMEOUT_MS = 3500` → WebRTC. Rust's own 2.5 s deadline normally fires first with `fail` |
| From `up`, no key frame decoded | `NV_FIRST_FRAME_MS = 2000` → WebRTC |

Typical worst case on a LAN with blocked UDP: about 0.3 s of signaling plus 2.5 s, then WebRTC starts.

---

## 8. Rust API between `st-media` and the glue

Shared types live in `st-media/src/lib.rs` (frozen):
- `Codec { H264 = 1, Hevc = 2 }` (`name`, `from_name`, `from_u8`) and `Role { Share, Watch }`;
- `EncodedFrame`, `EncoderRequest { Keyframe, InvalidateRefs{first,last}, Bitrate{kbps} }`;
- `AudioChunk { seq, capture_us, pcm: Vec<i16> }` (240 frames = 5 ms);
- the constants `AUDIO_RATE`, `AUDIO_CHANNELS`, `AUDIO_PACKET_FRAMES`, `AUDIO_BLOCK_FRAMES`, `STM_VERSION`, `STM_MIN_VERSION`;
- `to_hex`, `parse_hex32`.

| Item | Owner | Used by APP for |
|---|---|---|
| `clock::{now_us, epoch_us}` (implemented), `clock::ClockSync` | NET | audio chunk timestamps |
| `net::link::{Endpoint, EndpointConfig, Link, LinkEvent, LinkSink, PathInfo, PacketHandler}` | NET | socket, links, events |
| `Endpoint::open(cfg)`, `port()`, `set_stun(v)`, `create_link(role, sink) -> Result<Arc<Link>>`, `link(id)`, `close()` | NET | |
| `Link::{id, role, key_half, local_candidates, set_remote(peer_link, peer_key, &cands), add_remote_candidates, send_message, path, stats, rtt_us, peer_to_local_us, close(ByeReason)}` | NET | `nm_link_*` |
| `LinkEvent::{Candidates, Up(PathInfo), Failed(String), Closed(String), Message(String), Stats(LinkStats)}` | NET | JSON events (§9.2) |
| `net::ice::{Candidate::parse(a, k), addr_string(), CandidateKind}` (implemented) | NET | candidates ↔ JSON |
| `net::ctrl::ByeReason` | NET | `nm_link_close` |
| `net::rate::lan_bitrate_kbps` (implemented) | NET | — (WIN uses it for Auto) |
| `send::{Sender::new(SenderConfig, RequestSink), add_link(&link, ViewerCaps{rfi}), remove_link, link_count, push_frame, push_audio, set_target(kbps, fixed), stats}` | NET | one per (share, codec) |
| `recv::{Receiver::attach(&link, RecvSink), request_keyframe, stats, close}`, `RecvEvent::{Video(VideoAu), Audio(AudioBlock)}` | NET | watch links |
| `stats::{LinkStats, RecvStats, SenderStats}` (serde, camelCase) | NET | JSON stats |
| `win::{probe() -> NvencCaps, parse_source, Source, CaptureConfig, CaptureSession::{start, request, request_handle, set_target, set_source, reconfigure, stats, stop}, CaptureStats, FrameSink}` | WIN | shares |

**Wiring a share codec** (APP):
1. Create a cell `Arc<OnceLock<Arc<Sender>>>`.
2. `CaptureSession::start(source, cfg, sink = |f| cell.get()?.push_frame(&f))`.
3. `Sender::new(SenderConfig{codec, target_kbps: stats().target_kbps, fixed: kbps > 0}, capture.request_handle())`, then set the cell.
4. Every second, forward a changed `stats().target_kbps` to `sender.set_target`.

---

## 9. Tauri commands and Channel messages (APP, `src-tauri/src/native_media.rs`)

### 9.1 Commands

Arguments are camelCase on the TypeScript side. The commands are registered on every OS, and the permission set is `allow-native-media`.

| Command | Arguments → result | Does |
|---|---|---|
| `nm_caps` | → `{v, min, share: {codecs, gpu} \| null, watch}` | `share` from `win::probe()` (Windows only). `watch = true` once NET works |
| `nm_link_open` | `role: 'share'\|'watch', stun: string[], events: Channel` → `{link, key, cand}` | Lazily opens the endpoint. Watch links also get a `Receiver` |
| `nm_link_remote` | `link, peerLink, key, cand` | `set_remote` |
| `nm_link_cand` | `link, cand` | late remote candidates |
| `nm_link_send` | `link, text` | App message (CtlMessage JSON) |
| `nm_link_keyframe` | `link` | `Receiver::request_keyframe` |
| `nm_link_close` | `link, reason: 'closed'\|'kicked'\|'ended'` | Bye, removes the link from its sender, forgets it |
| `nm_share_open` | `cfg {source, width, height, fps, maxHeight, kbps, audio}, events: Channel` → `share id` | `probe` + `parse_source`. Captures nothing yet. With `audio`, taps `sysaudio` |
| `nm_share_add` | `share, link, codec: 'hevc'\|'h264', rfi` | Starts that codec's capture and sender if needed, then `sender.add_link` |
| `nm_share_remove` | `share, link` | `sender.remove_link`. The last link of a codec stops that capture |
| `nm_share_update` | `share, cfg {fps, maxHeight, kbps}` | `reconfigure` / `set_target` on every capture of the share |
| `nm_share_source` | `share, source, width, height` | `set_source` on every capture |
| `nm_share_close` | `share` | Stops all captures and the audio tap |

**Share sound.** `sysaudio.rs` gets `pub fn set_tap(Option<Box<dyn FnMut(&[f32]) + Send>>)`, which is called with every 20 ms f32 chunk the page's capture produces.
- The glue converts each chunk to s16 and splits it into 4 × `AudioChunk`, with `capture_us = now_us() − 20 ms + i × 5 ms` and `seq` +1 each.
- It then calls `push_audio` on every sender of the share.
- Only while the page's sysaudio capture runs: there is no second WASAPI client.

### 9.2 JSON events

Link channel:

```
{t:'cand', cand:[{a,k}]}                       late local candidates → signal as 'nvice'
{t:'up', remote:'ip:port', lan:boolean, rttMs:number}
{t:'fail', reason:string}                      setup failed → page falls back
{t:'closed', reason:'bye'|'kicked'|'ended'|'timeout'|'closed'}
{t:'msg', m:string}                            App text (CtlMessage JSON)
{t:'stats', link:LinkStats, recv?:RecvStats}   every second while up
```

Share channel:

```
{t:'info', codec, encoder:'NVENC', gpu, width, height, fps, kbps}   whenever a capture (re)starts or resizes
{t:'stats', capture:CaptureStats[], senders:SenderStats[]}            every second while any capture runs
{t:'ended', reason:'closed'|'error'}                                  source window closed / capture failed
{t:'err', m:string}                                                   non-fatal, log only
```

### 9.3 Raw messages on watch links

These are little-endian. They are implemented and tested in `native_media.rs` (`video_message` / `audio_message`) and parsed by `parseNvMessage` in `nativelink.ts`.

```
video  [0] 1  [1] flags: 1 key, 2 FEC-recovered, 4 first after loss  [2] codec 1 H.264 / 2 HEVC  [3] 0
       [4..8] u32 frame id  [8..16] u64 pts µs (sender clock = WebCodecs timestamp)  [16..20] u32 age µs
       [20..24] u32 sender latency µs  [24..32] u64 wall clock µs at hand-over  [32..] Annex B
audio  [0] 2  [1] channels  [2] concealed 5 ms packets  [3] 0  [4..8] u32 seq  [8..16] u64 capture µs
       [16..] s16 interleaved, 960 frames
```

---

## 10. Signaling (APP; types in `src/types.ts`)

```ts
type NvCodec = 'hevc' | 'h264'
interface NvCandidate { a: string; k: 'host' | 'srflx' }               // "ip:port" | "[v6]:port"
interface NvLive { v: number; min: number; codecs: NvCodec[] }          // LiveInfo.nv (presence)
interface NvViewerCaps { v: number; min: number; dec: NvCodec[]; rfi: boolean; audio: boolean }
type NvNoReason = RejectReason | 'unavailable' | 'busy'
// SignalBody additions (always addressed, never broadcast):
| { t: 'nv'; k: 'join'; nid; origin; name; caps: NvViewerCaps; link: number; key: string; cand: NvCandidate[] }
| { t: 'nv'; k: 'offer'; nid; sid; codec: NvCodec; link; key; cand; hostName; fps: number; kbps: number; audio: boolean }
| { t: 'nv'; k: 'wait'; nid }
| { t: 'nv'; k: 'no'; nid; reason: NvNoReason }
| { t: 'nvice'; sid; cand: NvCandidate[] }
```

**Also new**
- `LiveInfo.nv?` is parsed by `parseLiveInfo` through `parseNvLive`.
- `InboundStats.transport?: 'native' | 'webrtc'`.
- `ViewerInfo.native?: boolean`.
- Ending a native link that is not up yet also sends the existing `{t:'bye', sid}`. A live link ends with Bye on the link itself.

**Validation**
- Everything from the wire goes through `parseNvLive`, `parseNvViewerCaps`, `parseNvCandidates` (at most 16, deduplicated), `isNvKey` (64 lowercase hex digits) and `isNvLinkId` (non-zero u32).
- `nid` and `sid` follow the same rules as `jid` (string, at most 64 characters).
- Versions must pass `nvVersionsMatch`. The codec comes from `chooseNvCodec`: HEVC when both sides have it, else H.264.

---

## 11. TypeScript (APP)

### 11.1 Sharer: `NativeShare` (`src/rtc/nativelink.ts`)

**Creation.** `TunnelSession.share()` creates the HostSession as today, then calls `NativeShare.create({room, host, stream, settings, hostName, net})` asynchronously.
- It returns `null` unless all of these hold: the app runs in Tauri, `nm_caps().share` is set, the track's `deviceId` is a window or screen, and `nm_share_open` succeeds.
- On success the tunnel stores it, calls `host.attachNative(ns)`, and presence then carries `live.nv = ns.live()`.

**On `nv` join**
1. Validate the join (§10). On a version or codec mismatch, answer `no` with `unavailable`.
2. Call `host.admitNative(from, name) → 'ok' | 'pending' | RejectReason`. The HostSession applies the same checks as a WebRTC join: banned, denied, locked, approval (asked once through `onJoinRequest`; the answer is picked up by the next re-sent join) and slots (WebRTC + native direct viewers ≥ maxDirect → `full`).
3. `pending` → answer `wait`. A reject → answer `no` with that reason.
4. `ok`:
   - if a link for (from, nid) already exists, re-send the same offer;
   - otherwise call `nm_link_open('share')`, `nm_link_remote`, `nm_share_add(codec, caps.rfi)`, then send the offer (`sid = randomId(8)`; fps and kbps from settings and the share's `info` event).
5. Link `cand` events become `nvice`.

**Link events**
- `up`: the viewer is connected. Send ctl `info` (with `codec: 'H264'` as a placeholder; the watcher takes the codec from the offer), then ctl `tx` every 2 s: `encoder: 'NVENC'`, `hw: true`, and `encodeMs`, `kbps`, `fps` from the share stats.
- `msg`: through `parseCtl` (hello, rx, bye).
- `fail` / `closed`: remove the viewer.

**Other duties**
- `viewers()` returns `ViewerInfo` with `native: true`.
- `kick`: ctl kick, then `nm_link_close('kicked')`.
- `updateSettings` → `nm_share_update`. `replaceStream` → `nm_share_source`; if the new track is not capturable natively, end the native links with `ended`, and the watchers fall back.
- `setPaused` → ctl paused. `stop` → ctl bye, `nm_link_close('ended')` for each link, `nm_share_close`.
- The share channel's `ended` (window closed) is handled like the web track's `ended`, through `main.ts` `watchTrack`, with no extra UI.

**HostSession additions** (`host.ts`)
- `admitNative`.
- `attachNative(n | null)`:
  - `viewers()` appends `n.viewers()`;
  - `connectedCount()` adds `n.connectedCount()`;
  - `kick(id)` also calls `n.kick(id)`;
  - native viewers count toward `maxDirect`.

### 11.2 Watcher: `NativeWatch` and `WatchSwitch`

**Choosing the session.** `TunnelSession.watch(id)` returns a `WatchSwitch` when `nativeLinkAvailable()` and `member.live.nv` is set; otherwise it returns a `ViewerSession` exactly as today.
- `WatchSwitch.start()` awaits `nativeWatchCaps()`, which is already implemented: HEVC only with hardware and not on WebKit, H.264 otherwise, `rfi: false`, and `audio` when `AudioWorkletNode` exists.
- If caps are missing, `nvVersionsMatch` fails, or `chooseNvCodec` returns `null`, it switches to WebRTC at once.
- Otherwise it starts `makeNative(caps)`.

**`NativeWatch` flow**
1. `nm_link_open('watch')`, then send `nv` join every 1 s; state `waiting`.
2. On the offer: `nm_link_remote`, state `connecting`.
3. On `up`: state `connected`, send ctl `hello`, then ctl `rx` every 2 s (children 0, canRelay false).
4. Video:
   - parse each raw message with `parseNvMessage`;
   - configure the `VideoDecoder` on the first key frame: H.264 from the SPS (`avcCodecString` from `native.ts`), HEVC with `NV_HEVC_CODEC`, `optimizeForLatency`, `prefer-hardware` (fall back to `no-preference` for H.264);
   - draw each output frame **at once** on a 2D canvas `{alpha: false, desynchronized: true}`, closing any older frame;
   - call `onRenderer(canvas)` after the first frame.
5. Decoder backlog (`decodeQueueSize > 2`) or a decoder error: drop deltas until the next key frame and call `nm_link_keyframe`. 3 errors within 5 s → fallback with reason `decoder`.
6. Audio:
   - an `AudioContext({sampleRate: 48000, latencyHint: 'interactive'})` feeds an `AudioWorkletNode` with a ring buffer: target 40 ms, re-prime 20 ms after an underrun, drop to 40 ms above 120 ms;
   - output goes to a `MediaStreamAudioDestinationNode`, and `onAudio(dest.stream)`, so the watch view's `<audio>` keeps volume and mute;
   - the worklet module is a static file (`src/rtc/pcmworklet.js` imported with `?url`), so the CSP stays unchanged;
   - call `ctx.resume()` on start and on the first pointer or key event.
7. Stats every second: an `InboundStats` with `transport: 'native'`, `codec: 'HEVC'|'H264'`, `connType` from `up.lan`, `rttMs`, `bitrateKbps`, `lossPct`, `decodeMs`, `jitterBufferMs: 0`, and `latencyMs = (ageUs + IPC + decode + draw) / 1000`.
8. Endings:
   - `no` with unavailable, busy or full; `fail`; or a timer from §7 → `onFallback(reason)`;
   - `no` with locked or denied → `rejected` (same mapping as `ViewerSession.onReject`); `no` with kicked → `kicked`;
   - `closed`: `kicked` → `kicked`; `ended` → `ended`; `bye` or `timeout` → `reconnecting`, then **one** native retry (new nid and link), then fallback.

**`WatchSwitch` fallback**
- Stop the NativeWatch: `nm_link_close('closed')`, plus `{t:'bye', sid}` if the link was not up.
- Call `onRenderer(null)`, build `makeWebRtc()`, re-bind every callback to the WebRTC session and start it.
- It switches at most once; "Erneut versuchen" in the watch view creates a fresh WatchSwitch.
- `upstreamAlive()` and `setName()` are delegated to the active session.

### 11.3 TunnelSession (`tunnel.ts`)

- **Dispatch (skeleton in place):** `nv` and `nvice` go through `routeNative` → `route()`, which tries the HostSession, then `this.native`, then the watch.
  - TODO(APP): an `nv` join for our origin while we share but not natively → `no` with `unavailable`, rate-limited like `reject`.
- `selfLive()` already adds `nv` from `this.native?.live()`.
- `stopSharing()` / `leave()` → `native.stop()`. `setName` → `native.setName`.
- `viewer` becomes `ViewerSession | WatchSwitch`.

### 11.4 UI

**Watch HUD (`src/ui/watch.ts`).** When `stats.transport === 'native'`, the `path` row shows one line:
`Nativ · HEVC · NVENC · 36 Mbit/s · RTT 1 ms`, built from `t('watch.hud.native')`, `codecLabel`, `tx.encoder`, `mbit(stats.bitrateKbps)` and `t('watch.hud.rtt')`. Everything else stays as it is.

**Viewer list (`tunnelview.ts`).** A small `t('tunnel.native')` tag for `ViewerInfo.native`, styled like the existing secondary text, with no new colour.

**i18n keys** (added, de/en): `watch.hud.native` (Nativ/Native), `watch.hud.rtt` (RTT), `tunnel.native` (nativ/native).

---

## 12. Test plan

All tests are headless.

**Commands**
- `cd src-tauri && cargo test --manifest-path st-media/Cargo.toml --target-dir target`
- `cargo test --lib`
- `npx tsc --noEmit`
- `ST_OFFLINE=1 npm test`
- `npm run e2e` (the WebRTC path must stay green)
- Cross checks:
  - `cargo check --manifest-path st-media/Cargo.toml --target-dir target --target x86_64-unknown-linux-gnu`
  - `CC_aarch64_apple_darwin=clang CFLAGS_aarch64_apple_darwin=--target=arm64-apple-macos11 cargo check --target aarch64-apple-darwin`
  - The full app cannot be checked for Linux on Windows: the GTK and GStreamer system libraries are missing there. CI covers it.

| Module | Owner | Tests |
|---|---|---|
| `wire` | NET | Round trip of every layout; STUN detection; truncated or inconsistent input → None; a small fuzz loop (random bytes never panic) |
| `crypto` | NET | Known-answer HKDF vector (fixed halves and ids → fixed keys, written into the test); seal/open round trip; tampered header, payload or tag → Auth; replay and too-old → Replay; epoch boundary at 2^24 (with keys derived both ways); the two roles derive mirrored keys |
| `fec` | NET | Any loss ≤ m of k + m recovers, for k in 1..100; odd lengths are rejected; a benchmark (`#[ignore]`) for 1–100 shards of 1144 B |
| `frame` | NET | Shard and reassemble at sizes 1 B … 900 KB; out-of-order shards; loss ≤ parity → `recovered`; loss > parity followed by a newer frame → `Lost{first,last}`; deltas blocked until a key frame |
| `ctrl` | NET | Encode/decode round trip; `Reliable` retransmits and orders, drops duplicates, `dead` after 5 s |
| `pace`, `rate`, `clock` | NET | Bucket timing; LAN vectors (done); back-off, recovery, floor, 500 ms limit, `fixed` never moves; ClockSync with synthetic asymmetric delays picks the min-RTT offset |
| `ice` | NET | STUN request/response byte vectors (RFC 5769 sample); candidate parsing (done); `is_lan`; Checklist deadline, peer-reflexive learning, first reply wins |
| `link`, `send`, `recv` | NET | `tests/loopback.rs`: two endpoints on 127.0.0.1, Up within the deadline, 300 synthetic frames under 1 % random and 5 % burst loss (a lossy shim in the test), App order, Bye, wrong key → Failed, keyframe-request path |
| `win::d3d` | WIN | `output_size` (done); Gpu + Converter + TestPattern on the real GPU, skipped without NVIDIA |
| `win::nvenc` | WIN | Skipped without NVENC: 120 test-pattern frames per codec; the first frame is key with VPS/SPS/PPS; no B-frames (POC order = decode order); a forced IDR works; `set_bitrate` sends no IDR; `invalidate` → after-invalidation frame; frame sizes stay near CBR |
| `win::capture` | WIN | `parse_source` (window part done); a `TestPattern` session end to end (sink receives frames at fps, repeat when static, requests honoured); `probe()` never panics. **No WGC test of a real window or screen** |
| pipeline | WIN | `st-media/tests/pipeline_win.rs` (cfg windows, skipped without NVENC): TestPattern → NVENC → Sender → loopback Link → Receiver; frames decode-order complete, key on join |
| glue | APP | `native_media.rs` message layouts (done); JSON shapes of the events |
| TS pure | APP | `tests/rtc-nativelink.test.ts` (done: validation, codec choice, message parsing, LAN vectors); add NativeShare and NativeWatch signaling flows against the fake room of `tests/rtc-tunnel.test.ts` (Tauri `invoke` stubbed): join → wait → offer, join → no → fallback to a ViewerSession, offer timeout → fallback, kick |
| E2E | APP | `npm run e2e` unchanged (browser, WebRTC). The native path in the real app is checked by the owner by hand |

---

## 13. Who edits what

Commit only your own files, with clear messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or tag, and never touch `.github/workflows`.

**NET**
- `src-tauri/st-media/src/clock.rs`, `stats.rs`, `send.rs`, `recv.rs`;
- `src-tauri/st-media/src/net/` — every file, plus new ones in that folder;
- `src-tauri/st-media/tests/loopback.rs` and new `tests/net_*.rs`.

**WIN**
- `src-tauri/st-media/src/win/` — every file, plus new ones (e.g. `prio.rs`);
- `src-tauri/st-media/tests/pipeline_win.rs` and new `tests/win_*.rs`;
- in `src-tauri/st-media/Cargo.toml`, only *adding* features to the `windows` entry (NET may do the same for
  networking and timer features).

**APP**
- Rust: `src-tauri/src/native_media.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/sysaudio.rs` (the `set_tap` hook only), `src-tauri/build.rs`, `src-tauri/permissions/native_media.toml`, `src-tauri/permissions/autogenerated/nm_*.toml` (generated), `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (CSP only if the worklet really needs it).
- TypeScript: `src/rtc/nativelink.ts`, `src/rtc/tunnel.ts`, `src/rtc/host.ts` (`admitNative`, `attachNative`), `src/rtc/viewer.ts` (only if needed), `src/types.ts` (additive only), `src/main.ts`, `src/ui/watch.ts`, `src/ui/tunnelview.ts`, `src/ui/format.ts` (`codecLabel` for 'HEVC'), `src/i18n.ts`, `src/styles.css`, new `src/rtc/pcmworklet.js` and other new `src/rtc/native*.ts` files.
- Tests and docs: `tests/rtc-nativelink.test.ts`, `tests/rtc-tunnel.test.ts` (additions), `docs/NATIVE-PATH.md`, `docs/ARCHITECTURE.md`, `README.md`.

**Frozen (nobody)**
- `src-tauri/st-media/src/lib.rs`, except removing the skeleton `#![allow(…)]` lines in your own files.
- The signatures listed in §8.
- `src-tauri/st-media/Cargo.toml` dependencies. Nobody adds crates; the lockfiles change only through cargo.

**Changing the contract**
- You may add (never change or remove) `pub` items inside your own modules.
- If a frozen item is not enough, work around it inside your module. Append one line to §14 saying what you would change and why, so the lead can merge it later.

---

## 14. Change log

Append only, one line each: date, owner, change.

- 2026-10-28 lead: contract and compiling skeleton.
- 2026-10-28 NET: transport implemented. Added (additive) `PacketHandler::on_tick` (default no-op: the sender's and receiver's timers), `Link::{send_frame, set_pace_target, is_up, clear_handler}`, `RecvStats.framesDropped` (the page fell behind; not counted as lost), `CompleteFrame.first_us`, `Reassembler::{require_key, skipped}`. Auth-failure buckets are per source ip:port and never throttle a link's own peer (a spoofer must not cut the link). Wish for the lead: an `opt-level` for dependencies in st-media's dev profile, so debug-build tests measure the transport rather than unoptimized AES-GCM / Reed-Solomon (loopback push → delivered p50 ≈ 6–30 ms in debug vs 0.3–0.6 ms in release).
- 2026-10-28 WIN: `resolve_screen` step 2 uses Chromium's own id (the `EnumDisplayDevicesW` index → current mode rect → `MonitorFromRect`, as libwebrtc's `GetHmonitorFromDeviceIndex`) instead of the `EnumDisplayMonitors` position, and every answer must match the track's aspect ratio; a positional guess could share the wrong monitor.
- 2026-10-28 WIN: static content repeats after 2 intervals of silence and then every interval (the encoder keeps its fixed fps), not every 2 intervals; repeats carry `capture_us` = the time of the repeat.
- 2026-10-28 WIN: `Bitrate` requests are clamped to the current target and ignored while the user's bitrate is set by hand (second guard behind `RateCtl`'s `fixed`).
- 2026-10-28 WIN: ten encode errors in a row rebuild the capture on a fresh device (frame ids continue, next frame IDR); if that fails, or after 3 rebuilds, the capture ends like a closed window (`stats().closed = true`), because `CaptureStats` has no error field. Wish: `failed: bool` in `CaptureStats` → `{t:'ended', reason:'error'}`, so the page falls back to WebRTC instead of treating it as a closed window.
- 2026-10-28 WIN: added public items: `Encoder::{supports_invalidation, intra_refresh, reopen}` (intra refresh enabled where the GPU has it, one wave of 10 frames on request, never periodic; unused until a viewer can recover from it), `CaptureSession::pause_pattern` (tests), `WgcCapture::set_min_interval`, `d3d::{letterbox, bgra_texture, nv12_texture, texture_size}`, module `win::prio`.
- 2026-10-28 WIN: borderless capture is only `SetIsBorderRequired(false)`; `GraphicsCaptureAccess::RequestAccessAsync(Borderless)` is not called (it may need consent UI on some builds), so the yellow border can stay where Windows insists on it.
- 2026-10-28 APP: `NativeShare` calls `nm_share_add` **before** `nm_link_remote` (§11.1 step 4 lists them the other way): starting NVENC must not eat the 2.5 s probe deadline that `set_remote` starts.
- 2026-10-28 APP: a new source Rust cannot capture ends the native links with Bye **"closed"**, not "ended" (§11.1): "ended" would show "Stream beendet" (§11.2 step 8); with "closed" the watchers retry once, get `no unavailable` (the NativeShare drops `live.nv` and refuses joins until a capturable source comes back) and continue over WebRTC.
- 2026-10-28 APP: `NativeShare.create` returns null when the share has sound that does not come from the app's own capture (`nativeShareAudioSupported()` false): native watchers would hear nothing, so such a share stays on WebRTC.
- 2026-10-28 APP: a `WatchSwitch` fallback never sends the sid-less signaling bye (only `{t:'bye', sid}` for a link that never came up): the sid-less one can overtake the WebRTC join on another broker and make the HostSession drop that new peer. Stopping the watch while still joining sends it as before.
- 2026-10-28 APP: `HostSession.admitNative` reuses the WebRTC approval: a native request is a `PendingJoin` with `native: true`; the decision is picked up by the next `nv` join (no WebRTC reject / peer for it); a WebRTC join of the same watcher turns it into a normal request. `HostSession.updateSettings` / `replaceStream` / `setPaused` hand the change on to the attached NativeShare, so `main.ts` needs no native code.
- 2026-10-28 APP: the glue keeps `win::CaptureSession`, `send::Sender`, `net::Link` / `Endpoint` and `recv::Receiver` in global `Mutex` maps and moves them into blocking tasks: they must be `Send` (and the `Arc`ed ones `Sync`). WIN/NET: please keep it that way.
- 2026-10-28 APP: `nm_caps` reports `watch: true` (NET's transport is assumed present after the merge); `ST_NATIVE=0` makes it report no native support at all (comparisons, escape hatch).
- 2026-10-28 APP: test knobs: `NativeWatchOptions.timing` / the TunnelSession extra `nvTiming` (shorter page timers), `setNativeBackend()` (fake Rust side). Headless page test: `node tests/e2e/native-decode.mjs` (H.264 always; HEVC only where headless Edge can encode it — on this PC it cannot).
- 2026-10-28 APP: the BSD-3-Clause notice of Leopard-RS (`reed-solomon-simd`) is in README.md ("Lizenzen von Drittanbietern"); an in-app licences page does not exist yet — the installer does not carry the notice.

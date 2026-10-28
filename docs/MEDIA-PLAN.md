# StreamTunnel media path: final architecture and implementation plan (Parsec-class)

Status: final plan from the lead architect, 2026-10-28. The repository is `main` at `e163024`.

**Inputs**
- The 8 research reports, the draft and the two reviews.
- The repository, read today: `src/rtc/tuning.ts`, `src/rtc/defaults.ts`, `src/rtc/lowlat.ts`, `src/rtc/native.ts`, `src/rtc/sysaudio.ts`, `src-tauri/Cargo.toml`, `src-tauri/tauri*.conf.json`, `src-tauri/linux-media/src/lib.rs`, `docs/ARCHITECTURE.md`, `README.md`, and git log back to `5f9f467`.
- The asset sizes of GitHub release v0.1.4 (`gh release view`).
- Re-checked against primary sources today: WebKit's `RTCDefaultVideoDecoderFactory.m` [101] and Apple TN3179 [108]. Everything else comes from the research JSON and the reviews, with their primary sources cited.

**Conventions**
- **Estimate:** my own engineering estimate.
- **Target:** an acceptance threshold chosen by design.
- **UNVERIFIED:** no primary source confirmed the claim.
- **Native path:** the new Rust media path. Its wire protocol is called `stm/1` internally. The UI never names it, because "Direkt" is already a connection-kind label ("Lokal / Direkt / Relay").

---

## 1. Executive summary

### 1.1 What has already shipped since the research started

- **`7055cb2`:**
  - LAN fixed rate, Moonlight-like. `effectiveBitrateKbps` in `src/rtc/defaults.ts` computes 20 Mbit/s × (pixels ÷ 1080p) × (fps/60)^0.7, H.264 × 1.5, clamped by `LAN_BITRATE_MAX_KBPS = 100000`. That gives 1080p60 20, 1440p60 ≈ 36, 1440p120 ≈ 58 and 4K60 80 Mbit/s for HEVC/AV1.
  - `preferH264High()` in `src/rtc/tuning.ts`.
- **`e163024`:** `degradationPreference = 'maintain-framerate-and-resolution'`.
- **`c0db83f`:** the fast receive path (RTCRtpScriptTransform → WebCodecs → canvas). Same-LAN `x-google-min-bitrate` = 0.8 × max.
- **Linux viewer:** the webrtcbin jitter latency can already be set (`latency_ms` in `linux-media/src/lib.rs`).

### 1.2 Why it is 77–140 ms and why it fluctuates

On a LAN the wire costs about 1 ms. One Ada NVENC engine encodes 1080p at P1 low latency at 910 fps (H.264), 1055 (HEVC) and 1090 (AV1) [12]. The time is lost in the webview pipeline.

**1. Windows to an M1/M2 Mac runs on software OpenH264, and this follows from the code.**
- WKWebView's libwebrtc receive factory advertises only H.264 Constrained High and Constrained Baseline [101] (re-checked today).
- Chromium's hardware encoder factory offers Baseline, Main and High (High = `64…`) and derives Constrained Baseline from Baseline [103].
- libwebrtc matches H.264 formats by exact profile [102]. High is not Constrained High, so the only profile both sides share is Constrained Baseline.
- Chromium's Media Foundation encoder skips NVIDIA for constrained-baseline H.264 (crbug 1088650) [32]. The result is OpenH264.
- So `preferH264High()` from `7055cb2` does nothing for Mac viewers: the Mac's answer has no High payload type to move forward.
- HEVC is not an option today: WebView2 does not offer H.265 for sending (Microsoft Q&A [34]; measured on 155 in `docs/ARCHITECTURE.md` §5.1).
- AV1 is not an option on M1/M2, which cannot decode it [54].
- One log line (Phase 0) confirms the answer SDP. If the owner's Mac is an M3 or later, hardware AV1 already works today; Phase 0 logs the model.

**2. Software encoding is the likely source of the fluctuation (hypothesis).**
- On the same LAN, the bandwidth estimate is pinned to 80–100 % of the target, so rate swings are bounded.
- OpenH264 at 1440p60 is expected to hit libwebrtc's CPU limitation (`qualityLimitationReason = 'cpu'`). The stats panel already shows this as `lim` (since `5f9f467`).
- Since `e163024` resolution and fps are held, so overload now shows up as dropped frames and QP pumping rather than downscaling (inference).
- Phase 0 step 0 reads `lim`.

**3. Pacing.** libwebrtc paces video at 1.1 × the target rate (`kStrictPacingMultiplier` in `video_send_stream_impl.cc`, field trial `WebRTC-Video-Pacing`) [107]. A large frame therefore needs most of a frame interval to leave the sharer.

**4. Presentation.**
- The fast path draws with Canvas2D `drawImage` (`src/rtc/lowlat.ts:54,99`). It requests `desynchronized: true`, but DOM overlays sit above it, and that rules out the bypass [89].
- The webview compositor plus the OS compositor cost roughly 1–3 refresh intervals (estimate, UNVERIFIED).

**5. Relays re-encode**, adding 20–40 ms per hop (`docs/ARCHITECTURE.md` §1).

**The Parsec reference, read correctly**
- Parsec adds about 7 ms on a LAN [1]. That was measured with a 240 Hz DIY rig and client V-Sync off [121].
- Its 240 fps test had the client two frames behind with V-Sync on, about 4–8 ms in total, explicitly "not meant for the real world" [4].
- Neither number is a 60 Hz target. At 60 Hz one refresh is already 16.7 ms, so about 20–35 ms glass to glass is Parsec-class for this owner (estimate).
- Parsec itself says WebRTC "doesn't cut it" for demanding streaming [7].

### 1.3 Decision

Links between two StreamTunnel apps move to a native Rust media path, a new workspace crate `st-media`:
- native capture;
- hardware encode only (no software encoder in this path);
- a small authenticated, encrypted UDP protocol `stm/1` modelled on Parsec's BUD [2][120] and Sunshine/Moonlight [18][23]: per-frame Reed-Solomon FEC, reference-frame invalidation (RFI) where the decoder supports it, a fixed rate on the LAN, no jitter buffer;
- hardware decode plus a native Metal presenter on the Mac.

The webview becomes UI only, except on Windows and Linux viewers, where WebCodecs inside the page stays the decoder.

**Phase 0 comes first.** It spends days trying to get hardware H.264 into today's path for Windows to Mac, applies cheap renderer and pacing fixes, and measures. A go/no-go gate follows.

**What stays unchanged**
- The Tauri shell and the HTML UI.
- MQTT room signalling with codes and end-to-end AES-GCM.
- The members list.
- WASAPI process-loopback share audio (`src-tauri/src/sysaudio.rs`), which now also feeds the native path directly.
- Viewer relays, which become *cut-through forwarders* (no re-encode).
- The WebRTC path, kept permanently as "Kompatibel". The browser edition `StreamTunnel.html`, Intel Macs, older app versions and links where no native path forms all need it. It is not "retired".

### 1.4 Expected results (estimates and targets, not measurements)

| | Today (owner) | After Phase 0 | After Phase 1a: native Win to Mac, LAN | After Phase 3: Mac "V-Sync aus", fullscreen |
|---|---|---|---|---|
| Wired LAN, 1440p60, glass to glass p50 | 77–140 ms | measured. Target ≤ 60 ms *if* hardware H.264 negotiates | **target ≤ 40 ms** (estimate 25–45) | **target ≤ 30 ms**, only fullscreen with the webview hidden |
| Mac on Wi-Fi, p95 | n/a | measured | target ≤ 70 ms, ≤ 1 % late frames | — |
| Internet, direct P2P | legacy | legacy | Phase 1b: LAN p50 + one-way delay + ≤ 1 frame | same |
| Quality | software H.264, CPU-limited (hypothesis) | hardware H.264 High if experiment A works | hardware HEVC at a fixed ≈ 36 Mbit/s, RFI on loss, static text refines | same |
| Windows setup | 1.12 MB | 1.12 MB | ≈ 1.5–2 MB (estimate) | ≈ 2–2.5 MB (estimate) |
| Mac dmg | 1.42 MB | 1.42 MB | ≈ 2–2.5 MB (estimate) | ≈ 2.5–3.5 MB (estimate) |

### 1.5 Owner decisions this plan needs

None of these touches "small / Tauri / no host / no Electron".

1. **Apple Developer ID and notarization** (about $99/year [110], amount UNVERIFIED in this run).
   - TN3179 says local-network privacy tracks the app by code signature. To track it reliably, the app must be signed with "an Apple-issued code-signing identity" [108].
   - Mac builds are unsigned today, and macOS Sequoia removed the Control-click Gatekeeper override [109].
   - Recommended before Phase 1a ships. If declined, Phase 1a tests and documents the re-prompt behaviour after updates.
2. **Auto-update** with `tauri-plugin-updater` [117]: a GitHub Releases manifest, no server, a minisign key. Recommended. Rooms with mixed versions otherwise fall back to the slow path.
3. **Windows installer mode.** Keep `installMode: currentUser` (default; it cannot add firewall rules), or switch to perMachine with a UAC prompt. Recommendation: stay per-user (§2.9).

---

## 2. Target architecture

### 2.1 Overview

```
 SHARER (Rust, st-media)                                               VIEWER (Rust, st-media)
 capture ─GPU─► encode ─► shard + FEC + AEAD + pace ─UDP stm/1─► reassemble / FEC ─► decode ─► present
   WGC / SCK /   NVENC / MF /                                       no jitter buffer    VideoToolbox   CAMetalLayer (Mac)
   portal+PW     VideoToolbox / VA                                  FrameLost → RFI/IDR WebCodecs      WebGL2 canvas (Win/Linux)
 WASAPI / CA tap / PipeWire ─► PCM (LAN) or Opus ──────────────────────────────────► cpal playout
        ▲                                                                             │
        │ Noise handshake + caps + candidates: opaque blobs inside the                 │ stats line, settings
        └──── existing E2E-encrypted MQTT room (TypeScript) ◄──────── HTML UI (webview) ┘
 relay member: forward each shard on arrival (cut-through), re-encrypt per child, forward FEC-recovered shards
 "Kompatibel": the existing WebRTC path (webview / webrtcbin) for browser members, Intel Macs, old versions
```

### 2.2 What lives where

| Concern | Webview (TypeScript) | Rust (`st-media`, Tauri commands) |
|---|---|---|
| Room, code, E2E MQTT, members, presence | **stays** (`src/signaling/*`, `src/rtc/tunnel.ts`) | — |
| Session negotiation | carries opaque `nv` blobs in join/offer/answer and `nvice` candidate batches; derives the media PSK in `src/core/crypto.ts` | creates and parses the blobs (Noise handshake, caps, candidates) |
| Source choice (Windows, Phases 1–2) | **existing picker + getDisplayMedia**; the HWND comes from the track (`hwndOf()` in `src/rtc/sysaudio.ts` already parses `window:<hwnd>:0`) | WGC capture of the same HWND or monitor |
| Capture, encode, transport, FEC, crypto, pacing, rate | — | **all** |
| Decode and present | Windows and Linux viewers: WebCodecs → WebGL2 in a worker (Phases 2 and 4) | Mac viewer: VideoToolbox + CAMetalLayer (Phase 1a) |
| Audio | — | capture, PCM or Opus, playout |
| Stats | renders one German line plus "Details" | measures every stage |
| Legacy "Kompatibel" | `src/rtc/host.ts`, `src/rtc/viewer.ts` | `linux-media` (webrtcbin) until Phase 5 |

### 2.3 Sender per OS

#### Windows (Phase 1a: NVIDIA; Phase 2: AMD/Intel)

Uses the `windows` 0.62 crate, already in Tauri's tree [60] (`wasapi` 0.26 and `windows-sys` 0.61 are already direct dependencies).

**Source.** The share starts exactly as today: the picker, then getDisplayMedia.
- When the first native viewer connects, `st-media` starts WGC on the same source.
- A window comes from `IGraphicsCaptureItemInterop::CreateForWindow(hwnd)`, where the HWND is parsed from the track's `deviceId` (the existing `hwndOf()`).
- A monitor comes from `CreateForMonitor` [40]. Mapping Chromium's `screen:<id>:0` to an `HMONITOR` is UNVERIFIED. Match by size and position, and show a small German list once only when that is ambiguous.
- **Benefit:** no new picker, no second prompt, and legacy viewers keep the webview track.
- **Cost:** in mixed rooms, two captures and two encoders run.

**Capture**
- Frame pool: `Direct3D11CaptureFramePool::CreateFreeThreaded`, 2 buffers, BGRA8; the newest frame wins [19].
- `MinUpdateInterval` = 4 ms (Sunshine's 250 Hz [19]) on build ≥ 26100. The owner runs 26200. One report says values below 1 ms give about 50 fps [98].
- `IncludeSecondaryWindows(true)` [38] and `IsCursorCaptureEnabled(true)`.
- Border: call `IsBorderRequired(false)` directly, as Sunshine does [19][39]. Verify on the owner's PC whether the border disappears for the unpackaged exe (UNVERIFIED).
- Each frame is copied (`CopyResource`) into a ring of 3 textures registered with NVENC, because WGC recycles its surfaces [19].
- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on StreamTunnel's own window for monitor shares [46].

**Window lifecycle**
- `ContentSize` changes: `Recreate` the pool, then `NvEncReconfigureEncoder` to the new size within `maxEncodeWidth/Height` plus one IDR [11].
- Minimized: WGC delivers nothing, so the sender keeps sending a German placeholder frame, "Fenster ist minimiert".
- `Closed` event: the share ends.
- DRM-protected content comes out black; say so in German.

**HDR and colour**
- Detect HDR outputs from `DXGI_OUTPUT_DESC1.ColorSpace` [124].
- Phase 1a only warns in German ("HDR ist an – Farben können blass wirken"). An FP16 pool plus a tone-map shader, as Sunshine does with `R16G16B16A16_FLOAT` [19], is in Phase 5.
- Signal BT.709 limited range explicitly in the VUI. The Mac shader honours it.

**GPU**
- One D3D11 device (`D3D11_CREATE_DEVICE_VIDEO_SUPPORT`) on the adapter that owns NVENC.
- On hybrid laptops WGC works across GPUs (OBS, research). Desktop Duplication does not [20].

**Encoder: NVENC directly**
- `LoadLibrary("nvEncodeAPI64.dll")`, then `NvEncodeAPIGetMaxSupportedVersion`, then `NvEncOpenEncodeSessionEx(DIRECTX)` [11][15].
- Bindings: bindgen output of the MIT header, committed. Use the oldest header version that has the needed features, because the SDK 13.1 headers need driver 610 or newer [15].
- Input in Phase 1a is BGRA as `NV_ENC_BUFFER_FORMAT_ARGB` [15]. NVIDIA says RGB input uses CUDA internally [11]. Phase 1a therefore measures ARGB against our own HLSL BGRA→NV12 pass under 100 % GPU load and keeps the faster one.
- Settings in §3.3.

**Steadiness.** All of these are best-effort. Each call's success is logged.
- `D3DKMTSetProcessSchedulingPriorityClass(HIGH)`, never REALTIME: REALTIME freezes NVENC with HAGS on [20]. Without elevation the call may fail [20].
- `IDXGIDevice::SetGPUThreadPriority(7)`, same caveat.
- MMCSS on the capture, encode and send threads; `CreateWaitableTimerExW(HIGH_RESOLUTION)` for pacing [47].
- While sharing: `SetProcessInformation(ProcessPowerThrottling)` with ControlMask = `EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION` and StateMask = 0. Otherwise Windows 11 may throttle a minimized, silent process and ignore its timer resolution [116].
- When the GPU is saturated, a German hint: "Begrenze die Bildrate des Spiels knapp unter die Bildwiederholrate" (Sunshine and Moonlight give the same advice).
- Static content: WGC delivers nothing, so the last texture is re-submitted at ≥ fps/2 (Sunshine's minimum [21]), and at full fps in "Text/Code".

**Audio.** `sysaudio.rs` feeds `st-media` directly (no page round trip).

#### macOS, Apple silicon (sender in Phase 3)

Uses the `objc2-*` 0.3.2 crates, the same family wry already ships [59][60]. No Swift toolchain.

- **Capture: ScreenCaptureKit.**
  - `SCContentSharingPicker` (macOS 14+) [52]. Whether it avoids Sequoia's monthly re-approval is UNVERIFIED; test it in the signed build.
  - `SCContentFilter(desktopIndependentWindow:)`, pixel format 420v, `minimumFrameInterval` = 1/fps, `queueDepth` 5. Release each surface within `minimumFrameInterval × (queueDepth − 1)` [51].
- **Encode: VideoToolbox.**
  - `EnableLowLatencyRateControl` [49] plus `RequireHardwareAcceleratedVideoEncoder`.
  - HEVC low-latency is shown only by FFmpeg's arm64 gate [50]. If the session fails (-12902), fall back to `RealTime`, `AllowFrameReordering = false` and `MaxFrameDelayCount` 1–3.
  - LTR with acknowledged tokens [49].
- **Audio:** Core Audio process taps (macOS 14.2+), plus `NSAudioCaptureUsageDescription` [53].
- **App Nap:** hold `NSProcessInfo beginActivityWithOptions(UserInitiated | LatencyCritical)` while sharing (effect UNVERIFIED).
- **Legacy viewers:** until Phase 5, a legacy viewer of a Mac share needs a second getDisplayMedia capture (one more picker click, explained in German).

#### Linux, CachyOS/Arch (sender in Phase 4)

GStreamer from the system only; the repo already uses gstreamer-rs in `linux-media`.

- **Capture:**
  - `ashpd` 0.13 ScreenCast with `PersistMode::ExplicitlyRevoked`. The restore token is single-use, so store the new one each time, per `XDG_SESSION_DESKTOP` [64][65].
  - `pipewiresrc fd=… target-object=… keepalive-time=<1000/fps> ! queue max-size-buffers=1 leaky=downstream` [66].
- **Encode, AMD/Intel:**
  - `vapostproc ! vah265enc rate-control=cbr b-frames=0 ref-frames=1 key-int-max=1024 cpb-size=<1 frame>`.
  - `key-int-max=0` would mean an IDR *every second*, and the GOP is capped at 1024 [113]. So use 1024 and force IDRs on demand with `GstForceKeyUnit`, rate-limited.
  - vah265enc has no RFI, intra-refresh or LTR properties, so loss recovery on VA is IDR-only, with higher FEC.
- **Encode, NVIDIA:**
  - `nvh265enc preset=p1 tune=ultra-low-latency rc-mode=cbr zerolatency=true bframes=0 gop-size=-1` [69].
  - Always keep a tested system-memory `cudaupload` fallback, because `glupload` rejects NVIDIA block-linear DMA-BUFs [70].
- **Rule:** check every "infinite GOP" setting against the element's source code, not its docs.
- **Audio:** a private PipeWire null sink with the chosen app's nodes linked in, as venmic does [75].

### 2.4 Transport

One `st-media::net` module: a sans-IO core plus a thread driver, identical on all OSes. The design is in §4.

### 2.5 Receiver per OS

| OS | Decode | Present | Phase |
|---|---|---|---|
| **macOS** (owner's viewer) | `VTDecompressionSession`, synchronous, no `1xRealTimePlayback` flag, IOSurface NV12 output [29]. Annex B is converted to length-prefixed NAL units; the format description is built from the HEVC parameter sets. `VTIsHardwareDecodeSupported` fills the caps [29] | **One presenter:** `CAMetalLayer` + `CVMetalTextureCache` (zero copy), BT.709-limited YUV→RGB shader compiled at runtime. Pacing: `CAMetalDisplayLink(preferredFrameLatency = 1)` with a single newest-frame slot on macOS 14+ [28][58]; otherwise present on decode with `displaySyncEnabled = true` | 1a |
| macOS "V-Sync aus" | same | `displaySyncEnabled = false` [28]. Only helps with direct display, so the WKWebView is hidden while the overlays are faded out (UNVERIFIED) | 3 |
| macOS fallback | — | The legacy WebRTC path. There is no WebCodecs-over-IPC fallback, because WebKit's WebCodecs HEVC is broken (bug 262950, open [61]) | 1a |
| **Windows** | WebCodecs in WebView2. HEVC through WebCodecs is UNVERIFIED, so it is decided by a runtime test decode | WebGL2 in a worker `OffscreenCanvas`, newest-frame mailbox | 2 |
| Windows native (optional) | MF H.264 decoder MFT or D3D11VA [100] | child HWND, `FLIP_DISCARD`, `Present(0)` (+ `ALLOW_TEARING` for "V-Sync aus"), no `SetMaximumFrameLatency(1)` [27][45] | 5, only if measured |
| **Linux** | WebCodecs in WebKitGTK. 2.54 keeps hardware frames in DMABuf/GL [72] | WebGL2 canvas. A native layer under a GTK3 webview is "not planned" in Tauri [84] | 4 |

**Why one Mac presenter.** Moonlight's current Mac default is libplacebo or Metal; it uses `AVSampleBufferDisplayLayer` only when the user picks it explicitly [30]. libplacebo/MoltenVK is too heavy for the size budget. So build the Metal presenter once. `AVSampleBufferDisplayLayer` with `DisplayImmediately` [56][57] is the fallback only if the Metal spike fails in week 1.

**Delivering access units into WebCodecs (Windows and Linux).**
- Not through a Tauri `Channel`. Payloads of 1024 bytes or more go through an `eval` on the page's main thread followed by a fetch [114], which is a source of per-frame jitter.
- Instead, the decoder worker opens a WebSocket to `127.0.0.1` on a random port, with a per-session token and `connect-src` in the CSP. Whether this works in all three webviews is UNVERIFIED, so Phase 2 starts with a spike.
- WebView2 shared buffers are an alternative (UNVERIFIED for workers).
- The `Channel` carries stats only.

**Receive rules, from Moonlight [23][26]**
- No jitter buffer for video.
- Decode the moment a frame is complete or recoverable through FEC.
- When a newer frame starts and the old one cannot be recovered, abandon the old one and send `FrameLost`.
- Keep a newest-frame mailbox with at most 1 queued frame. Allow 2 only if the queue history of the last ~500 ms shows bursts.

### 2.6 How the HTML UI stays on top of the video

**macOS (Phase 1a)**
- `with_webview → inner()` gives the WKWebView. Insert the video `NSView` with `[[wk superview] addSubview:video positioned:NSWindowBelow relativeTo:wk]`.
- The view fills the content area through its autoresizing mask, and `hitTest` returns nil, like Moonlight's `VTView` [29]. Input keeps going to the webview above it.
- Both config files (`tauri.conf.json` and `tauri.macos.conf.json`) set `backgroundColor: #0B0B0C` today. **Only while watching**:
  - make the webview background transparent at runtime (on macOS, wry uses the `drawsBackground` key [87]);
  - make html, body and the watch container transparent.
- The window itself can stay opaque, because the video view covers the content area.
- Aspect-fit happens in the Metal shader. No rectangle sync is needed, because the watch view is full-window (`docs/ARCHITECTURE.md` §6.1).
- **Day-1 spike in a bundled `.app`**, because tauri #13415 reports white instead of transparent in bundled builds [93].

**Windows and Linux (Phases 2 and 4).** The video is a canvas inside the page, so the overlays sit above it naturally. Use `desynchronized` only while the overlays are hidden [89].

**Windows native (Phase 5, optional)**
- The swap chain lives on a child HWND below the WebView2. The WebView2 background alpha must be 0, and the parent must not have `WS_CLIPCHILDREN` [87].
- In fullscreen, when the overlays fade out, hide the WebView2 so independent flip becomes possible. Verify with PresentMon [45][88].

### 2.7 Audio

- **Phase 1a (LAN):** PCM s16, 48 kHz stereo, in **5 ms packets** (960 B payload; 10 ms would be 1920 B and exceed the MTU). Reed-Solomon 4+1 per 20 ms block, about 2 Mbit/s including headers (arithmetic).
- **Phase 1b:** Opus with 10 ms frames for non-LAN links. It needs a C build of libopus (crate version UNVERIFIED).
- **Playout:** `cpal` 0.18.2, which reuses `windows` ^0.62 and `objc2` ^0.6 [118], with an adaptive 20–40 ms buffer (target; Parsec uses 50–100 ms [10]).
- **Sync:**
  - Shared sender capture clock. By default video never waits for audio.
  - Query the output latency (Core Audio device latency plus safety offset; WASAPI stream latency).
  - If it exceeds 60 ms (design choice; Bluetooth headphones, magnitude UNVERIFIED), show a German hint and an opt-in "Bild an Ton angleichen" that delays the video.

### 2.8 Control and stats

**Per-frame header:** frame number, sender capture time in µs, and sender processing latency in 0.1 ms units, as Sunshine does [18].

**Control messages**, acked and retransmitted until acknowledged:
- Ping/Pong every 100 ms (RTT and an NTP-style clock offset with a min-RTT filter);
- receiver report every 100 ms;
- `FrameLost{first, last}`, `RequestIdr`, `SetRate`, `Caps`, `Bye`.

**Overlay**, following the owner's "no clutter, streams first" rule:
- Default is one line, for example `24 ms · 60 FPS · HEVC Hardware · 36 Mbit/s · Kabel`.
- A "Details" toggle shows: Aufnahme, Komprimieren, Netz (RTT), Empfang, Entpacken, Warteschlange, Anzeige, Gesamt (p50/p95), Bilder verloren (Netz / zu spät), FEC repariert, Übertragung: *Schnell* / *Kompatibel*.
- Words not allowed in the UI, per `docs/ARCHITECTURE.md` §9.6: Host, Broker, Encoder, Hops, Signaling.

**Measurement log**
- Off by default; switched on with "Messung aufzeichnen" in Details.
- One CSV per session in Tauri's app log directory. Keep the last 5 files, at most 50 MB each (design choice).

### 2.9 Permissions, signing, updates and first run (all in German)

| OS | Item | Plan |
|---|---|---|
| macOS 15+ | **Local Network privacy** [108] | Sending UDP unicast to a LAN address needs it; *receiving* does not. WKWebView traffic is exempt, which is why today's path never prompts. Command-line tools started from Terminal are allowed automatically, so `cargo tauri dev` hides the problem. The system "may deny the operation immediately, before the user has responded". **Phase 1a:** add `NSLocalNetworkUsageDescription` in German (`bundle.macOS.infoPlist`). On first "Tunnel beitreten" with a member on the same subnet: German pre-explanation, then one empty UDP datagram to trigger the prompt early, outside any fallback timer. Sends are retried with backoff for up to 30 s ("Warte auf Freigabe 'Lokales Netzwerk'…"). Denial is detected heuristically, since there is no API: LAN sends fail or no LAN probe answers while MQTT shows the same subnet. Then a banner points to Systemeinstellungen › Datenschutz & Sicherheit › Lokales Netzwerk. Recommend macOS 15.1+ (bugs fixed there [108]). Every Phase 1a acceptance run uses the **bundled** app, on a fresh user account, answering both Allow and Deny. |
| macOS | Signing | Owner decision §1.5. The grant is tied to the signature; ad hoc code is tracked unreliably [108]. With a Developer ID: notarization in CI (tauri-action `APPLE_*` secrets), hardened runtime, stable bundle ID. |
| macOS | App Nap | Activity assertion while watching or sharing (§2.3). |
| Windows | Firewall | Today all media runs in `msedgewebview2.exe`, so a UDP socket in `StreamTunnel.exe` is new. A cancelled prompt creates persistent block rules [115], and the per-user installer cannot add allow rules without elevation [94]. Plan: outbound-first simultaneous probing (stateful replies). Week-1 spike on a clean account: does a prompt appear, and does a cancelled prompt still allow punched replies (UNVERIFIED)? If host candidates stay silent, show a German explanation instead of falling back silently. |
| Windows | Power | EcoQoS opt-out while sharing (§2.3) [116]. |
| Linux | Portal | Restore token (Phase 4); re-prompt gracefully when the token is rejected [64]. |
| All | **Updates** | `tauri-plugin-updater` [117]: signature mandatory (minisign), manifest on GitHub Releases (no server), `createUpdaterArtifacts` [94]. Linux updates need an AppImage, so keep a *slim* AppImage that uses the host's GStreamer (§6). |

---

## 3. Codec and bitrate policy

### 3.1 Codec matrix (native path)

| Sender ↓ / Viewer → | Mac M1/M2 | Mac M3+ | Win/Linux app viewer with HW HEVC | App viewer without HW HEVC | Browser edition, Intel Mac, old version |
|---|---|---|---|---|---|
| Windows NVIDIA (owner: RTX 4080) | **HEVC Main 8-bit** | HEVC (AV1 on bandwidth-limited links) | HEVC | H.264 High | Kompatibel (WebRTC) |
| Windows AMD/Intel (MF, Phase 2) | HEVC | HEVC | HEVC | H.264 High | Kompatibel |
| Mac VideoToolbox (Phase 3) | HEVC | HEVC | HEVC | H.264 Constrained High | Kompatibel |
| Linux VA / NVENC (Phase 4) | HEVC | HEVC / AV1 | HEVC / AV1 | H.264 | Kompatibel |

**Rules**
1. **Caps per receiver**, carried in the `nv` blob:
   - hardware decode set: on the Mac from `VTIsHardwareDecodeSupported`; on Windows and Linux from `VideoDecoder.isConfigSupported` plus a real test decode, because `isConfigSupported` can say yes and decode can still fail [61];
   - an **RFI capability bit per codec**;
   - presenter type; `stm` version and minimum version.
2. **RFI only where it is proven:** HEVC/AV1 on VideoToolbox. Later also D3D11VA. Moonlight advertises RFI only for these [27][28][29][122].
   - H.264, and every WebCodecs decoder, use IDR or intra refresh until a headless loss-injection test proves RFI works (Phase 2).
   - The owner's main pair (NVENC HEVC → VideoToolbox) gets RFI.
3. **Pick the codec per subtree:** the best codec every member of a relay subtree can decode. Relays never transcode.
4. **Never send AV1 to M1/M2**: no hardware decoder and no VideoToolbox software decoder [54].
5. **No software encode** in the native path. Without hardware, use Kompatibel.
6. **HEVC is the default**: Parsec has defaulted to it since March 2024 and reports about half of H.264's bitrate [8][9]. NVIDIA reports AV1 about 40 % more efficient than H.264 [14]. No primary source compares HEVC and AV1 on NVENC (UNVERIFIED), so AV1 is used only on bandwidth-limited links where every member has hardware AV1. AV1 into VideoToolbox needs `av1C` in the format description (research).
7. **4:4:4 is out of scope.** WebCodecs and D3D11VA define no HEVC 4:4:4 decode profile, and AMD cannot do it. At most a Phase 5 option from NVIDIA to native decoders.

### 3.2 Defaults (Mbit/s on the wire, FEC included)

These come from the formula already shipped in `src/rtc/defaults.ts` (§1.1). The native path uses the same function, ported to Rust or passed in from TypeScript, so both paths agree.

| Preset | HEVC/AV1, wired LAN | H.264 | Wi-Fi cap | VBV wired | VBV Wi-Fi / WAN |
|---|---|---|---|---|---|
| 1080p60 | 20 | 30 | 20 | 2 frames | 1 frame |
| 1440p60 | ≈ 36 | ≈ 53 | 30 | 2 frames | 1 frame |
| 1080p120 / 1440p120 | ≈ 32 / ≈ 58 | ×1.5 (clamp 100) | 35 | 2 frames | 1 frame |
| 2160p60 | 80 | 100 (clamp) | 40 | 2 frames | 1 frame |
| "Text/Code (scharf)" | same rate, static repeat at full fps | | | | |

- The formula matches Moonlight's defaults [25]. GeForce NOW asks for 25 Mbit/s at 1080p60 [92].
- The Wi-Fi caps and the 2-frame wired VBV are design choices. Parsec warns that rates above 50 Mbit/s hurt latency [6]; that matters on links slower than gigabit.
- On wired gigabit with 1 Gbit/s pacing, a 2-frame VBV at 1440p60 is about 1.2 Mbit, which takes about 1.2 ms to send (arithmetic). On Wi-Fi and WAN, keep NVIDIA's and Sunshine's one-frame VBV [11][16].

### 3.3 Encoder profile per API

Common to every API: CBR, no B-frames, no lookahead, zero reorder delay, infinite GOP, IDR only on demand, no filler [11][16].

- **NVENC** [11][16]:
  - `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`. Preset P3 at ≤ 1440p60; P1 for 4K or ≥ 120 fps. The measured encode time decides, with a budget of ≤ 4 ms (estimate; P1 vs P3 throughput in [12]).
  - `RC_CBR`, `multiPass = TWO_PASS_QUARTER_RESOLUTION`.
  - `gopLength = idrPeriod = NVENC_INFINITE_GOPLENGTH`, `frameIntervalP = 1`, `zeroReorderDelay = 1`, `enableLookahead = 0`, `repeatSPSPPS = 1`.
  - DPB 5 with `numRefL0 = 1`; `nvEncInvalidateRefFrames` on `FrameLost`, falling back to an IDR when the lost range is at least the DPB size.
  - **`lowDelayKeyFrameScale` per mode:** it applies only with a single-frame VBV and CBR, and defaults to 1 for ultra-low-latency tuning [15]. So set 1–2 on Wi-Fi/WAN (1-frame VBV). On wired LAN, rely on the 2-frame VBV and the pacer. Measure IDR size and QP when a viewer joins.
  - Spatial AQ only if the encode budget allows; never temporal AQ (frame-size swings [11]).
  - A QP floor like Parsec's `encoder_min_qp` [5], set by measurement.
  - Split-frame encode on the 4080's 2 NVENC engines [13] only for 4K, never by default, because it costs quality [11].
  - VUI: BT.709, limited range.
- **Media Foundation (Phase 2):** `CODECAPI_AVLowLatencyMode = TRUE`, `eAVEncCommonRateControlMode_CBR`, `AVEncCommonBufferSize` in **bytes**, B-picture count 0, GOP 0, `AVEncVideoForceKeyFrame` [43]. Never the main path on NVIDIA (latency creep [44]). IDR or intra refresh on loss.
- **AMF (Phase 5):** usage `ULTRA_LOW_LATENCY`, latency-constrained VBR or CBR, `IDR_PERIOD 0`, `B_PIC_PATTERN 0`, pre-analysis off [48].
- **VideoToolbox (Phase 3):** `EnableLowLatencyRateControl`, `RealTime`, `AllowFrameReordering = false`, `MaxFrameDelayCount` 1–3, `DataRateLimits` 1.5× over 1 s, `MaxAllowedFrameQP` about 30–36 for text (suggestion), LTR with acknowledged tokens and `ForceLTRRefresh` [49].
- **VA-API / nvcodec:** as in §2.3; IDR-only on VA.

### 3.4 LAN fixed rate vs Internet adaptation

**LAN mode:** both peers on the same private subnet (the existing "same private /24" heuristic from `c0db83f`) or RTT < 3 ms, like Moonlight's RFC 1918 heuristic [31].
- The rate is fixed from §3.2, as in Moonlight, which never adapts [24][25].
- Back off only when post-FEC loss stays above 2 % or one-way queueing delay keeps rising for 1–2 s.
- Step down 15–25 %, recover +5 %/s, reconfigure at most once per 500 ms. `NvEncReconfigureEncoder` changes the bitrate without an IDR [11]. These numbers are design choices.

**Internet mode (Phase 1b onward)**
- A delay-gradient controller (trendline/AIMD, as in str0m's GoogCC port [83]) with a high floor and the same change limit. It never drives the encoder frame by frame.
- Resolution changes only after a sustained 5 s shortfall with hysteresis, because each change costs an IDR [11].
- Games drop resolution; desktop and text drop fps (content-hint mapping, encoding research).

**Phase 1a scope rule:** the native path is used **only in LAN mode**. Every other link stays on Kompatibel until Phase 1b ships the controller.

### 3.5 Keyframes, loss, FEC and static content

**IDR**
- Only at stream start, when a viewer joins, and when the RFI capability is missing.
- Coalesce joins within 250 ms; at most one IDR per 500 ms (design choices).

**Loss**
- The receiver sends `FrameLost` immediately, and *speculatively* as soon as the missing shards exceed the parity, as Moonlight does [23].
- With the RFI capability: `nvEncInvalidateRefFrames` (NVENC) or LTR refresh (VideoToolbox).
- Otherwise: an IDR, or intra refresh where the encoder supports it (MF/AMF). On VA: IDR plus higher FEC.
- A relay forwards `FrameLost` upstream, and the sender merges requests across viewers.
- **No NACK retransmit in Phase 1.** Add it later only if Wi-Fi measurements show FEC is not enough.

**FEC** with `reed-solomon-simd` 3.1.0 (licence MIT AND BSD-3-Clause [119]):
- Leopard-based, 1–32768 original plus 1–32768 recovery shards, and the shard size must be even [79].
- **One block per frame.** The last shard is padded to an even length; there is no 255-shard splitting.
- At least 2 parity shards. 10 % on wired LAN, 20 % on Wi-Fi/WAN (Moonlight's default is 20 % [21]); later adaptive in the 5–40 % range from receiver reports.
- Above about 800 data shards (an abnormal frame), send it without FEC and accept the risk, as Sunshine does [18].
- Benchmark encode and decode for 1–100 shards of 1.4 KB, because FFT-based RS has fixed overhead (Phase 1a task).
- Ship the BSD-3-Clause notice on the licences page.

**Static content**
- WGC and SCK deliver nothing while the content is unchanged. Re-submit the last texture so the encoder runs at ≥ fps/2 (Sunshine [21]).
- "Text/Code" runs at full fps: Parsec's "Constant FPS" advice for blurry Windows-to-Mac text [8]. Text converges to sharp, and the measured fps stays steady.

### 3.6 Colour

- 8-bit 4:2:0, BT.709 limited range, signalled in the VUI and honoured by the Mac shader.
- HDR sources: a German warning in Phase 1a; FP16 capture and a tone-map shader in Phase 5 (§2.3).

---

## 4. Transport decision

### 4.1 Alternatives

| Option | Latency control | NAT traversal | Relays | Crypto | Interop | Size (estimate) | Verdict |
|---|---|---|---|---|---|---|---|
| WebRTC in the webview (today) | jitter buffer, GoogCC and a 1.1× pacer outside our control [36][107]; no HEVC send [34]; OpenH264 toward Macs [101][102][103] | ICE + TURN | re-encode, +20–40 ms per hop | DTLS-SRTP | every webview and the browser edition | 0 | **keep permanently as "Kompatibel"** |
| WebCodecs encode + RTCDataChannel (stays in the webview) | no GoogCC, but SCTP congestion control; a frame is one SCTP message, so one lost fragment loses the frame unless it is retransmitted; throughput at 40–60 Mbit/s UNVERIFIED | ICE | possible | DTLS | webviews | 0 | rejected: no RFI control, and HEVC WebCodecs decode is broken on WebKit [61] |
| str0m 0.24 (Rust WebRTC) | GoogCC advisory, no video FEC, no TURN client, H.265/AV1 hidden [83] | ICE, own sockets | RTP forwarding | DTLS-SRTP | reaches browser members | 2–4 MB | **Phase 5 option** for Kompatibel (serving browser members from the native encoder; replacing webrtcbin) |
| GStreamer webrtcbin | 200 ms default jitter buffer [73]; FEC and NACK off | libnice | — | DTLS-SRTP | good | tens of MB on Win/Mac [74] | Linux Kompatibel only |
| QUIC datagrams (quinn / iroh) | datagrams *must* obey QUIC congestion control [76]; quinn's BBR is experimental | iroh needs relays; n0's free relays are dev-only [77] | — | TLS 1.3 | — | 2–3 / 6–10 MB | rejected (needs a server) |
| libwebrtc native | same GCC behaviour | full | — | — | — | 10–25 MB | rejected (size) |
| **Custom UDP `stm/1`** | full control: no jitter buffer, FEC, RFI, fixed LAN rate | own STUN, simultaneous probing, IPv6, member relay, native TURN client (Phase 2) | **cut-through forwarding, no re-encode** | Noise handshake (snow) + AES-256-GCM with AAD | app to app, versioned | **0.5–1.5 MB** | **chosen** |

Parsec went this way after trying WebRTC [2], and Sunshine and Moonlight define the receive rules [18][23].

### 4.2 Wire format v1

```
UDP payload ≤ 1200 B on Internet paths; LAN after a DF probe: ≤ 1400 B (IPv4) / ≤ 1380 B (IPv6)
 [0]     u8  version(2)=1 | kind(6): ctrl, video, audio, keepalive, probe
 [1]     u8  key epoch (incremented on every rekey)
 [2..10] u64 packet number, per direction → AES-GCM nonce = 0u32 ‖ packet number
 [10..]  AES-256-GCM(plaintext) ‖ 16-byte tag, AAD = bytes 0..10 (header authenticated)
video plaintext: u16 stream id, u32 frame, u16 shard, u16 data shards, u16 parity shards,
                 u8 flags (key | after-RFI | repeat), u8 codec, u64 capture µs, u16 sender latency (0.1 ms)
```

- **Replay window:** 2048 packets per direction.
- **Rekey every 2^24 packets.** TLS 1.3 limits AES-GCM to about 2^24.5 full-size records per key [123]. At about 3,600 packets/s (40 Mbit/s with 1.4 KB packets) that is about every 78 minutes (arithmetic).
  - The new key is `HKDF-Expand(k, "stm/1 rekey", 32)`, and the epoch byte increments.

### 4.3 Crypto

**Use snow 0.10 for the handshake only.**
- Its `StatelessTransportState` takes no associated data [111], so the header could not be authenticated through it.
- `HandshakeState` is not `Clone` [112], so one handshake message cannot be broadcast in `join` to several responders.

**Pattern:** `Noise_NNpsk0_25519_AESGCM_SHA256` [80], **pairwise per sharer–viewer link**:
- Message 1 goes in the *per-viewer* `offer`, with the sharer as initiator; message 2 goes in the viewer's answer.
- The prologue binds `"stm/1" ‖ room id ‖ stream id ‖ sharer member id ‖ viewer member id`.

**Keys**
- After the handshake, take the two directional keys with `dangerously_get_raw_split()` [112] and run the RustCrypto `aes-gcm` crate with explicit nonces and real AAD.
- snow's default resolver probably already depends on `aes-gcm`, so no second copy is added (UNVERIFIED).

**PSK:** a new HKDF output (info `"stm/1 psk"`) from the room key material, derived in `src/core/crypto.ts` with `deriveBits` and handed to Rust once per room. Never logged.

**Threat model, same as today:** being a room member is the authentication. Every hop has its own keys; relays re-encrypt.

**No packet is accepted before authentication**
- The handshake runs over the MQTT envelope, so every UDP packet, probes included, carries AEAD from the first packet onward.
- Unauthenticated packets are dropped after at most one AEAD check, with a per-source token bucket.
- STUN responses are accepted only from configured STUN servers with a matching 96-bit transaction ID.
- The protocol never replies to unauthenticated packets, so there is no amplification.

### 4.4 Packets and pacing

- `quinn-udp` 0.6.3 handles USO/GSO batching (`UDP_SEND_MSG_SIZE` on Windows) [81]. Batches stay at or below 64 KB / 64 packets [18].
- **Wired LAN:** pace at about 80 % of 1 Gbit/s in 1 ms groups, as Sunshine does [18]. A 1440p60 frame leaves in about 1 ms.
- **Wi-Fi/WAN:** pace at 3× the target bitrate (design choice). Sunshine documents that bursts overflow buffers on slower client links [22].
- Both peers report their own link type: on Windows `GetAdaptersAddresses` IfType 71 = Wi-Fi; on macOS the method is UNVERIFIED. The stats line shows "WLAN" or "Kabel".
- Optional: qWAVE `QOSAddSocketToFlow` (AudioVideo / Voice), as Sunshine does [124-not used; see 18].

### 4.5 NAT traversal

**Candidates**
- Host addresses, IPv4 **and IPv6** global. Prefer IPv6 when both peers have it: DS-Lite and CGNAT are common in Germany, and stateful IPv6 firewalls normally pass simultaneous outbound probes (UNVERIFIED rate).
- Server-reflexive candidates from the user's STUN list (`NetConfig.stun`), queried on the *same* socket.
- Phase 2, optional: UPnP/PCP via `igd-next` or `portmapper`.

**Exchange:** in the `nv` blob plus batched `nvice` messages, like today's `ice`.

**Probing:** every 20 ms. **One deadline, equal to the probe duration:** 2 s when a host pair shares a subnet, 5 s otherwise. Keep the lowest-RTT pair. Keepalive every 15 s, since NAT state often expires around 30 s [78].

**Fallback order**
1. A native member relay (another member who is reachable).
2. **The native TURN client (Phase 2)**: Allocate/ChannelBind [125] to a user-configured TURN server such as Cloudflare ($0.05/GB [82]), so TURN-only users stay on the fast path.
3. Kompatibel (WebRTC with the user's TURN servers).

**Context:** Parsec reports 97 % with STUN, hole punching and UPnP [1]; Tailscale says "over 90 %" direct [78]. These may not carry over to German DS-Lite/CGNAT lines.

### 4.6 Multi-viewer and relays

**Encode once per (codec × quality tier):**
- At most 3 sessions per share (design choice), far below the RTX 4080's limit of 12 concurrent sessions [13]. Fix the "ca. 8" in `README.md`.
- Tiers: "LAN hoch" (fixed LAN rate) and "WLAN/Internet" (adaptive), plus one optional extra resolution.
- The per-viewer resolution menu from 0.1.5 maps to the nearest tier, and the UI says so ("vom Teilenden auf 1440p begrenzt").

**Relays forward cut-through**
- Each shard is forwarded the moment it arrives, re-encrypted per child, with parity shards unchanged.
- Data shards that FEC recovers are forwarded as well. There is no store-and-forward of whole frames.
- Shard size = the minimum MTU over the subtree.
- Target cost per hop: ≤ 3 ms p50 on a LAN.

**Several shares at once** are separate stream IDs on the same socket.

### 4.7 Mixed rooms and versions

1. Two native-capable app members use the native path.
2. Everything else uses Kompatibel: the browser edition, Intel Macs, older versions, and links with no native path, native relay or TURN within the deadline.
3. **Windows sharer:** both paths coexist with no extra prompt (getDisplayMedia track + WGC of the same HWND, §2.3).
4. **Mac sharer (Phase 3) and Linux sharer (Phase 4):** a Kompatibel viewer needs a second getDisplayMedia capture, one more picker click explained in German. This lasts until the Phase 5 str0m sender serves such viewers from the native H.264 encoder.
5. **Sequential fallback, no "happy eyeballs".** Running Kompatibel in parallel would cost a second capture, or a second prompt on Mac and Linux. The deadlines in §4.5 bound the delay. Exception: on a Windows share whose webview track already exists, both paths are negotiated in parallel and the first decoded frame wins.
6. **Versions:** the caps carry `stm` version and minimum version. On a mismatch, the member gets Kompatibel plus a German hint: "‹Name› nutzt eine ältere Version – Bild langsamer. Bitte aktualisieren." Auto-update (§2.9) keeps rooms current.
7. **Retiring webrtcbin:** possible only once Linux app members use the native path (Phase 4) *and* browser-member interop has moved to str0m (Phase 5). Target: the first release after the Phase 5 str0m engine passes its interop tests. Until then it stays.

---

## 5. Phased plan

Effort is in developer-weeks (dw) for one experienced Rust/TS developer. These are estimates. The pacing constraint is the owner's hardware test runs: the app never drives the owner's PC, and all automated tests run headless (`cargo test`, `node --test tests/`, `npx tsc --noEmit`, `tests/e2e/run-e2e.mjs`).

### 5.0 How latency and steadiness are measured (every phase)

1. **Glass to glass, optical**
   - Share the existing test pattern (`makeTestStream`, which draws a large ms clock) as a normal window and capture it like a game.
   - Put the receiving Mac next to the sharing monitor and film both screens at ≥ 240 fps (phone slow motion; Parsec used 1000 fps [4]).
   - Read 50 frame pairs and report p50 and p95. Resolution is about ±4 ms.
2. **Built in, continuous**
   - Capture time from the frame header, mapped to the receiver clock through the ping/pong offset.
   - Endpoints: capture to decoded, and capture to presented (Metal present time; rAF time in page paths [90]).
   - Optional CSV log (§2.8).
3. **Steadiness over 10 minutes** of a moving game plus a static desktop:
   - p50, p95 and p99 capture-to-present, and p95 − p50;
   - presented fps mean and late frames (arrival to present > 1.5 refresh intervals);
   - frames lost after FEC per minute; FEC repairs per minute;
   - wire bitrate stddev; per-frame average QP from NVENC (`frameAvgQP`, field use UNVERIFIED).
4. **Load conditions**, recorded every time:
   - a light desktop;
   - **a GPU-bound game at 100 % GPU**, both uncapped and with the fps capped just below refresh;
   - **the sharer's StreamTunnel window minimized** (EcoQoS);
   - **the Mac on Wi-Fi and on Ethernet.**
5. **Loss tests, headless:** an in-process lossy socket with 1 % random and 5 % burst loss. On Windows, Clumsy as Parsec used it [2].
6. **IPC cost** (page-decoding paths): Rust send timestamp to worker receive, p50/p95.

### Phase 0: finish the current path and measure (remaining 3–5 days, ships as 0.1.6)

| # | Task | Files |
|---|---|---|
| 0.1 | **Read what already exists, add a few logs.** The owner reads `lim` during a Windows-to-Mac run at 1440p60. Log: the Mac answer's H.264 `fmtp` lines (profile-level-id), the negotiated codec, the sender's `encoderImplementation`, the Mac model (`sysctlbyname("hw.model")` in a tiny Mac-only command), AV1 hardware decode on the Mac (WebCodecs `isConfigSupported` for `av01…` with `prefer-hardware`), and the link type on both ends. | `src/rtc/stats.ts`, `src/rtc/host.ts`, `src/rtc/viewer.ts`, `src-tauri/src/lib.rs` |
| 0.2 | **Experiment A, profile munge.** In the SDP a WebKit viewer receives, rewrite Chromium's High `profile-level-id=64xx1f` to `640c1f`. In the answer the sharer applies, rewrite it back to `64001f` before `setRemoteDescription`. Only for WebKit viewers. Success: `encoderImplementation` shows `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, and the Mac decodes without errors on both the engine path and the fast path (the WebCodecs codec string must follow the SPS: `avc1.64…`). End to end UNVERIFIED: that Chromium's WebRTC MF encoder emits no B-frames is also UNVERIFIED. | `src/rtc/tuning.ts` (pure functions + tests), `host.ts`, `viewer.ts`, `lowlat.ts` |
| 0.3 | **Experiment B:** append `D3D12VideoEncodeAccelerator` to `--enable-features`. Upstream it is on by default and tried before the MF encoder, with no NVIDIA skip for Baseline [104][105]. The owner's OpenH264 result suggests WebView2 differs; the test settles it. | `src-tauri/tauri.conf.json` `additionalBrowserArgs` (merge into the one `--enable-features` list) |
| 0.4 | **Experiment C:** append `WebRtcAllowH265Send,PlatformHEVCEncoderSupport` [33][105]. Check `RTCRtpSender.getCapabilities('video')` for H265. WebKit receives H.265 by default on Cocoa [106]. If offered: HEVC first for Mac viewers through the *engine* path, because WebCodecs HEVC on WebKit is unreliable [61]. Microsoft says this does not work in Edge [34], so expect a negative result. Record it either way. | same |
| 0.5 | **Experiment D:** `--force-fieldtrials=WebRTC-Video-Pacing/factor:4.0/` on LAN [107]. Whether WebView2 honours `--force-fieldtrials` is UNVERIFIED. | same |
| 0.6 | **Renderer:** WebGL2 `texImage2D(VideoFrame)` in the worker `OffscreenCanvas` instead of Canvas2D [97]; newest-frame mailbox, `close()` older frames, count mailbox drops; `desynchronized` only while overlays are hidden [89]. | `src/rtc/lowlat.ts`, `src/rtc/native.ts` |
| 0.7 | **Per-stage timing:** `getMetadata().receiveTime` [90] → decode submit → decoder output → draw. On Linux also the Rust-to-page IPC time, and confirm the production `latency_ms` value. | `lowlat.ts`, `native.ts`, `linux-media/src/lib.rs` |
| 0.8 | **Docs:** NVENC session limit in `README.md` (12 on the RTX 4080 [13]); the Windows-to-Mac codec facts in `docs/ARCHITECTURE.md` §5.1. | docs |

**Acceptance**
- All existing and new tests pass.
- The owner's optical before/after on wired LAN.
- The facts from 0.1 are recorded.
- Each of experiments A–D is recorded as "works" or "does not work".

**Go/no-go gate**
- If Phase 0 alone brings Windows-to-Mac to p50 ≤ 40 ms with p95 − p50 ≤ 15 ms (targets; unlikely, estimate), pause and decide Phase 1 again.
- Otherwise start Phase 1a.
- If the Mac turns out to be an M3 or later, Phase 1a is still the destination: the gain is transport and presentation, not only the codec.

### Phase 1a: native Windows-to-Mac path on the LAN (≈ 8–12 dw), the real fix

**Scope, deliberately cut**
- NVIDIA Windows sharer → Apple-silicon Mac viewer, **same LAN only**.
- **HEVC only**; PCM audio; FEC + RFI; fixed rate with backoff.
- One Metal presenter.
- The **existing** picker; no NACK.
- No WebCodecs fallback on the Mac; Kompatibel is the fallback.

**Week 1: spikes, each go/no-go**
1. A transparent WKWebView over a test `NSView`, in a **bundled** `.app` [93].
2. WGC → NVENC HEVC on the owner's PC, dumped to a file; VideoToolbox decodes it on the Mac.
   - Also record a short fixture with an injected `nvEncInvalidateRefFrames`.
3. The Local Network prompt on macOS 15/26 in signed or ad hoc bundles: Allow and Deny [108].
4. The Windows firewall prompt on a clean account (§2.9).
5. The `reed-solomon-simd` benchmark.

**Track P (parallel prerequisites)**
- The owner's signing decision; `NSLocalNetworkUsageDescription` in German.
- `tauri-plugin-updater` with a minisign key; release manifest on GitHub.
- CI: build and attach the bundled `.app`; a size gate (§6).

**Tasks**

1. **Crate `src-tauri/media` (`st-media`)**, shaped like `linux-media`:
   - `net/wire.rs`;
   - `net/crypto.rs` (snow handshake, `aes-gcm` transport with AAD, replay window, rekey);
   - `net/fec.rs`; `net/frame.rs` (sharding, reassembly, speculative loss); `net/ctrl.rs` (acked control);
   - `net/rate.rs` (LAN fixed rate with backoff); `net/pace.rs`;
   - `net/link.rs` (host candidates, probing, keepalive, deadline);
   - `clock.rs`, `stats.rs`, `log.rs` (CSV, rotation).
2. **Windows sender, `media/src/win/`:**
   - `wgc.rs` (HWND/monitor item, pool, lifecycle);
   - `d3d.rs`; `nvenc_sys.rs` (bindgen output, committed); `nvenc.rs`;
   - `repeat.rs`;
   - `prio.rs` (GPU priority, MMCSS, timer, power-throttling opt-out, results logged);
   - `hdr.rs` (detect and warn).
3. **Mac receiver, `media/src/mac/`:**
   - `vt_dec.rs` (HEVC parameter sets, Annex B → length-prefixed; a decode error sends `FrameLost`);
   - `metal.rs` (CAMetalLayer, CVMetalTextureCache, BT.709 shader, CAMetalDisplayLink on 14+);
   - `view.rs` (NSView below the WKWebView);
   - `audio_out.rs` (cpal, adaptive buffer, output latency);
   - `activity.rs` (App Nap);
   - `lnp.rs` (early prompt, retry, denial heuristic).
4. **Audio:** `sysaudio.rs` PCM → `st-media`, 5 ms packets, RS 4+1.
5. **Tauri commands** in `src-tauri/src/native_media.rs`, registered in `lib.rs` and the capability files:
   - `nm_caps`;
   - `nm_offer` / `nm_accept` (opaque blobs);
   - `nm_share_attach(hwnd | monitor)`;
   - `nm_watch_start/stop`;
   - a stats `Channel` (small JSON).
6. **TypeScript:**
   - `src/rtc/nativelink.ts` (`NativeShare`, `NativeWatch`);
   - `nv` and `nvice` dispatch in `src/rtc/tunnel.ts`, with the rules from §4.7 and the deadline fallback;
   - PSK derivation in `src/core/crypto.ts`;
   - `nv` fields in `src/types.ts` (lead change);
   - watch-view transparency in `src/ui/watch.ts` and the styles;
   - the one-line stats plus "Details", with strings in `src/i18n.ts`, following `docs/DESIGN.md`.
7. **Docs:** a new section in `docs/ARCHITECTURE.md`; the README platform table.

**Acceptance**

`cargo test`:
- wire round-trip;
- tampered header (AAD) rejected; replayed packet rejected; rekey at the epoch boundary;
- a handshake whose prologue does not match fails;
- FEC recovers any loss ≤ parity;
- a frame abandoned on a newer frame produces `FrameLost`;
- the rate state machine.

**Loopback test:** the HEVC fixture from spike 2, 1 % random loss: no visible loss beyond the parity. The RFI fixture decodes on the macOS CI runner. Whether a CI VM has hardware HEVC decode is UNVERIFIED; if not, the owner's Mac runs this test.

**Owner test**, from the bundled (ideally signed) app, RTX 4080 sharing a 1440p60 game window:

| Run | Targets |
|---|---|
| Mac on Ethernet | optical **p50 ≤ 40 ms, p95 ≤ 55 ms**; built-in p95 − p50 ≤ 8 ms; ≥ 59.5 fps mean; ≤ 0.2 % late frames over 10 min; overlay shows "HEVC Hardware"; the sharer's CPU clearly below the OpenH264 run |
| Mac on Wi-Fi | **p95 ≤ 70 ms**, ≤ 1 % late frames (design targets) |
| Game uncapped at 100 % GPU | p95 ≤ 70 ms (target). Log which priority calls succeeded; capped-fps run meets the Ethernet targets |
| Sharer window minimized | no fps drop |

**Permissions and fallback**
- Local Network on a fresh macOS account: Allow works, and Deny gives the German banner plus Kompatibel within the deadline.
- Blocking the native link falls back to Kompatibel within 2 s on the LAN.

### Phase 1b: Internet for Windows to Mac (≈ 3–5 dw)

- STUN on the same socket; IPv6 preference; the 5 s deadline; 15 s keepalive; 1200 B shards.
- The delay-gradient controller (§3.4); adaptive FEC; Opus for non-LAN audio; 1-frame VBV with `lowDelayKeyFrameScale` 1–2.
- **Acceptance:**
  - Loopback at 50 ms RTT and 2 % loss: no freeze longer than 1 frame interval without a recovery frame.
  - The owner's Internet run (a friend, or the Mac on a phone hotspot): p50 ≤ LAN p50 + one-way delay + 1 frame (target).

### Phase 2: Windows viewer, AMD/Intel sharers, fan-out, relays, TURN (≈ 6–9 dw)

- **Windows viewer:**
  - receive in `st-media`, then the WebSocket spike (§2.5), then WebCodecs in WebView2 and a WebGL2 mailbox;
  - HEVC/AV1/H.264 decided by a runtime test decode.
- **RFI test:** a headless loss-injection test in `tests/e2e`: drop frame N, send the RFI frame, and check that WebCodecs outputs it without error. Until it passes, WebCodecs viewers get IDR.
- **Sender:** `media/src/win/mf_enc.rs` (MF hardware MFT) for AMD/Intel, with intra refresh or IDR.
- **Fan-out:**
  - codec × tier groups (at most 3 sessions);
  - per-peer pacing and keys;
  - `net/relay.rs` with cut-through forwarding;
  - upstream merging of `FrameLost` and IDR requests;
  - remove the re-encode relay path for native links.
- **Network:** the native TURN client (`net/turn.rs`, RFC 8656 Allocate/ChannelBind [125]); optional UPnP/PCP.
- **Acceptance:**
  - Windows to Windows meets the Phase 1a targets.
  - 3 viewers plus 1 relay hop: the hop adds ≤ 3 ms p50 on a LAN (target).
  - A TURN-only test (UDP blocked except to TURN) stays on the native path.

### Phase 3: Mac sender and Mac "V-Sync aus" (≈ 5–7 dw)

- `media/src/mac/sck.rs`, `vt_enc.rs` (HEVC low latency with fallback, LTR), `tap.rs`; `NSAudioCaptureUsageDescription` in Info.plist.
- Native sharing gated to macOS 14+ at runtime; older systems use Kompatibel.
- "V-Sync aus": `displaySyncEnabled = false` plus hiding the WKWebView in fullscreen while the overlays are faded out.
  - UI modes "V-Sync an" (default), "V-Sync aus" and "V-Sync + gleichmäßig", as in Moonlight [25].
- **Acceptance:**
  - Mac to Windows and Mac to Mac meet the Phase 1a targets.
  - Windows to Mac with "V-Sync aus" in fullscreen with the webview hidden: optical p50 ≤ 30 ms (target; the direct-display requirement is UNVERIFIED).

### Phase 4: Linux on the native path (≈ 6–8 dw)

- **Viewer:** `st-media` receive feeds the page decoder that already exists in `src/rtc/native.ts`; WebSocket delivery.
- **Sender:** `media/src/linux/portal.rs` (ashpd) and `gst_enc.rs` (VA with `key-int-max=1024` + forced IDRs, or nvcodec with a CPU-copy fallback); PipeWire app audio.
- **Packaging (`packaging/arch/PKGBUILD`):**
  - depends: `webkit2gtk-4.1`, `gst-plugin-pipewire`, `pipewire`;
  - optdepends: `gst-plugin-va`, `intel-media-driver`, `nvidia-utils` [71].
  - Replace the 79 MB AppImage with a slim host-GStreamer AppImage, which the updater needs.
- **Startup capability probe**, shown in German (for example "NVENC H.265 · Zero-Copy aus").
- **Acceptance:**
  - KDE Wayland (CachyOS default), GNOME and Hyprland.
  - Linux AMD to Mac meets the Phase 1a targets.
  - The NVIDIA fallback works on the owner's RTX 4080.

### Phase 5: options, each decided by measurements and room mix (≈ 4–10 dw)

- **str0m "Kompatibel" sender/receiver in Rust:** serves browser and old members from the native H.264 encoder (removing the second-capture prompts on Mac and Linux) and can replace webrtcbin.
- Cursor as separate messages, drawn by the viewer [3].
- AMF directly.
- A Windows native presenter, only if the Phase 2 numbers show the WebView2 compositor costs more than one frame.
- HDR: FP16 capture plus tone mapping.
- 4:4:4 from NVIDIA to native decoders.
- A native Windows picker with thumbnails, replacing getDisplayMedia once Kompatibel is served by str0m.

**Effort total: ≈ 33–52 dw** (estimate). That is Phase 0 3–5 days, 1a 8–12, 1b 3–5, 2 6–9, 3 5–7, 4 6–8 and 5 4–10.

---

## 6. Size budget and dependencies

Baseline, GitHub release v0.1.4 (read today):
- Windows setup 1,118,170 B;
- Mac dmg 1,422,701 B;
- Linux tar.gz 1,418,750 B; deb 1,470,570 B; AppImage 78,973,432 B.

All growth figures are estimates (UNVERIFIED). Release builds already use `opt-level = "s"`, LTO, `strip`, `panic = "abort"` and `codegen-units = 1`.

**CI gate:** fail the build when any download grows by more than 0.5 MB without sign-off. Run `cargo bloat` per crate on every phase.

| Download | Today | Phase 0 | Phase 1a/1b | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|---|---|
| Windows setup | 1.12 MB | 1.12 | ≈ 1.5–2 | ≈ 2–2.5 | same | same |
| Mac dmg | 1.42 MB | 1.42 | ≈ 2–2.5 | ≈ 2.5 | ≈ 2.5–3.5 | same |
| Linux tar.gz / deb | ≈ 1.4–1.5 MB | same | same | same | same | ≈ 2–3 MB, plus system packages (`gst-plugin-pipewire` 175 KB, `gst-plugin-va` 566 KB [71]) |
| Linux AppImage | 79 MB | same | same | same | same | slim host-GStreamer AppImage of a few MB (estimate) |

| Crate | Version | Used for | Cost (estimate) |
|---|---|---|---|
| `snow` [80] | 0.10.0 | Noise handshake | ~0.2–0.5 MB |
| `aes-gcm` | version UNVERIFIED (probably already pulled in by snow's resolver) | transport AEAD with AAD | small |
| `reed-solomon-simd` [79][119] | 3.1.0, MIT AND BSD-3-Clause | FEC | small |
| `quinn-udp` [81] | 0.6.3 | USO/GSO batching | small |
| `cpal` [118] | 0.18.2 (reuses `windows` 0.62 and `objc2` 0.6) | audio playout | ~0.2–0.4 MB |
| `windows` | 0.62 (already in the tree) | features `Graphics_Capture`, `Graphics_DirectX_Direct3D11`, `Win32_System_WinRT_Graphics_Capture`, `Win32_Graphics_Direct3D11`, `Win32_Graphics_Dxgi`, `Win32_Graphics_Dwm`, `Win32_System_Threading`; later `Win32_Media_MediaFoundation` | no second copy; feature code unmeasured |
| `objc2-video-toolbox`, `-core-media`, `-core-video`, `-metal`, `-quartz-core` (Phase 3: `-screen-capture-kit`, `-av-foundation`) [59] | 0.3.2 | Mac decode, present, capture | < 1–2 MB together |
| `tauri-plugin-updater` [117] | version UNVERIFIED | auto-update | UNVERIFIED |
| `opus` / `audiopus` (Phase 1b) | version UNVERIFIED; needs a C build of libopus | non-LAN audio | ~0.3–0.5 MB |
| `ashpd` [65] (Phase 4) | 0.13 | Linux portal | pulls in `zbus` 5 |
| `str0m` [83] (Phase 5 option) | 0.24.x | Kompatibel in Rust | 2–4 MB |

**Explicitly not used:** FFmpeg; GStreamer on Windows or macOS; libwebrtc; Electron; wgpu or libplacebo/MoltenVK for video.

**Licences:** Sunshine and Moonlight are GPL-3.0, so copy ideas and parameter values only [31]. The NVENC header and AMF are MIT [15][48].

---

## 7. Risks and open questions

| Risk / question | Mitigation |
|---|---|
| Which Mac (M1/M2 or M3+, ProMotion) and which link (Wi-Fi or Ethernet)? | Phase 0.1 logs both. HEVC is right for every Apple-silicon Mac; the caps decide at runtime. |
| Experiment A (profile munge) may break decoding, or Chromium may not use High without B-frames. | It is an experiment with clear success criteria; Phase 1a does not depend on it. |
| **macOS Local Network privacy** blocks native LAN sends; ad hoc signing makes grants unstable [108]. | §2.9: Info.plist key, early deliberate prompt, retry, denial banner, bundled-app tests on a fresh account. Developer ID recommended. Internet paths (public addresses) are not affected. |
| Windows firewall prompt or persistent block rules from a cancelled prompt [115]. | Outbound-first probing, a clean-account spike, a German explanation; perMachine install only if the owner chooses it. |
| GPU-bound games: priority calls fail without admin [20]; NVENC's RGB input uses CUDA [11]. | Best-effort calls with logging; ARGB vs HLSL NV12 measured under load; the fps-cap hint; a load acceptance run. |
| WebCodecs decoders may reject RFI recovery frames. | RFI capability bit per decoder; IDR until the Phase 2 loss-injection test passes [122]. |
| NVENC `NvEncInvalidateRefFrames` fails on some GPU/SDK combinations (forum reports). | Fall back to a rate-limited IDR. |
| SDK 13.1 headers need driver ≥ 610 [15]. | Use the oldest sufficient header; negotiate with `NvEncodeAPIGetMaxSupportedVersion`. |
| Transparent WKWebView in bundled builds (#13415 [93]); HiDPI; fullscreen. | Day-1 spike; full-window layer with no rect sync; Kompatibel fallback. |
| Tauri `Channel` IPC jitter for page decoders [114]. | WebSocket spike in Phase 2; the Mac path avoids page decoding. |
| WebView2 WebCodecs HEVC decode is UNVERIFIED. | Runtime test decode; H.264 High otherwise. |
| The webview compositor cost is an estimate. | Phase 0/2 measurements decide whether the Windows native presenter is built. |
| A custom network stack: NAT edge cases, crypto framing bugs. | snow handshake; AAD; replay window; rekey [123]; fuzz `wire.rs`; Kompatibel fallback; member relay and native TURN. |
| CGNAT/DS-Lite: German traversal rates differ from Parsec's or Tailscale's. | IPv6 first; native TURN client in Phase 2; member relay. |
| Fixed LAN rate on Wi-Fi. | Wi-Fi caps, slower pacing, loss/delay backoff, link type on both ends, a Wi-Fi acceptance run. |
| A/V drift; Bluetooth output latency. | Shared capture clock; output-latency query and opt-in video delay. |
| Mixed rooms: a Mac or Linux native share plus browser members costs a second capture. | Rules in §4.7; str0m Kompatibel sender in Phase 5. |
| Version skew between friends. | Caps with a minimum version, a German hint, the auto-updater. |
| Three media stacks (webview WebRTC, webrtcbin, native) work against "aus einem Guss". | One UI and one stats line; Kompatibel hidden behind one label; consolidation in Phase 5. |
| Linux: NVIDIA DMA-BUF negotiation [70]; single-use, buggy portal tokens [64]; VA has IDR-only recovery [113]. | CPU-copy fallback; graceful re-prompt; higher FEC on VA. |
| SCK permission behaviour on macOS 15/26 is UNVERIFIED [52]. | Test in the signed build in Phase 3. |
| HDR desktops look washed out. | Detection and a warning in Phase 1a; tone mapping in Phase 5. |
| Effort: 1a at 8–12 dw may still be optimistic. | Week-1 spikes with go/no-go; strict scope cut; every phase ships on its own. |
| Size figures are unmeasured. | CI size gate per phase. |

---

## 8. Sources

Repo facts are from `main` at `e163024` (commits `7055cb2`, `e163024`, `c0db83f`, `5f9f467`): `src/rtc/tuning.ts`, `src/rtc/defaults.ts`, `src/rtc/lowlat.ts`, `src/rtc/native.ts`, `src/rtc/sysaudio.ts`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/linux-media/src/lib.rs`, `docs/ARCHITECTURE.md` §1/§5.1/§6.1/§9.6, `README.md`, and the v0.1.4 release assets.

1. https://parsec.app/technology
2. https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007
3. https://parsec.app/blog/description-of-parsec-technology-b2738dcc3842
4. https://parsec.app/blog/parsec-game-streaming-total-latency-at-240-frames-per-second-c0818cc0daa5
5. https://support.parsec.app/hc/en-us/articles/32381815770772-Encoder-Video-Quality-Settings
6. https://support.parsec.app/hc/en-us/articles/32381776828820-Setting-The-Maximum-Bitrate-Of-The-Stream
7. https://support.parsec.app/hc/en-us/articles/32381650129300-Use-the-Web-App-browser
8. https://parsec.app/changelog.xml ; https://news.ycombinator.com/threads?id=boxerbk
9. https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility
10. https://support.parsec.app/hc/en-us/articles/32381603663636-Stream-Overlay-Stats-and-Logging ; https://support.parsec.app/hc/en-us/articles/32377721364-Audio-Buffer-Setting
11. https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html
12. https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-application-note/index.html
13. https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new
14. https://developer.nvidia.com/blog/av1-encoding-and-fruc-video-performance-boosts-and-higher-fidelity-on-the-nvidia-ada-architecture
15. https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/master/include/ffnvcodec/nvEncodeAPI.h ; .../dynlink_loader.h
16. https://raw.githubusercontent.com/LizardByte/Sunshine/master/src/nvenc/nvenc_base.cpp
17. https://raw.githubusercontent.com/LizardByte/Sunshine/master/src/video.cpp
18. https://raw.githubusercontent.com/LizardByte/Sunshine/master/src/stream.cpp
19. https://raw.githubusercontent.com/LizardByte/Sunshine/master/src/platform/windows/display_wgc.cpp
20. https://raw.githubusercontent.com/LizardByte/Sunshine/master/src/platform/windows/display_base.cpp
21. https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html
22. https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2troubleshooting.html
23. https://raw.githubusercontent.com/moonlight-stream/moonlight-common-c/master/src/RtpVideoQueue.c
24. https://raw.githubusercontent.com/moonlight-stream/moonlight-common-c/master/src/ControlStream.c
25. https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/settings/streamingpreferences.cpp
26. https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/streaming/video/ffmpeg-renderers/pacer/pacer.cpp
27. https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/streaming/video/ffmpeg-renderers/d3d11va.cpp
28. https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/streaming/video/ffmpeg-renderers/vt_metal.mm
29. https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/streaming/video/ffmpeg-renderers/vt_avsamplelayer.mm ; .../vt_base.mm
30. https://github.com/moonlight-stream/moonlight-qt/blob/master/app/streaming/video/ffmpeg.cpp
31. https://github.com/moonlight-stream/moonlight-common-c ; https://github.com/LizardByte/Sunshine ; https://raw.githubusercontent.com/moonlight-stream/moonlight-qt/master/app/streaming/session.cpp
32. https://raw.githubusercontent.com/chromium/chromium/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc
33. https://raw.githubusercontent.com/chromium/chromium/main/media/webrtc/webrtc_features.cc
34. https://learn.microsoft.com/en-ca/answers/questions/5880331/h-265-(hevc)-not-published-sent-via-webrtc-chrome
35. https://webrtc.googlesource.com/src/+/refs/heads/main/video/config/encoder_stream_factory.cc
36. https://webrtc.googlesource.com/src/+/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc
37. https://webrtc.googlesource.com/src/+/main/docs/native-code/rtp-hdrext/playout-delay/README.md
38. https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval
39. https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
40. https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nn-windows-graphics-capture-interop-igraphicscaptureiteminterop
41. https://raw.githubusercontent.com/obsproject/obs-studio/master/libobs-winrt/winrt-capture.cpp
42. https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts
43. https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode
44. https://forums.developer.nvidia.com/t/nvenc-h-264-encoder-mft-latency-increases-when-framerate-is-limited/63930
45. https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/for-best-performance--use-dxgi-flip-model
46. https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
47. https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw
48. https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/AMF/master/amf/doc/AMF_Video_Encode_API.md
49. https://developer.apple.com/videos/play/wwdc2021/10158/
50. https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/videotoolboxenc.c
51. https://developer.apple.com/videos/play/wwdc2022/10155/
52. https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker
53. https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
54. https://www.apple.com/newsroom/2023/10/apple-unveils-m3-m3-pro-and-m3-max-the-most-advanced-chips-for-a-personal-computer/ ; https://trac.ffmpeg.org/ticket/10642
55. https://support.apple.com/en-us/111867
56. https://developer.apple.com/documentation/avfoundation/avsamplebufferdisplaylayer
57. https://developer.apple.com/documentation/coremedia/kcmsampleattachmentkey_displayimmediately
58. https://developer.apple.com/documentation/quartzcore/cametaldisplaylink
59. https://crates.io/api/v1/crates/objc2-video-toolbox ; https://crates.io/api/v1/crates/objc2-screen-capture-kit
60. https://raw.githubusercontent.com/tauri-apps/wry/dev/Cargo.toml
61. https://bugs.webkit.org/show_bug.cgi?id=262950
62. https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
63. https://newreleases.io/project/github/moonlight-stream/moonlight-qt/release/v6.2.0
64. https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html ; https://bugs.kde.org/show_bug.cgi?id=517454
65. https://docs.rs/ashpd/latest/ashpd/desktop/screencast/index.html
66. https://raw.githubusercontent.com/PipeWire/pipewire/master/src/gst/gstpipewiresrc.c
67. https://gstreamer.freedesktop.org/releases/1.24/
68. https://gstreamer.freedesktop.org/documentation/va/vah264enc.html
69. https://gstreamer.freedesktop.org/documentation/nvcodec/nvh265enc.html
70. https://discourse.gstreamer.org/t/dma-buf-with-nvidia-card/5482
71. https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/ ; https://archlinux.org/packages/extra/x86_64/gst-plugin-pipewire/ ; https://archlinux.org/packages/extra/x86_64/gst-plugin-va/
72. https://bugs.webkit.org/show_bug.cgi?id=288625
73. https://gstreamer.freedesktop.org/documentation/webrtc/index.html
74. https://v2.tauri.app/distribute/appimage/
75. https://github.com/Vencord/venmic
76. https://www.rfc-editor.org/rfc/rfc9221.html
77. https://docs.iroh.computer/concepts/relays
78. https://tailscale.com/blog/how-nat-traversal-works
79. https://docs.rs/reed-solomon-simd/latest/reed_solomon_simd/
80. https://docs.rs/snow/latest/snow/
81. https://raw.githubusercontent.com/quinn-rs/quinn/main/quinn-udp/src/windows.rs
82. https://developers.cloudflare.com/realtime/turn/
83. https://github.com/algesten/str0m
84. https://github.com/tauri-apps/tauri/issues/9220
85. https://github.com/tauri-apps/tauri/issues/13740
86. https://www.getrapidraw.com/blog/wgpu-renderer
87. https://docs.rs/crate/wry/0.57.0/source/examples/wgpu.rs ; https://github.com/tauri-apps/wry/issues/1331 ; https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html
88. https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting
89. https://developer.chrome.com/blog/desynchronized
90. https://developer.mozilla.org/en-US/docs/Web/API/RTCEncodedVideoFrame/getMetadata
91. https://themaister.net/blog/2025/06/16/i-designed-my-own-ridiculously-fast-game-streaming-video-codec-pyrowave/
92. https://www.nvidia.com/en-us/geforce-now/system-reqs/
93. https://github.com/tauri-apps/tauri/issues/13415
94. https://v2.tauri.app/reference/config/
95. https://docs.rs/tauri/latest/tauri/window/struct.Window.html
96. https://github.com/w3c/webcodecs/issues/698
97. https://developer.chrome.com/blog/new-in-webgpu-116 ; https://tangoadb.dev/scrcpy/video/web-codecs
98. https://github.com/robmikh/Win32CaptureSample/issues/82
99. https://docs.rs/crate/moq-video/latest/source/DESIGN-native-codecs.md
100. https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder
101. https://raw.githubusercontent.com/WebKit/WebKit/main/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCDefaultVideoDecoderFactory.m (fetched 2026-10-28: only `…ConstrainedHigh` and `…ConstrainedBaseline`)
102. https://github.com/WebKit/WebKit/blob/main/Source/ThirdParty/libwebrtc/Source/webrtc/media/base/codec_comparators.cc
103. https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc
104. https://github.com/chromium/chromium/blob/main/media/gpu/windows/d3d12_video_encode_h264_delegate.cc (and `media/gpu/gpu_video_encode_accelerator_factory.cc`)
105. https://raw.githubusercontent.com/chromium/chromium/main/media/base/media_switches.cc
106. https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
107. https://github.com/WebKit/WebKit/blob/main/Source/ThirdParty/libwebrtc/Source/webrtc/video/video_send_stream_impl.cc
108. https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy (fetched 2026-10-28 via its JSON form)
109. https://developer.apple.com/news/?id=saqachfa
110. https://developer.apple.com/programs/ (fee not re-fetched in this run)
111. https://docs.rs/snow/latest/snow/struct.StatelessTransportState.html
112. https://docs.rs/snow/latest/snow/struct.HandshakeState.html
113. https://github.com/GStreamer/gstreamer/blob/main/subprojects/gst-plugins-bad/sys/va/gstvah265enc.c
114. https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/ipc/channel.rs
115. https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules
116. https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation
117. https://v2.tauri.app/plugin/updater/
118. https://crates.io/api/v1/crates/cpal/0.18.2/dependencies
119. https://crates.io/api/v1/crates/reed-solomon-simd
120. https://www.slideshare.net/BenjyBoxer/building-a-udp-protocol-for-cloud-gaming
121. https://parsec.app/blog/testing-game-streaming-input-latency-on-parsec-with-diy-instructions-49ae838f45a7
122. https://raw.githubusercontent.com/moonlight-stream/moonlight-common-c/master/src/Limelight.h
123. https://www.rfc-editor.org/rfc/rfc8446#section-5.5
124. https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/ns-dxgi1_6-dxgi_output_desc1
125. https://www.rfc-editor.org/rfc/rfc8656

---

## Review notes

**Accepted and built in**

*Phase 0 and diagnosis*
- **Profile mismatch (review 1).** The root cause is now stated as structural, verified against [101]. `preferH264High()` is documented as a no-op toward Macs. Experiments A and B were added.
- **Read `lim` first (review 2).** Phase 0.1. The diagnosis now names CPU limitation as the likely source of the fluctuation.
- **H.265 send flags, pacing field trial (both reviews).** Phase 0.4 and 0.5. The 1.1× pacer source is corrected to `video_send_stream_impl.cc` [107].
- **Go/no-go gate after Phase 0.** Added.
- **Parsec numbers re-read.** 7 ms is the DIY test with client V-Sync off; the 240 fps figure had V-Sync on and is "not real world".

*Permissions, signing, updates*
- **macOS Local Network privacy (both reviews).** §2.9 plus Phase 1a acceptance, verified today [108]. One addition: Internet paths are unaffected.
- **Code signing as a prerequisite.** Raised as an owner decision (§1.5) because it costs money.
- **Firewall.** The NSIS-hook mitigation is removed; replaced by outbound-first probing, a clean-account spike and German detection.
- **EcoQoS and App Nap.** Added.
- **Auto-update and version skew.** Added. This exposed the AppImage conflict, resolved with a slim host-GStreamer AppImage.

*Protocol*
- **snow API limits.** Snow is used for the handshake only, pairwise, with a prologue. The transport is `aes-gcm` with AAD.
- **FEC spec rewritten** around `reed-solomon-simd`: even shards, one block per frame, the actual licence.
- **NACK** dropped from Phase 1.
- **Relays** are cut-through.
- **Probing and fallback deadlines** made consistent.
- **Pre-handshake authentication.** Every UDP packet is authenticated, because the handshake runs over MQTT.
- **IPv6** is first-class.

*Encoding and capture*
- **VA `key-int-max=0` (review 1).** Now 1024 plus forced IDRs; Linux VA recovery is IDR-only.
- **RFI only where proven (review 1).** Capability bit per decoder, plus a WebCodecs loss-injection test.
- **GPU-bound behaviour and ARGB/CUDA (review 1).** Load acceptance run, logging of the priority calls, ARGB vs NV12 measurement, the fps-cap hint.
- **`lowDelayKeyFrameScale`.** Set per mode.
- **Window capture details (review 2).** Window lifecycle, HDR detection, VUI signalling, hybrid GPUs, and Sunshine's border handling and 4 ms `MinUpdateInterval` adopted.
- **NVENC session limit.** Corrected to 12 [13]. Grouping is by codec × tier, so the 0.1.5 per-viewer menu keeps working.

*Presentation, UI and audio*
- **One Mac presenter (both reviews).** Metal from Phase 1a; AVSBDL only if the spike fails. "V-Sync aus" made conditional on hiding the webview.
- **WKWebView background** is set transparent at runtime, with a bundled-app spike (review 2).
- **Tauri `Channel` IPC cost (review 1).** WebSocket delivery from the worker, with a spike.
- **PCM packet size.** 5 ms packets, about 2 Mbit/s.
- **One-line overlay**, and the "Direkt" naming clash removed.
- **Bluetooth latency, the Wi-Fi acceptance run, the log location and rotation** added.

*Mixed rooms and scope*
- **Mixed rooms (review 1).** Resolved more cheaply than either suggested option on Windows: the HWND is already available from the getDisplayMedia track (`hwndOf()`), so both paths coexist without a second prompt. Option B (second capture) applies only to Mac and Linux sharers until str0m in Phase 5. The browser edition `StreamTunnel.html` makes Kompatibel permanent, a point neither review raised.
- **Phase 1 split into 1a (LAN) and 1b (Internet).** Phase 1a is LAN-only, and the native path stays off for non-LAN links until the controller exists.

**Rejected or changed**
- **Review 1, "or derive the keys from the handshake hash":** rejected. The Noise handshake hash is a transcript hash, not a secret; keys must come from the split.
- **Review 2, "Phase 1a ≈ 4–5 dw":** rejected as too optimistic. Phase 1a is 8–12 dw even after the scope cuts.
- **Review 1, "Phase 1 ≈ 18–25 dw":** partly accepted. 1a + 1b = 11–17 dw, made possible by cutting the native picker, NACK, the H.264 and WebCodecs fallback on the Mac, and non-NVIDIA sharers.
- **Review 1, "happy eyeballs" in general:** rejected. Running Kompatibel in parallel needs a second capture, or a second prompt on Mac and Linux. Kept only for Windows shares, whose webview track already exists.
- **Review 2, "RequestAccessAsync(Borderless) requires a manifest capability":** the sources conflict. Research says the capability is needed by packaged apps, and OBS calls the API. The plan follows Sunshine and calls `IsBorderRequired(false)` directly, then verifies on the owner's PC.
- **Review 2, "localhost WebSocket or shared buffers":** the WebSocket is the plan. WebView2 shared buffers stay an UNVERIFIED alternative for Windows only.
- **Review 1, "Moonlight now defaults to libplacebo":** noted, but libplacebo/MoltenVK is not adopted because of the size budget. Moonlight's Metal renderer is the model.
- **Review 2, "build both presenters":** the reviews agreed not to, and the plan builds only one.
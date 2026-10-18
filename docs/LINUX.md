# StreamTunnel on Linux (Tauri, no Electron)

Status: **decision record + implementation notes** for the Linux build of the same Tauri app.
Target user: CachyOS / Arch (KDE or GNOME, Wayland or X11). Hard requirements: small Tauri app, no bundled
browser engine, same signaling protocol as Windows/macOS so everybody meets in the same tunnel.

## 1. The problem

Tauri renders through the system web engine. On Linux that is **WebKitGTK** (`webkit2gtk-4.1`), and distros
build it **without WebRTC**: `RTCPeerConnection` is `undefined`.

* Arch `webkit2gtk-4.1` is 2.54.1 (Oct 2026) and its PKGBUILD passes no WebRTC option
  ([PKGBUILD](https://gitlab.archlinux.org/archlinux/packaging/packages/webkit2gtk-4.1/-/blob/main/PKGBUILD)).
* In the 2.54 branch `ENABLE_WEB_RTC` defaults to `OFF` for the GTK port (in 2.46–2.50 it was tied to
  `ENABLE_EXPERIMENTAL_FEATURES`) — [`OptionsGTK.cmake` (webkitglib/2.54)](https://github.com/WebKit/WebKit/blob/webkitglib/2.54/Source/cmake/OptionsGTK.cmake).
  The runtime switch `WebKitSettings:enable-webrtc` therefore has nothing to switch on.
* The GstWebRTC backend is still "in progress" upstream
  ([FOSDEM 2026 talk](https://fosdem.org/2026/schedule/event/KMMLGM-webrtc_support_in_webkitgtk_and_wpewebkit_with_gstreamer_current_status_and_plan/)).

What WebKitGTK **does** ship enabled (same files):

* `ENABLE_WEB_CODECS` = `ON` at build time, and `WebCodecsVideoEnabled` / `WebCodecsAudioEnabled` default to
  `true` for `USE(GSTREAMER)` ports since 2.46
  ([`UnifiedWebPreferences.yaml` (webkitglib/2.54)](https://github.com/WebKit/WebKit/blob/webkitglib/2.54/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml);
  WebCodecs arrived in [WebKitGTK 2.44](https://webkitgtk.org/2024/03/27/webkigit-2.44.html)).
  WebCodecs needs a secure context — wry registers Tauri's custom scheme as secure
  (`wry/src/webkitgtk/web_context.rs`, `register_uri_scheme_as_secure`).
* `ENABLE_MEDIA_STREAM` = `ON` (runtime-off unless `enable-media-stream` is set).
* WebKitGTK itself is built on **GStreamer**: Arch's `webkit2gtk-4.1` already depends on `gstreamer`,
  `gst-plugins-base-libs` and `gst-plugins-bad-libs` (the latter contains `libgstwebrtc-1.0`).

## 2. Options compared

| | (a) GStreamer `webrtcbin` in Rust | (b) webrtc-rs / str0m in Rust + WebCodecs | (c) others |
|---|---|---|---|
| Transport (ICE/DTLS/SRTP/SCTP) | C library from gst-plugins-bad + libnice; years of Chrome interop (NACK/RTX, PLI, data channels, TURN) | webrtc-rs: full stack but tokio + ~5–8 MB extra, API in flux (sans-IO rewrite). str0m: small, but sans-IO without STUN gathering/TURN client — we would write ICE plumbing ourselves | **libwebrtc crate** (LiveKit): prebuilt Google libwebrtc, +15–25 MB → violates "small". **CEF/Electron/WPE-with-own-engine**: bundled engine, rejected. **`enable-webrtc` on WebKitGTK**: not compiled in distro builds (see §1) |
| Binary size | bindings only (≈1–2 MB); libraries are system packages like webkit2gtk | +5–8 MB (webrtc-rs) | — |
| Decoding | GStreamer decoders (VA-API / NVDEC / libav) | WebCodecs in WebKitGTK = the same GStreamer decoders | — |
| Audio | `opusdec` → PipeWire/Pulse sink, trivial | needs Opus decode (libopus or WebCodecs AudioDecoder + WebAudio worklet) | — |
| Sharing later | `pipewiresrc` from the xdg-desktop-portal ScreenCast session (`ashpd`) → VA-API/x264 encoder → `webrtcbin` — all in one place | portal + PipeWire + encoder + packetizer by hand | — |
| Risk | GLib/GStreamer API surface in Rust; needs plugin packages | interop corner cases, more code we own | — |

Rendering the picture *inside the Tauri window* is the second half of the problem:

* GTK embedding (`gtksink`/`gtkglsink` under a transparent WebKitWebView in a `GtkOverlay`) means re-parenting
  wry's widget tree and relies on GL/transparency behaviour that differs between X11/Wayland/NVIDIA — hard to
  test headless.
* A separate native video window (`autovideosink`) works but is poor UX.
* **WebCodecs `VideoDecoder` → `<canvas>`** inside the existing page: the UI (overlays, fullscreen, stats,
  keyboard shortcuts) keeps working unchanged, and only the *encoded* bitstream (a few MB/s) crosses the
  Rust→JS IPC (a Tauri `Channel` carrying raw bytes, not JSON).

## 3. Decision

**Hybrid of (a) and (b): GStreamer `webrtcbin` in Rust for the transport + WebCodecs in WebKitGTK for video.**

```
 Windows/macOS member (WebView2/WKWebView, unchanged)         Linux member (Tauri + WebKitGTK)
 HostSession ── encrypted MQTT signaling (TS, unchanged) ──►  ViewerSession (TS, unchanged logic)
                                                                │  uses NativePeerConnection (TS shim)
                                                                ▼  invoke / Channel
 RTCPeerConnection ════ DTLS-SRTP / SCTP (P2P) ═════════════►  Rust: webrtcbin (cfg linux)
                                                                ├ video: rtph264depay → h264parse → appsink
                                                                │        → Channel(bytes) → WebCodecs → <canvas>
                                                                ├ audio: rtpopusdepay → opusdec → volume → pulsesink (40 ms)
                                                                └ data channel "ctl" (negotiated id 0) ⇄ TS
```

Why this has the best chance of working on CachyOS soon:

1. Every piece is already in the distro and enabled by default: GStreamer (a hard dependency of webkit2gtk),
   `webrtcbin` (gst-plugins-bad), libnice, WebCodecs (WebKitGTK ≥ 2.46). No experimental build flags.
2. The binary stays small: Rust bindings only (`gstreamer` 0.21 shares `glib` 0.18 with Tauri's gtk-rs, so no
   second copy of the GLib bindings).
3. The protocol logic (join loop, reconnects, ctl channel, stats, tunnel) stays in **one** TypeScript
   implementation: the Linux path only swaps `RTCPeerConnection` for a small shim, selected by
   `nativeRtcActive()` = Tauri app **and** a Linux user agent — deliberately not
   `typeof RTCPeerConnection === 'undefined'`, so a future WebKitGTK with WebRTC cannot silently swap engines.
   Windows/macOS code paths are untouched.
4. It is testable headless in CI: the real app runs under Xvfb, joins a tunnel in which headless Chrome shares
   the test picture, and reports decoded frames + non-black canvas pixels.

Codec: the Linux watcher answers with **H.264 only** (+ Opus + the data channel). It announces `dec: ['H264']`
in its join, so a sharer in `auto` mode picks H.264; an explicit AV1/VP9 preference on the sharer still works
because the answer lists only H.264 (the sharer's browser sends what the answer allows). AV1 can be added later
(`rtpav1depay` + WebCodecs `av01`).

Not chosen for now:

* **Native GTK video sink in the window** — kept as a fallback idea if WebCodecs turns out too slow on some GPUs.
* **webrtc-rs/str0m** — more code to own and bigger binary for no gain over webrtcbin.

## 4. Runtime dependencies (Linux packages)

Arch / CachyOS (`pacman -S --needed …`):

```
webkit2gtk-4.1 gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad libnice gst-libav
```

* `gst-plugins-bad` → `webrtcbin`, `dtlssrtpenc/dec`, `srtp`, `sctp` · `libnice` → `nicesrc/nicesink`
  · `gst-plugins-good` → RTP (de)payloaders, `rtpbin`, `autoaudiosink`, Pulse sink · `gst-libav` → H.264
  software decoder for WebCodecs (VA-API `vah264dec` from gst-plugins-bad is used automatically when available).
* Debian/Ubuntu: `libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good
  gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-libav gstreamer1.0-pulseaudio` (the `.deb` declares them).
* AppImage: the system GStreamer is used — CI builds it with `LINUXDEPLOY_EXCLUDED_LIBRARIES='libgst*'`, because a
  bundled (older) GStreamer core rejects the newer system plugins. On Arch the AppImage runtime needs `fuse2`.

The app checks for the required GStreamer elements at start of a watch and shows which package is missing.

## 5. Implementation (as built)

| File | Role |
|---|---|
| `src-tauri/linux-media/` (crate `st-linux-media`, Linux only) | the engine: one `Peer` = one `webrtcbin` answerer; H.264 → `appsink` (Annex B access units), Opus → `opusdec` → `volume` → `pulsesink buffer-time=40000 latency-time=10000` (fallback `autoaudiosink`), negotiated data channel "ctl" (id 0), stats, PLI on request. `tests/loopback.rs` = GStreamer sender ↔ engine without a browser. |
| `src-tauri/src/media.rs` (cfg linux) | Tauri commands `media_probe/create/remote/answer/ice/dc_send/volume/latency/keyframe/stats/close`; events + raw video frames over one `Channel` (`[flags][pts µs][AU]`). Plus the E2E hooks `test_config/test_report` and the driver injection — inert unless `ST_E2E_JOIN` is set. |
| `src/rtc/native.ts` | `NativePeerConnection` (RTCPeerConnection-shaped answerer), `NativeDataChannel`, WebCodecs `VideoDecoder` → `<canvas id="viewer-canvas">` laid over the watch view's `#viewer-video`; GStreamer volume follows `#viewer-audio` (slider / mute). Pure helpers: `filterOfferForNative`, `ensureTransportCc`, `addCandidatesToSdp`, `avcCodecString` (`tests/rtc-native.test.ts`). |
| `src/rtc/tuning.ts`, `viewer.ts`, `tunnel.ts`, `codecs.ts` | 1–3 line hooks: create the stand-in on Linux, placeholder tracks hand no MediaStream to the UI, no relaying from Linux, `dec = ['H264']`. |
| `tests/e2e/linux-tauri.mjs` + `linux-app-driver.js` | CI end-to-end: headless Chrome shares the test picture, the built app (Xvfb) joins via the real UI and checks moving, non-black canvas pixels + fps; the sharer must list it as connected. |
| `packaging/linux`, `packaging/arch/PKGBUILD` | tarball contents (desktop file, README) and an Arch package of the release tarball. |

Details that matter:

* **Codec choice.** The offer is reduced to H.264 (packetization-mode=1) + its RTX, Opus and the data channel;
  webrtcbin answers exactly that, so the sharer's browser sends H.264 whatever it prefers.
* **Bandwidth estimation (TWCC).** transport-cc is *kept*: after `set-remote-description` every transceiver gets
  the offer's codecs as `codec-preferences` incl. rtcp-fb and the header extensions (`extmap-N` caps fields,
  `offer_codec_preferences`), so the answer echoes transport-cc and rtpsession generates TWCC feedback (its
  receive caps carry the extension id). If webrtcbin still drops it from the answer text, `ensureTransportCc`
  restores the lines. Without TWCC, Chrome's estimate does not ramp up.
* **Latency.** webrtcbin jitterbuffer 40 ms (`smooth` mode adds the receiver's `jitterBufferTarget`), appsink
  `sync=false`, WebCodecs `optimizeForLatency`, frames drawn as soon as they are decoded; a decoder that falls
  behind skips to the next key frame (PLI).
* **Hardware decode.** `VideoDecoder` is configured with `hardwareAcceleration: 'prefer-hardware'` when
  `isConfigSupported` says so (VA-API `gst-plugin-va`, NVDEC), else `'no-preference'` (gst-libav / openh264).
* **Half-trickle.** Candidates gathered before the answer is sent are merged into the answer SDP
  (`addCandidatesToSdp`), later ones are trickled like on Windows.
* **Missing packages** are detected (`media_probe` checks the element factories) and shown as a toast naming the
  Arch / Debian package.

## 6. Status / plan

* [x] Decision (this file).
* [x] MVP code: watch a Windows/macOS member (video via WebCodecs, audio via GStreamer); CI job
      "Desktop (linux-tauri)" (engine loopback test, AppImage + deb + tarball, headless end-to-end test).
      Verified on the dev PC: `cargo check`/`clippy` for `x86_64-unknown-linux-gnu` (cross, without linking),
      `npx tsc --noEmit`, `npm test`. **Pending: the first CI run on Ubuntu** (link, loopback, E2E, sizes).
* [ ] Measure WebCodecs latency / CPU at 1080p60 and 1440p60 on a real CachyOS box (Intel/AMD VA-API, NVIDIA).
* [ ] Sharing from Linux: system `webrtcsink` (Arch `gst-plugin-rswebrtc`) driven only through its `signaller`
      property (signal overrides, no gst-plugin-webrtc crate linked) — gives GCC congestion control, VA/NVENC
      encoders, RTX/FEC — fed by the xdg-desktop-portal ScreenCast session (`ashpd` → `pipewiresrc`) and the
      default sink's monitor for audio. The TS side then needs a HostSession counterpart for the native path.
* [ ] Relay (re-sharing a received stream) on Linux: off (`allowRelay` is forced to false on the native path, so
      the sharer never redirects others to a Linux watcher).
* [ ] AV1 (`rtpav1depay` + WebCodecs `av01`) once measured.

Known limits: a macOS sharer (WKWebView) hides its LAN addresses behind mDNS names; webrtcbin resolves `.local`
candidates through the system resolver (needs avahi + nss-mdns), otherwise the connection goes via STUN (srflx).

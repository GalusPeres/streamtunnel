//! Native media path (docs/NATIVE-PATH.md): the Tauri glue between the page (`src/rtc/nativelink.ts`) and the
//! `st-media` crate. Every OS can watch natively; sharing needs Windows + NVENC.
//!
//! One `st_media::Endpoint` (the app's UDP socket) is opened lazily. Each sharer–viewer pair is a link, created
//! with `nm_link_open` and fed the peer's parameters (from the `nv` signaling) with `nm_link_remote`. A link's
//! events flow back over its Tauri `Channel`:
//! * JSON `{t:'cand'|'up'|'fail'|'closed'|'msg'|'stats', …}` (docs/NATIVE-PATH.md §9.2);
//! * raw bytes (watch links only) = one video access unit or 20 ms of PCM, see [`video_message`] /
//!   [`audio_message`].
//!
//! A share (`nm_share_open`) owns one `win::CaptureSession` + `send::Sender` per codec in use, started when the
//! first link of that codec is added and stopped with its last link. Its own `Channel` gets `{t:'info'|'stats'|
//! 'ended'|'err', …}`. Share sound: while a share with audio is open, the WASAPI capture of `sysaudio.rs` (the one
//! the page already runs for the WebRTC track) is tapped, converted to s16 and pushed to every sender in 5 ms
//! chunks.
//!
//! Locks: the link table and the share table are separate and never held together; link sinks (called on the
//! endpoint's threads) take neither, they only forward to a `Channel`. Commands that may block (endpoint, probe,
//! capture start / stop) run on the blocking pool, never on the main thread.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use st_media::net::ctrl::ByeReason;
use st_media::recv::{Receiver, RecvEvent};
use st_media::stats::RecvStats;
use st_media::{Candidate, CandidateKind, Endpoint, EndpointConfig, Link, LinkEvent, LinkSink, Role};
use tauri::ipc::{Channel, InvokeResponseBody};

/// What this app can do natively (`nm_caps`).
#[derive(Serialize)]
pub struct NmCaps {
    /// stm version and oldest version we talk to
    v: u8,
    min: u8,
    /// sharing: Some when NVENC works (Windows only)
    share: Option<ShareCaps>,
    /// receiving: the Rust side works on this OS (the page still checks WebCodecs)
    watch: bool,
}

#[derive(Serialize)]
pub struct ShareCaps {
    /// "hevc" | "h264", best first
    codecs: Vec<String>,
    /// adapter name, e.g. "NVIDIA GeForce RTX 4080"
    gpu: String,
}

/// A candidate as the signaling carries it.
#[derive(Serialize, Deserialize, Clone)]
pub struct CandidateWire {
    /// "ip:port" | "[v6]:port"
    a: String,
    /// "host" | "srflx"
    k: String,
}

#[derive(Serialize)]
pub struct LinkOpened {
    /// our link id (the peer puts it in every packet header)
    link: u32,
    /// our key half, 64 hex digits
    key: String,
    /// host candidates (+ cached srflx); later ones arrive as {t:'cand'}
    cand: Vec<CandidateWire>,
}

/// `nm_share_open` settings (camelCase from TypeScript). Read only by the Windows sharer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ShareCfg {
    /// the getDisplayMedia track's deviceId: "window:<hwnd>:0" | "screen:<id>:0"
    source: String,
    /// the track's size (screen matching hint)
    width: u32,
    height: u32,
    fps: u32,
    /// resolution cap in lines, 0 = native
    max_height: u32,
    /// the user's bitrate, 0 = Auto (LAN model)
    kbps: u32,
    /// send share sound
    audio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ShareUpdate {
    fps: u32,
    max_height: u32,
    kbps: u32,
}

/// Highest bitrate a page may ask for (kbit/s): the UI's slider ends at 60 Mbit/s, the LAN model at 100.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_KBPS: u32 = 200_000;

#[cfg_attr(not(windows), allow(dead_code))]
fn clamp_fps(fps: u32) -> u32 {
    fps.clamp(1, 240)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn send_json(ch: &Channel<InvokeResponseBody>, v: &Value) {
    let _ = ch.send(InvokeResponseBody::Json(v.to_string()));
}

/// `ST_NATIVE=0` turns the native path off (everything stays on WebRTC), for comparisons and as an escape hatch.
fn disabled() -> bool {
    static OFF: OnceLock<bool> = OnceLock::new();
    *OFF.get_or_init(|| std::env::var("ST_NATIVE").map(|v| v.trim() == "0").unwrap_or(false))
}

// ───────────────────────── links ─────────────────────────

struct LinkEntry {
    link: Arc<Link>,
    /// watch links only
    receiver: Option<Arc<Receiver>>,
}

#[derive(Default)]
struct Links {
    endpoint: Option<Arc<Endpoint>>,
    /// STUN list the endpoint was given last
    stun: Vec<String>,
    map: HashMap<u32, LinkEntry>,
}

fn links() -> &'static Mutex<Links> {
    static LINKS: OnceLock<Mutex<Links>> = OnceLock::new();
    LINKS.get_or_init(|| Mutex::new(Links::default()))
}

fn link(id: u32) -> Result<Arc<Link>, String> {
    links().lock().map_err(|_| "poisoned".to_string())?.map.get(&id).map(|e| e.link.clone()).ok_or_else(|| "unknown link".to_string())
}

/// The app's endpoint, opened on first use; a changed STUN list is handed on.
fn endpoint(stun: &[String]) -> Result<Arc<Endpoint>, String> {
    let mut g = links().lock().map_err(|_| "poisoned".to_string())?;
    if let Some(ep) = &g.endpoint {
        let ep = ep.clone();
        if g.stun != stun {
            ep.set_stun(stun.to_vec());
            g.stun = stun.to_vec();
        }
        return Ok(ep);
    }
    let ep = Endpoint::open(EndpointConfig { stun: stun.to_vec(), loopback: false }).map_err(|e| format!("udp socket: {e}"))?;
    eprintln!("[native] endpoint on UDP port {}", ep.port());
    g.endpoint = Some(ep.clone());
    g.stun = stun.to_vec();
    Ok(ep)
}

/// Candidates for the signaling (peer-reflexive ones are learned, never signaled).
fn wire_candidates(c: &[Candidate]) -> Vec<CandidateWire> {
    c.iter()
        .filter(|c| c.kind != CandidateKind::Prflx)
        .map(|c| CandidateWire { a: c.addr_string(), k: c.kind.as_str().to_string() })
        .collect()
}

/// Candidates from the signaling (the page validated them already; anything Rust rejects is skipped).
fn parse_candidates(c: &[CandidateWire]) -> Vec<Candidate> {
    c.iter().filter_map(|c| Candidate::parse(&c.a, &c.k)).take(st_media::net::ice::MAX_REMOTE_CANDIDATES).collect()
}

fn bye_reason(reason: &str) -> ByeReason {
    match reason {
        "kicked" => ByeReason::Kicked,
        "ended" => ByeReason::Ended,
        _ => ByeReason::Closed,
    }
}

/// A link event as the page gets it (docs/NATIVE-PATH.md §9.2). `recv` = the watch link's receiver stats.
fn event_json(ev: &LinkEvent, recv: Option<RecvStats>) -> Value {
    match ev {
        LinkEvent::Candidates(c) => json!({ "t": "cand", "cand": wire_candidates(c) }),
        LinkEvent::Up(p) => json!({ "t": "up", "remote": p.remote.to_string(), "lan": p.lan, "rttMs": p.rtt_us as f64 / 1000.0 }),
        LinkEvent::Failed(r) => json!({ "t": "fail", "reason": r }),
        LinkEvent::Closed(r) => json!({ "t": "closed", "reason": r }),
        LinkEvent::Message(m) => json!({ "t": "msg", "m": m }),
        LinkEvent::Stats(s) => match recv {
            Some(r) => json!({ "t": "stats", "link": s, "recv": r }),
            None => json!({ "t": "stats", "link": s }),
        },
    }
}

/// Forwards a link's events to its Channel (runs on the endpoint's threads: no locks, no waiting).
fn link_sink(events: Channel<InvokeResponseBody>, receiver: Arc<OnceLock<Arc<Receiver>>>) -> LinkSink {
    Arc::new(move |ev: LinkEvent| {
        if let LinkEvent::Failed(r) | LinkEvent::Closed(r) = &ev {
            eprintln!("[native] link {}: {r}", if matches!(ev, LinkEvent::Failed(_)) { "failed" } else { "closed" });
        }
        let recv = match &ev {
            LinkEvent::Stats(_) => receiver.get().map(|r| r.stats()),
            _ => None,
        };
        send_json(&events, &event_json(&ev, recv));
    })
}

/// New link on the app's endpoint. `role` = "share" | "watch"; `stun` = NetConfig.stun.
#[tauri::command]
pub async fn nm_link_open(role: String, stun: Vec<String>, events: Channel<InvokeResponseBody>) -> Result<LinkOpened, String> {
    if disabled() {
        return Err("native path disabled (ST_NATIVE=0)".into());
    }
    let role = match role.as_str() {
        "share" => Role::Share,
        "watch" => Role::Watch,
        _ => return Err(format!("unknown role '{role}'")),
    };
    let stun: Vec<String> = stun.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(8).collect();
    blocking(move || {
        let ep = endpoint(&stun)?;
        let cell: Arc<OnceLock<Arc<Receiver>>> = Arc::new(OnceLock::new());
        let link = ep.create_link(role, link_sink(events.clone(), cell.clone()))?;
        let receiver = (role == Role::Watch).then(|| {
            let ch = events.clone();
            let r = Receiver::attach(
                &link,
                Arc::new(move |ev: RecvEvent| {
                    let bytes = match &ev {
                        RecvEvent::Video(au) => video_message(au),
                        RecvEvent::Audio(block) => audio_message(block),
                    };
                    let _ = ch.send(InvokeResponseBody::Raw(bytes));
                }),
            );
            let _ = cell.set(r.clone());
            r
        });
        let opened = LinkOpened { link: link.id(), key: st_media::to_hex(&link.key_half()), cand: wire_candidates(&link.local_candidates()) };
        links().lock().map_err(|_| "poisoned".to_string())?.map.insert(link.id(), LinkEntry { link, receiver });
        Ok(opened)
    })
    .await
}

/// The peer's link id, key half and candidates (from the `nv` join / offer): starts probing.
#[tauri::command]
pub async fn nm_link_remote(link: u32, peer_link: u32, key: String, cand: Vec<CandidateWire>) -> Result<(), String> {
    let key = st_media::parse_hex32(&key).ok_or("bad key")?;
    self::link(link)?.set_remote(peer_link, key, &parse_candidates(&cand))
}

/// Late remote candidates (`nvice`).
#[tauri::command]
pub async fn nm_link_cand(link: u32, cand: Vec<CandidateWire>) -> Result<(), String> {
    self::link(link)?.add_remote_candidates(&parse_candidates(&cand));
    Ok(())
}

/// Reliable App text (a CtlMessage as JSON) to the peer.
#[tauri::command]
pub async fn nm_link_send(link: u32, text: String) -> Result<(), String> {
    self::link(link)?.send_message(&text)
}

/// Watch link: the page's decoder needs a key frame.
#[tauri::command]
pub async fn nm_link_keyframe(link: u32) -> Result<(), String> {
    let r = links().lock().map_err(|_| "poisoned".to_string())?.map.get(&link).and_then(|e| e.receiver.clone());
    r.ok_or("not a watch link")?.request_keyframe();
    Ok(())
}

/// Ends a link (Bye with `reason` = "closed" | "kicked" | "ended") and forgets it. Idempotent.
#[tauri::command]
pub async fn nm_link_close(link: u32, reason: String) -> Result<(), String> {
    blocking(move || {
        close_link(link, bye_reason(&reason));
        Ok(())
    })
    .await
}

fn close_link(id: u32, reason: ByeReason) {
    let entry = links().lock().ok().and_then(|mut g| g.map.remove(&id));
    // no sender may feed it any more (its capture stops with its last link)
    #[cfg(windows)]
    share::forget_link(id);
    if let Some(e) = entry {
        if let Some(r) = e.receiver {
            r.close();
        }
        e.link.close(reason);
    }
}

// ───────────────────────── caps ─────────────────────────

#[tauri::command]
pub async fn nm_caps() -> NmCaps {
    let off = disabled();
    let share = if off { None } else { blocking(|| Ok(share_caps())).await.unwrap_or(None) };
    NmCaps { v: st_media::STM_VERSION, min: st_media::STM_MIN_VERSION, share, watch: !off }
}

#[cfg(windows)]
fn share_caps() -> Option<ShareCaps> {
    let c = st_media::win::probe();
    if !c.available {
        eprintln!("[native] no native sharing: {}", c.reason);
        return None;
    }
    let mut codecs = Vec::new();
    if c.hevc {
        codecs.push("hevc".to_string());
    }
    if c.h264 {
        codecs.push("h264".to_string());
    }
    (!codecs.is_empty()).then_some(ShareCaps { codecs, gpu: c.gpu })
}

#[cfg(not(windows))]
fn share_caps() -> Option<ShareCaps> {
    None
}

// ───────────────────────── shares ─────────────────────────

/// Opens a native share for the page's current capture. Nothing is captured until the first link is added.
#[tauri::command]
pub async fn nm_share_open(cfg: ShareCfg, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    if disabled() {
        return Err("native path disabled (ST_NATIVE=0)".into());
    }
    #[cfg(windows)]
    return blocking(move || share::open(cfg, events)).await;
    #[cfg(not(windows))]
    {
        let _ = (cfg, events);
        Err("native sharing needs Windows with NVENC".into())
    }
}

/// Streams `codec` ("hevc" | "h264") of this share to a share link once it is up. `rfi` = the viewer recovers
/// from reference invalidation (false for every WebCodecs viewer in this milestone).
#[tauri::command]
pub async fn nm_share_add(share: u32, link: u32, codec: String, rfi: bool) -> Result<(), String> {
    let codec = st_media::Codec::from_name(&codec).ok_or("unknown codec")?;
    let link = self::link(link)?;
    #[cfg(windows)]
    return blocking(move || share::get(share)?.add_link(&link, codec, rfi)).await;
    #[cfg(not(windows))]
    {
        let _ = (share, link, codec, rfi);
        Err("native sharing needs Windows with NVENC".into())
    }
}

/// Stops feeding a link (it stays open, e.g. to send the ctl 'bye').
#[tauri::command]
pub async fn nm_share_remove(share: u32, link: u32) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || {
        if let Ok(s) = share::get(share) {
            s.remove_link(link);
        }
        Ok(())
    })
    .await;
    #[cfg(not(windows))]
    {
        let _ = (share, link);
        Ok(())
    }
}

/// The user changed fps / resolution cap / bitrate (fps + resolution: reconfigure + IDR; bitrate: no IDR).
#[tauri::command]
pub async fn nm_share_update(share: u32, cfg: ShareUpdate) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || share::get(share)?.update(clamp_fps(cfg.fps), cfg.max_height, cfg.kbps.min(MAX_KBPS))).await;
    #[cfg(not(windows))]
    {
        let _ = (share, cfg);
        Err("native sharing needs Windows with NVENC".into())
    }
}

/// The user picked another source ("Quelle wechseln").
#[tauri::command]
pub async fn nm_share_source(share: u32, source: String, width: u32, height: u32) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || share::get(share)?.set_source(&source, width, height)).await;
    #[cfg(not(windows))]
    {
        let _ = (share, source, width, height);
        Err("native sharing needs Windows with NVENC".into())
    }
}

/// Stops capture + encoders of a share (its links stay open; the page closes them). Idempotent.
#[tauri::command]
pub async fn nm_share_close(share: u32) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || {
        share::close(share);
        Ok(())
    })
    .await;
    #[cfg(not(windows))]
    {
        let _ = share;
        Ok(())
    }
}

/// Closes every share and link (window closed / page reloaded).
pub fn close_all() {
    #[cfg(windows)]
    share::close_all();
    let (map, endpoint) = match links().lock() {
        Ok(mut g) => (std::mem::take(&mut g.map), g.endpoint.take()),
        Err(_) => return,
    };
    for (_, e) in map {
        if let Some(r) = e.receiver {
            r.close();
        }
        e.link.close(ByeReason::Closed);
    }
    if let Some(ep) = endpoint {
        ep.close();
    }
}

/// Windows sharer: one capture + sender per codec in use, the sound tap, a stats thread per share.
#[cfg(windows)]
mod share {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use serde_json::json;
    use st_media::send::{Sender, SenderConfig, ViewerCaps};
    use st_media::win::{CaptureConfig, CaptureSession, Source};
    use st_media::{AudioChunk, Codec, Link};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::{clamp_fps, send_json, ShareCfg, MAX_KBPS};

    /// VBV in frames (docs/NATIVE-PATH.md §3.3).
    const VBV_FRAMES: f32 = 2.0;
    const STATS_MS: u64 = 1000;

    /// One codec of a share: its capture + encoder, the sender fanning it out, the links it feeds.
    struct Pipe {
        codec: Codec,
        capture: CaptureSession,
        sender: Arc<Sender>,
        links: Vec<u32>,
        /// target last handed to the sender (Auto follows the encoder size)
        target_kbps: u32,
        /// size last announced with {t:'info'}
        size: (u32, u32),
    }

    struct Inner {
        source: Source,
        fps: u32,
        max_height: u32,
        kbps: u32,
        gpu: String,
        pipes: Vec<Pipe>,
        /// {t:'ended'} was sent
        ended: bool,
    }

    pub(super) struct Share {
        id: u32,
        events: Channel<InvokeResponseBody>,
        inner: Mutex<Inner>,
        alive: AtomicBool,
        /// senders that get the share sound (read by the sysaudio tap)
        audio_out: Arc<Mutex<Vec<Arc<Sender>>>>,
    }

    fn shares() -> &'static Mutex<HashMap<u32, Arc<Share>>> {
        static SHARES: OnceLock<Mutex<HashMap<u32, Arc<Share>>>> = OnceLock::new();
        SHARES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// The share whose sound tap is installed (0 = none).
    static TAP_OWNER: AtomicU32 = AtomicU32::new(0);

    pub(super) fn get(id: u32) -> Result<Arc<Share>, String> {
        shares().lock().map_err(|_| "poisoned".to_string())?.get(&id).cloned().ok_or_else(|| "unknown share".to_string())
    }

    pub(super) fn open(cfg: ShareCfg, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
        static NEXT: AtomicU32 = AtomicU32::new(1);
        let caps = st_media::win::probe();
        if !caps.available {
            return Err(format!("no NVENC: {}", caps.reason));
        }
        let source = st_media::win::parse_source(&cfg.source, cfg.width, cfg.height)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let share = Arc::new(Share {
            id,
            events,
            inner: Mutex::new(Inner {
                source,
                fps: clamp_fps(cfg.fps),
                max_height: cfg.max_height,
                kbps: cfg.kbps.min(MAX_KBPS),
                gpu: caps.gpu,
                pipes: Vec::new(),
                ended: false,
            }),
            alive: AtomicBool::new(true),
            audio_out: Arc::new(Mutex::new(Vec::new())),
        });
        if cfg.audio {
            crate::sysaudio::set_tap(Some(audio_tap(share.audio_out.clone())));
            TAP_OWNER.store(id, Ordering::Relaxed);
        }
        shares().lock().map_err(|_| "poisoned".to_string())?.insert(id, share.clone());
        let weak = Arc::downgrade(&share);
        std::thread::Builder::new()
            .name("st-nm-share".into())
            .spawn(move || stats_loop(weak))
            .map_err(|e| e.to_string())?;
        eprintln!("[native] share {id} open: {source:?}");
        Ok(id)
    }

    /// Converts the page capture's 20 ms f32 chunks into 5 ms s16 chunks for every sender of the share.
    fn audio_tap(out: Arc<Mutex<Vec<Arc<Sender>>>>) -> crate::sysaudio::Tap {
        let mut seq: u32 = 0;
        Box::new(move |pcm: &[f32]| {
            let senders = match out.lock() {
                Ok(v) if !v.is_empty() => v.clone(),
                _ => return,
            };
            let per = st_media::AUDIO_PACKET_FRAMES * st_media::AUDIO_CHANNELS;
            let dur = st_media::AUDIO_PACKET_FRAMES as u64 * 1_000_000 / st_media::AUDIO_RATE as u64;
            let n = (pcm.len() / per) as u64;
            let first = st_media::clock::now_us().saturating_sub(n * dur);
            for (i, part) in pcm.chunks_exact(per).enumerate() {
                let chunk = AudioChunk { seq, capture_us: first + i as u64 * dur, pcm: to_s16(part) };
                seq = seq.wrapping_add(1);
                for s in &senders {
                    s.push_audio(&chunk);
                }
            }
        })
    }

    pub(super) fn to_s16(x: &[f32]) -> Vec<i16> {
        x.iter().map(|v| (v.clamp(-1.0, 1.0) * 32767.0).round() as i16).collect()
    }

    impl Share {
        pub(super) fn add_link(&self, link: &Arc<Link>, codec: Codec, rfi: bool) -> Result<(), String> {
            let mut g = self.inner.lock().map_err(|_| "poisoned".to_string())?;
            let id = link.id();
            // a link watches one codec: drop it from another one first (never happens with our page)
            let stopped = take_link(&mut g, id, Some(codec));
            if !g.pipes.iter().any(|p| p.codec == codec) {
                let pipe = start_pipe(&g, codec)?;
                if let Ok(mut out) = self.audio_out.lock() {
                    out.push(pipe.sender.clone());
                }
                send_json(&self.events, &info_json(codec, &g.gpu, &pipe.capture.stats()));
                g.pipes.push(pipe);
            }
            if let Some(p) = g.pipes.iter_mut().find(|p| p.codec == codec) {
                if !p.links.contains(&id) {
                    p.sender.add_link(link, ViewerCaps { rfi });
                    p.links.push(id);
                }
            }
            drop(g);
            self.stop_pipes(stopped);
            Ok(())
        }

        pub(super) fn remove_link(&self, id: u32) {
            let stopped = match self.inner.lock() {
                Ok(mut g) => take_link(&mut g, id, None),
                Err(_) => return,
            };
            self.stop_pipes(stopped);
        }

        pub(super) fn update(&self, fps: u32, max_height: u32, kbps: u32) -> Result<(), String> {
            let mut g = self.inner.lock().map_err(|_| "poisoned".to_string())?;
            let resize = fps != g.fps || max_height != g.max_height;
            let rate = kbps != g.kbps;
            g.fps = fps;
            g.max_height = max_height;
            g.kbps = kbps;
            let mut result = Ok(());
            for p in g.pipes.iter_mut() {
                if resize {
                    if let Err(e) = p.capture.reconfigure(fps, max_height) {
                        result = Err(e);
                    }
                }
                if rate {
                    p.capture.set_target(kbps);
                    // a bitrate set by hand is fixed; Auto follows the encoder size (the stats loop forwards it)
                    let target = if kbps > 0 { kbps } else { p.capture.stats().target_kbps };
                    if target > 0 {
                        p.sender.set_target(target, kbps > 0);
                        p.target_kbps = target;
                    }
                }
            }
            result
        }

        pub(super) fn set_source(&self, device_id: &str, width: u32, height: u32) -> Result<(), String> {
            let source = st_media::win::parse_source(device_id, width, height)?;
            let mut g = self.inner.lock().map_err(|_| "poisoned".to_string())?;
            g.source = source;
            g.ended = false;
            for p in g.pipes.iter() {
                p.capture.set_source(source)?;
            }
            Ok(())
        }

        fn stop_pipes(&self, pipes: Vec<Pipe>) {
            for mut p in pipes {
                if let Ok(mut out) = self.audio_out.lock() {
                    out.retain(|s| !Arc::ptr_eq(s, &p.sender));
                }
                p.capture.stop();
                eprintln!("[native] share {}: {} capture stopped", self.id, p.codec.name());
            }
        }

        fn shutdown(&self) {
            self.alive.store(false, Ordering::Relaxed);
            if TAP_OWNER.compare_exchange(self.id, 0, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                crate::sysaudio::set_tap(None);
            }
            let pipes = match self.inner.lock() {
                Ok(mut g) => std::mem::take(&mut g.pipes),
                Err(_) => return,
            };
            for p in &pipes {
                for &l in &p.links {
                    p.sender.remove_link(l);
                }
            }
            self.stop_pipes(pipes);
        }
    }

    /// Removes link `id` from every pipe (except the one of `keep`); returns the pipes left without links.
    fn take_link(g: &mut Inner, id: u32, keep: Option<Codec>) -> Vec<Pipe> {
        for p in g.pipes.iter_mut() {
            if Some(p.codec) != keep && p.links.contains(&id) {
                p.sender.remove_link(id);
                p.links.retain(|&l| l != id);
            }
        }
        let (idle, busy): (Vec<Pipe>, Vec<Pipe>) = std::mem::take(&mut g.pipes).into_iter().partition(|p| p.links.is_empty() && Some(p.codec) != keep);
        g.pipes = busy;
        idle
    }

    /// Capture + encoder for one codec, wired to a new sender (docs/NATIVE-PATH.md §8 "Wiring a share codec").
    fn start_pipe(g: &Inner, codec: Codec) -> Result<Pipe, String> {
        let cell: Arc<OnceLock<Arc<Sender>>> = Arc::new(OnceLock::new());
        let sink_cell = cell.clone();
        let cfg = CaptureConfig { codec, fps: g.fps, max_height: g.max_height, bitrate_kbps: g.kbps, vbv_frames: VBV_FRAMES, cursor: true };
        let capture = CaptureSession::start(
            g.source,
            cfg,
            Box::new(move |f| {
                if let Some(s) = sink_cell.get() {
                    s.push_frame(&f);
                }
            }),
        )?;
        let st = capture.stats();
        let target = if g.kbps > 0 {
            g.kbps
        } else if st.target_kbps > 0 {
            st.target_kbps
        } else {
            st_media::net::rate::lan_bitrate_kbps(st.width.max(1), st.height.max(1), g.fps, codec)
        };
        let sender = Sender::new(SenderConfig { codec, target_kbps: target, fixed: g.kbps > 0 }, capture.request_handle());
        let _ = cell.set(sender.clone());
        eprintln!("[native] {} capture started ({}x{} @ {} fps, {} kbit/s{})", codec.name(), st.width, st.height, g.fps, target, if g.kbps > 0 { ", fixed" } else { "" });
        Ok(Pipe { codec, capture, sender, links: Vec::new(), target_kbps: target, size: (st.width, st.height) })
    }

    fn info_json(codec: Codec, gpu: &str, st: &st_media::win::CaptureStats) -> serde_json::Value {
        json!({ "t": "info", "codec": codec.name(), "encoder": "NVENC", "gpu": gpu, "width": st.width, "height": st.height, "fps": st.fps, "kbps": st.target_kbps })
    }

    /// Once per second while the share is open: stats to the page, Auto targets to the senders, size changes as
    /// {t:'info'}, a closed source window as {t:'ended'}.
    fn stats_loop(share: std::sync::Weak<Share>) {
        loop {
            for _ in 0..(STATS_MS / 100) {
                std::thread::sleep(Duration::from_millis(100));
                match share.upgrade() {
                    Some(s) if s.alive.load(Ordering::Relaxed) => {}
                    _ => return,
                }
            }
            let Some(s) = share.upgrade() else { return };
            let mut out = Vec::new();
            {
                let Ok(mut g) = s.inner.lock() else { return };
                if g.pipes.is_empty() {
                    continue;
                }
                let fixed = g.kbps > 0;
                let mut captures = Vec::new();
                let mut senders = Vec::new();
                let mut closed = false;
                let gpu = g.gpu.clone();
                for p in g.pipes.iter_mut() {
                    let cs = p.capture.stats();
                    if !fixed && cs.target_kbps > 0 && cs.target_kbps != p.target_kbps {
                        p.sender.set_target(cs.target_kbps, false);
                        p.target_kbps = cs.target_kbps;
                    }
                    if (cs.width, cs.height) != p.size {
                        p.size = (cs.width, cs.height);
                        out.push(info_json(p.codec, &gpu, &cs));
                    }
                    closed |= cs.closed;
                    captures.push(cs);
                    senders.push(p.sender.stats());
                }
                out.push(json!({ "t": "stats", "capture": captures, "senders": senders }));
                if closed && !g.ended {
                    g.ended = true;
                    out.push(json!({ "t": "ended", "reason": "closed" }));
                }
            }
            for v in &out {
                send_json(&s.events, v);
            }
        }
    }

    /// A link was closed: no pipe may feed it any more.
    pub(super) fn forget_link(id: u32) {
        let all: Vec<Arc<Share>> = match shares().lock() {
            Ok(g) => g.values().cloned().collect(),
            Err(_) => return,
        };
        for s in all {
            s.remove_link(id);
        }
    }

    pub(super) fn close(id: u32) {
        let s = shares().lock().ok().and_then(|mut g| g.remove(&id));
        if let Some(s) = s {
            s.shutdown();
            eprintln!("[native] share {id} closed");
        }
    }

    pub(super) fn close_all() {
        let all: Vec<Arc<Share>> = match shares().lock() {
            Ok(mut g) => g.drain().map(|(_, s)| s).collect(),
            Err(_) => return,
        };
        for s in all {
            s.shutdown();
        }
    }
}

// ───────────────────────── page messages (raw Channel bytes, little-endian) ─────────────────────────

/// Kind byte of a video message.
pub const MSG_VIDEO: u8 = 1;
/// Kind byte of an audio message.
pub const MSG_AUDIO: u8 = 2;
pub const VIDEO_MSG_HEADER: usize = 32;
pub const AUDIO_MSG_HEADER: usize = 16;

/// One access unit for the page:
/// ```text
/// [0] u8 1   [1] u8 flags: bit0 key, bit1 recovered by FEC, bit2 first after a loss   [2] u8 codec (1 H.264, 2 HEVC)
/// [3] u8 0   [4..8] u32 frame id   [8..16] u64 pts µs (sender capture clock = WebCodecs timestamp)
/// [16..20] u32 age µs (capture → handed over, 0 = unknown)   [20..24] u32 sender latency µs (capture → encoded)
/// [24..32] u64 wall clock µs at hand-over (page: IPC delay ≈ (timeOrigin + now) × 1000 − this)   [32..] Annex B
/// ```
pub fn video_message(au: &st_media::recv::VideoAu) -> Vec<u8> {
    let mut b = Vec::with_capacity(VIDEO_MSG_HEADER + au.data.len());
    b.push(MSG_VIDEO);
    b.push(u8::from(au.key) | (u8::from(au.recovered) << 1) | (u8::from(au.after_loss) << 2));
    b.push(au.codec as u8);
    b.push(0);
    b.extend_from_slice(&au.frame_id.to_le_bytes());
    b.extend_from_slice(&au.pts_us.to_le_bytes());
    b.extend_from_slice(&au.age_us.to_le_bytes());
    b.extend_from_slice(&au.sender_latency_us.to_le_bytes());
    b.extend_from_slice(&st_media::clock::epoch_us().to_le_bytes());
    b.extend_from_slice(&au.data);
    b
}

/// 20 ms of sound for the page:
/// ```text
/// [0] u8 2   [1] u8 channels (2)   [2] u8 concealed 5 ms packets   [3] u8 0   [4..8] u32 seq
/// [8..16] u64 capture µs (sender clock)   [16..] s16le interleaved PCM (960 frames)
/// ```
pub fn audio_message(block: &st_media::recv::AudioBlock) -> Vec<u8> {
    let mut b = Vec::with_capacity(AUDIO_MSG_HEADER + block.pcm.len() * 2);
    b.push(MSG_AUDIO);
    b.push(st_media::AUDIO_CHANNELS as u8);
    b.push(block.concealed);
    b.push(0);
    b.extend_from_slice(&block.seq.to_le_bytes());
    b.extend_from_slice(&block.capture_us.to_le_bytes());
    for s in &block.pcm {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_message_layout() {
        let au = st_media::recv::VideoAu {
            frame_id: 7,
            codec: st_media::Codec::Hevc,
            key: true,
            recovered: false,
            after_loss: true,
            pts_us: 1_000_000,
            age_us: 12_345,
            sender_latency_us: 3_000,
            data: vec![0, 0, 0, 1, 0x40],
        };
        let m = video_message(&au);
        assert_eq!(m.len(), VIDEO_MSG_HEADER + 5);
        assert_eq!(&m[..4], &[MSG_VIDEO, 0b101, 2, 0]);
        assert_eq!(u32::from_le_bytes(m[4..8].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(m[8..16].try_into().unwrap()), 1_000_000);
        assert_eq!(u32::from_le_bytes(m[16..20].try_into().unwrap()), 12_345);
        assert_eq!(&m[VIDEO_MSG_HEADER..], &[0, 0, 0, 1, 0x40]);
    }

    #[test]
    fn audio_message_layout() {
        let block = st_media::recv::AudioBlock { seq: 9, capture_us: 5, pcm: vec![-1i16; st_media::AUDIO_BLOCK_FRAMES * 2], concealed: 1 };
        let m = audio_message(&block);
        assert_eq!(m.len(), AUDIO_MSG_HEADER + 960 * 2 * 2);
        assert_eq!(&m[..4], &[MSG_AUDIO, 2, 1, 0]);
        assert_eq!(&m[16..18], &[0xff, 0xff]);
    }

    /// The shapes `nativelink.ts` reads (docs/NATIVE-PATH.md §9.2).
    #[test]
    fn link_event_json() {
        let host = Candidate::parse("192.168.1.20:50123", "host").unwrap();
        let v6 = Candidate::parse("[2001:db8::1]:4000", "srflx").unwrap();
        let prflx = Candidate { addr: "10.0.0.9:7".parse().unwrap(), kind: CandidateKind::Prflx };
        assert_eq!(
            event_json(&LinkEvent::Candidates(vec![host, v6, prflx]), None),
            json!({ "t": "cand", "cand": [{ "a": "192.168.1.20:50123", "k": "host" }, { "a": "[2001:db8::1]:4000", "k": "srflx" }] })
        );
        let up = st_media::PathInfo { remote: "[2001:db8::2]:9".parse().unwrap(), lan: true, rtt_us: 1500 };
        assert_eq!(event_json(&LinkEvent::Up(up), None), json!({ "t": "up", "remote": "[2001:db8::2]:9", "lan": true, "rttMs": 1.5 }));
        assert_eq!(event_json(&LinkEvent::Failed("deadline".into()), None), json!({ "t": "fail", "reason": "deadline" }));
        assert_eq!(event_json(&LinkEvent::Closed("kicked".into()), None), json!({ "t": "closed", "reason": "kicked" }));
        assert_eq!(event_json(&LinkEvent::Message("{\"t\":\"kick\"}".into()), None), json!({ "t": "msg", "m": "{\"t\":\"kick\"}" }));
        let stats = event_json(&LinkEvent::Stats(Default::default()), Some(RecvStats { frames: 3, ..Default::default() }));
        assert_eq!(stats["t"], "stats");
        assert_eq!(stats["link"]["rttMs"], 0.0);
        assert_eq!(stats["link"]["lossPct"], 0.0);
        assert_eq!(stats["recv"]["frames"], 3);
        assert_eq!(stats["recv"]["videoKbps"], 0);
        assert!(event_json(&LinkEvent::Stats(Default::default()), None).get("recv").is_none());
    }

    #[test]
    fn candidates_from_the_page() {
        let c = parse_candidates(&[
            CandidateWire { a: "192.168.1.20:50123".into(), k: "host".into() },
            CandidateWire { a: "1.2.3.4:0".into(), k: "host".into() },
            CandidateWire { a: "1.2.3.4:5".into(), k: "relay".into() },
        ]);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].addr_string(), "192.168.1.20:50123");
        assert_eq!(bye_reason("kicked"), ByeReason::Kicked);
        assert_eq!(bye_reason("ended"), ByeReason::Ended);
        assert_eq!(bye_reason("anything"), ByeReason::Closed);
    }

    #[cfg(windows)]
    #[test]
    fn share_sound_to_s16() {
        assert_eq!(share::to_s16(&[0.0, 1.0, -1.0, 2.0, 0.5]), vec![0, 32767, -32767, 32767, 16384]);
    }

    #[test]
    fn share_config_from_the_page() {
        let cfg: ShareCfg = serde_json::from_value(json!({ "source": "window:1:0", "width": 1920, "height": 1080, "fps": 60, "maxHeight": 0, "kbps": 0, "audio": true })).unwrap();
        assert_eq!((cfg.source.as_str(), cfg.max_height, cfg.audio), ("window:1:0", 0, true));
        let up: ShareUpdate = serde_json::from_value(json!({ "fps": 120, "maxHeight": 1440, "kbps": 30000 })).unwrap();
        assert_eq!((up.fps, up.max_height, up.kbps), (120, 1440, 30000));
        assert_eq!(clamp_fps(0), 1);
    }
}

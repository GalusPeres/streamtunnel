//! StreamTunnel media engine for Linux (WebKitGTK ships without WebRTC).
//!
//! One [`Peer`] = one GStreamer `webrtcbin` acting as the *answerer* of a watch link: the sharer (Chrome /
//! WebView2 / WKWebView) offers H.264 + Opus + the negotiated "ctl" data channel, we answer.
//!
//! * video: `rtph264depay → h264parse → appsink` — encoded H.264 access units (Annex B) are handed to the
//!   caller ([`Event::Video`]) and decoded by WebCodecs inside the web view;
//! * audio: `rtpopusdepay → opusdec → volume → autoaudiosink` — played directly;
//! * the data channel's text messages, ICE candidates and state changes are reported as [`Event`]s.
//!
//! The engine knows nothing about Tauri or the signaling protocol — the TypeScript `NativePeerConnection` shim
//! drives it through a handful of commands (see `src-tauri/src/media.rs`).
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use gst::glib;
use gst::prelude::*;

pub use gst;
pub use gst_sdp;
pub use gst_webrtc;

const PROMISE_TIMEOUT: Duration = Duration::from_secs(8);

/// GStreamer elements the watch path needs, with the package that provides them (Arch name / Debian name).
pub const REQUIRED_ELEMENTS: &[(&str, &str)] = &[
    ("webrtcbin", "gst-plugins-bad / gstreamer1.0-plugins-bad"),
    ("nicesrc", "libnice / gstreamer1.0-nice"),
    ("dtlssrtpdec", "gst-plugins-bad / gstreamer1.0-plugins-bad"),
    ("srtpdec", "gst-plugins-bad / gstreamer1.0-plugins-bad"),
    ("sctpdec", "gst-plugins-bad / gstreamer1.0-plugins-bad"),
    ("rtpbin", "gst-plugins-good / gstreamer1.0-plugins-good"),
    ("rtph264depay", "gst-plugins-good / gstreamer1.0-plugins-good"),
    ("h264parse", "gst-plugins-bad-libs / gstreamer1.0-plugins-bad"),
    ("rtpopusdepay", "gst-plugins-good / gstreamer1.0-plugins-good"),
    ("opusdec", "gst-plugins-base / gstreamer1.0-plugins-base"),
    ("audioconvert", "gst-plugins-base-libs / gstreamer1.0-plugins-base"),
    ("audioresample", "gst-plugins-base / gstreamer1.0-plugins-base"),
    ("volume", "gst-plugins-base-libs / gstreamer1.0-plugins-base"),
    ("appsink", "gst-plugins-base-libs / gstreamer1.0-plugins-base"),
    ("autoaudiosink", "gst-plugins-good / gstreamer1.0-plugins-good"),
];

static INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// Initializes GStreamer once. Cheap after the first call.
pub fn init() -> Result<(), String> {
    INIT.get_or_init(|| gst::init().map_err(|e| format!("GStreamer: {e}"))).clone()
}

/// Missing GStreamer elements (empty = everything for watching is installed), as "element (package)".
pub fn missing_elements() -> Vec<String> {
    if let Err(e) = init() {
        return vec![e];
    }
    REQUIRED_ELEMENTS
        .iter()
        .filter(|(name, _)| gst::ElementFactory::find(name).is_none())
        .map(|(name, pkg)| format!("{name} ({pkg})"))
        .collect()
}

/// Low-latency audio output: pulsesink (PipeWire's pulse server on current desktops) with a 40 ms buffer, else
/// whatever autoaudiosink finds.
pub fn default_audio_sink() -> String {
    if init().is_ok() && gst::ElementFactory::find("pulsesink").is_some() {
        "pulsesink buffer-time=40000 latency-time=10000".to_string()
    } else {
        "autoaudiosink".to_string()
    }
}

/// Codec preferences for one offered m-section: every payload type as RTP caps (with its rtcp-fb fields) plus the
/// offer's header extensions (`extmap-N`), so webrtcbin's answer echoes transport-cc and generates TWCC feedback
/// (Chrome's bandwidth estimate needs it). None for non-RTP sections.
pub fn offer_codec_preferences(media: &gst_sdp::SDPMediaRef) -> Option<gst::Caps> {
    let kind = media.media()?;
    if kind != "video" && kind != "audio" {
        return None;
    }
    let extmaps: Vec<(String, String)> = media
        .attributes()
        .filter(|a| a.key() == "extmap")
        .filter_map(|a| {
            let mut it = a.value()?.split_whitespace();
            let id = it.next()?.split('/').next()?.to_string();
            let uri = it.next()?.to_string();
            id.parse::<u8>().ok().map(|_| (id, uri))
        })
        .collect();
    let mut out = gst::Caps::new_empty();
    {
        let out_mut = out.make_mut();
        for f in media.formats() {
            let Ok(pt) = f.parse::<i32>() else { continue };
            let Some(mut caps) = media.caps_from_media(pt) else { continue };
            for s in caps.make_mut().iter_mut() {
                s.set_name("application/x-rtp");
                for (id, uri) in &extmaps {
                    s.set(format!("extmap-{id}").as_str(), uri.as_str());
                }
            }
            out_mut.append(caps);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Version string of the GStreamer library in use, e.g. "GStreamer 1.24.2".
pub fn gstreamer_version() -> String {
    if init().is_err() {
        return String::new();
    }
    gst::version_string().to_string()
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    /// "stun://host:port" (webrtcbin syntax); None = no STUN.
    pub stun: Option<String>,
    /// "turn(s)://user:pass@host:port" URLs (user/pass percent-encoded).
    pub turn: Vec<String>,
    /// rtpjitterbuffer latency in ms (webrtcbin default is 200 — far too much for us).
    pub latency_ms: u32,
    /// Audio output as a gst-launch fragment; None = [`default_audio_sink`]. (Tests use "fakesink".)
    pub audio_sink: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Event {
    /// Local ICE candidate ("candidate:…" without "a=").
    IceCandidate { mline: u32, candidate: String },
    /// "new" | "gathering" | "complete"
    IceGathering(&'static str),
    /// Peer connection state + ICE connection state (both as in the W3C API, lower case).
    State { connection: &'static str, ice: &'static str },
    /// A remote media pad was linked: "video" | "audio".
    Track(&'static str),
    DcOpen,
    DcClose,
    DcMessage(String),
    /// One H.264 access unit, Annex B (SPS/PPS repeated before every IDR). `key` = IDR.
    Video { pts_us: u64, key: bool, data: Vec<u8> },
    /// Non-fatal error text for logs / UI.
    Error(String),
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

/// A stats value from webrtcbin's `get-stats`.
#[derive(Debug, Clone, PartialEq)]
pub enum StatValue {
    Num(f64),
    Str(String),
    Bool(bool),
}

/// webrtcbin `get-stats` as { stats id → { field → value } } (field names as GStreamer reports them).
pub type Stats = BTreeMap<String, BTreeMap<String, StatValue>>;

struct Shared {
    emit: Emit,
    closed: AtomicBool,
    volume: Mutex<f64>,
    volume_el: Mutex<Option<gst::Element>>,
    video_depay: Mutex<Option<gst::Element>>,
}

impl Shared {
    fn emit(&self, ev: Event) {
        if !self.closed.load(Ordering::Acquire) {
            (self.emit)(ev);
        }
    }
}

pub struct Peer {
    pipeline: gst::Pipeline,
    webrtc: gst::Element,
    dc: Mutex<Option<gst_webrtc::WebRTCDataChannel>>,
    shared: Arc<Shared>,
}

fn pc_state(s: gst_webrtc::WebRTCPeerConnectionState) -> &'static str {
    use gst_webrtc::WebRTCPeerConnectionState as S;
    match s {
        S::Connecting => "connecting",
        S::Connected => "connected",
        S::Disconnected => "disconnected",
        S::Failed => "failed",
        S::Closed => "closed",
        _ => "new",
    }
}

fn ice_state(s: gst_webrtc::WebRTCICEConnectionState) -> &'static str {
    use gst_webrtc::WebRTCICEConnectionState as S;
    match s {
        S::Checking => "checking",
        S::Connected => "connected",
        S::Completed => "completed",
        S::Failed => "failed",
        S::Disconnected => "disconnected",
        S::Closed => "closed",
        _ => "new",
    }
}

fn gathering_state(s: gst_webrtc::WebRTCICEGatheringState) -> &'static str {
    use gst_webrtc::WebRTCICEGatheringState as S;
    match s {
        S::Gathering => "gathering",
        S::Complete => "complete",
        _ => "new",
    }
}

/// Error text of a promise reply (webrtcbin puts a GError into the "error" field on failure).
fn reply_error(reply: Option<&gst::StructureRef>) -> Option<String> {
    let s = reply?;
    if !s.has_field("error") {
        return None;
    }
    Some(match s.get::<glib::Error>("error") {
        Ok(e) => e.to_string(),
        Err(_) => s.to_string(),
    })
}

/// Emits a webrtcbin action signal that takes a GstPromise as last argument and waits for the reply.
fn call_promise<T: Send + 'static>(
    webrtc: &gst::Element,
    signal: &str,
    args: &[&dyn ToValue],
    map: impl FnOnce(Option<&gst::StructureRef>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    let promise = gst::Promise::with_change_func(move |reply| {
        let res = match reply {
            Ok(r) => match reply_error(r) {
                Some(err) => Err(err),
                None => map(r),
            },
            Err(e) => Err(format!("{e:?}")),
        };
        let _ = tx.send(res);
    });
    let mut all: Vec<&dyn ToValue> = args.to_vec();
    all.push(&promise);
    webrtc.emit_by_name::<()>(signal, &all);
    match rx.recv_timeout(PROMISE_TIMEOUT) {
        Ok(r) => r,
        Err(_) => {
            promise.interrupt();
            Err(format!("{signal}: timeout"))
        }
    }
}

fn stat_value(v: &glib::Value) -> Option<StatValue> {
    let t = v.type_();
    if t == glib::Type::BOOL {
        return v.get::<bool>().ok().map(StatValue::Bool);
    }
    if t == glib::Type::STRING {
        return v.get::<Option<String>>().ok().flatten().map(StatValue::Str);
    }
    let n = if t == glib::Type::I32 {
        v.get::<i32>().ok().map(f64::from)
    } else if t == glib::Type::U32 {
        v.get::<u32>().ok().map(f64::from)
    } else if t == glib::Type::I64 {
        v.get::<i64>().ok().map(|x| x as f64)
    } else if t == glib::Type::U64 {
        v.get::<u64>().ok().map(|x| x as f64)
    } else if t == glib::Type::F64 {
        v.get::<f64>().ok()
    } else if t == glib::Type::F32 {
        v.get::<f32>().ok().map(f64::from)
    } else {
        None
    };
    if let Some(n) = n {
        return Some(StatValue::Num(n));
    }
    if t.is_a(glib::Type::ENUM) {
        return glib::EnumValue::from_value(v).map(|(_, e)| StatValue::Str(e.nick().to_string()));
    }
    None
}

impl Peer {
    /// Creates the pipeline (PLAYING) with the negotiated "ctl" data channel (id 0). Call
    /// [`Peer::set_remote_offer`] next.
    pub fn new(cfg: &Config, emit: Emit) -> Result<Peer, String> {
        init()?;
        let pipeline = gst::Pipeline::new();
        let webrtc = gst::ElementFactory::make("webrtcbin")
            .name("webrtc")
            .build()
            .map_err(|_| "webrtcbin fehlt (gst-plugins-bad)".to_string())?;
        webrtc.set_property_from_str("bundle-policy", "max-bundle");
        webrtc.set_property("latency", cfg.latency_ms.clamp(0, 2000));
        if let Some(stun) = cfg.stun.as_deref().filter(|s| !s.is_empty()) {
            webrtc.set_property("stun-server", stun);
        }
        for turn in &cfg.turn {
            let _ok = webrtc.emit_by_name::<bool>("add-turn-server", &[turn]);
        }
        pipeline.add(&webrtc).map_err(|e| e.to_string())?;

        let shared = Arc::new(Shared {
            emit,
            closed: AtomicBool::new(false),
            volume: Mutex::new(1.0),
            volume_el: Mutex::new(None),
            video_depay: Mutex::new(None),
        });

        // Bus: errors → events; latency changes of dynamically added sinks → recalculate (off the bus thread).
        if let Some(bus) = pipeline.bus() {
            let sh = shared.clone();
            let pipe_weak = pipeline.downgrade();
            bus.set_sync_handler(move |_, msg| {
                match msg.view() {
                    gst::MessageView::Error(err) => {
                        let src = msg.src().map(|s| s.path_string().to_string()).unwrap_or_default();
                        sh.emit(Event::Error(format!("{src}: {} ({:?})", err.error(), err.debug())));
                    }
                    gst::MessageView::Warning(w) => {
                        let src = msg.src().map(|s| s.path_string().to_string()).unwrap_or_default();
                        sh.emit(Event::Error(format!("warning {src}: {}", w.error())));
                    }
                    gst::MessageView::Latency(_) => {
                        if let Some(p) = pipe_weak.upgrade() {
                            std::thread::spawn(move || {
                                let _ = p.recalculate_latency();
                            });
                        }
                    }
                    _ => {}
                }
                gst::BusSyncReply::Drop
            });
        }

        {
            let sh = shared.clone();
            webrtc.connect("on-ice-candidate", false, move |values| {
                let mline = values.get(1).and_then(|v| v.get::<u32>().ok()).unwrap_or(0);
                if let Some(c) = values.get(2).and_then(|v| v.get::<String>().ok()) {
                    let c = c.strip_prefix("a=").unwrap_or(&c).to_string();
                    if !c.is_empty() {
                        sh.emit(Event::IceCandidate { mline, candidate: c });
                    }
                }
                None
            });
        }
        {
            let sh = shared.clone();
            webrtc.connect_notify(Some("ice-gathering-state"), move |el, _| {
                let s = el.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state");
                sh.emit(Event::IceGathering(gathering_state(s)));
            });
        }
        for prop in ["connection-state", "ice-connection-state"] {
            let sh = shared.clone();
            webrtc.connect_notify(Some(prop), move |el, _| {
                let connection = pc_state(el.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state"));
                let ice = ice_state(el.property::<gst_webrtc::WebRTCICEConnectionState>("ice-connection-state"));
                sh.emit(Event::State { connection, ice });
            });
        }
        {
            let sh = shared.clone();
            let pipe_weak = pipeline.downgrade();
            let audio_sink = cfg.audio_sink.clone().unwrap_or_else(default_audio_sink);
            webrtc.connect_pad_added(move |_, pad| {
                if pad.direction() != gst::PadDirection::Src {
                    return;
                }
                let Some(pipeline) = pipe_weak.upgrade() else { return };
                if let Err(e) = link_media_pad(&pipeline, pad, &sh, &audio_sink) {
                    sh.emit(Event::Error(e));
                }
            });
        }
        webrtc.connect("on-data-channel", false, |_| None);

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| "Pipeline startet nicht".to_string())?;

        // Negotiated data channel, id 0 — matches `pc.createDataChannel('ctl', {negotiated: true, id: 0})`.
        let opts = gst::Structure::builder("config")
            .field("negotiated", true)
            .field("id", 0i32)
            .field("ordered", true)
            .build();
        let dc = webrtc.emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>("create-data-channel", &[&"ctl", &opts]);
        if let Some(dc) = &dc {
            let sh = shared.clone();
            dc.connect_on_open(move |_| sh.emit(Event::DcOpen));
            let sh = shared.clone();
            dc.connect_on_close(move |_| sh.emit(Event::DcClose));
            let sh = shared.clone();
            dc.connect_on_message_string(move |_, s| {
                if let Some(s) = s {
                    sh.emit(Event::DcMessage(s.to_string()));
                }
            });
            let sh = shared.clone();
            dc.connect_on_error(move |_, err| sh.emit(Event::Error(format!("data channel: {err}"))));
        } else {
            shared.emit(Event::Error("data channel could not be created".into()));
        }

        Ok(Peer { pipeline, webrtc, dc: Mutex::new(dc), shared })
    }

    /// Applies the sharer's offer (already filtered to H.264 + Opus + data channel by the caller).
    pub fn set_remote_offer(&self, sdp: &str) -> Result<(), String> {
        let msg = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes()).map_err(|_| "invalid offer SDP".to_string())?;
        let offer = gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, msg);
        let sdp_msg = offer.sdp();
        call_promise(&self.webrtc, "set-remote-description", &[&offer], |_| Ok(()))?;
        for i in 0..16i32 {
            let Some(t) = self.webrtc.emit_by_name::<Option<gst_webrtc::WebRTCRTPTransceiver>>("get-transceiver", &[&i]) else {
                break;
            };
            // NACK → retransmissions through the jitterbuffer (the sharer offers rtx).
            if t.has_property("do-nack", None) {
                t.set_property("do-nack", true);
            }
            // Answer = the offer's codecs (already filtered) incl. rtcp-fb + header extensions (transport-cc).
            let mline = t.property::<u32>("mlineindex");
            if let Some(prefs) = sdp_msg.media(mline).and_then(offer_codec_preferences) {
                t.set_property("codec-preferences", &prefs);
            }
        }
        Ok(())
    }

    /// create-answer + set-local-description; returns the answer SDP (candidates follow as events).
    pub fn create_answer(&self) -> Result<String, String> {
        let answer = call_promise(&self.webrtc, "create-answer", &[&None::<gst::Structure>], |reply| {
            reply
                .ok_or_else(|| "create-answer: no reply".to_string())?
                .get::<gst_webrtc::WebRTCSessionDescription>("answer")
                .map_err(|e| format!("create-answer: {e}"))
        })?;
        call_promise(&self.webrtc, "set-local-description", &[&answer], |_| Ok(()))?;
        answer.sdp().as_text().map_err(|e| e.to_string())
    }

    /// Remote ICE candidate ("candidate:…" with or without "a="); empty = end of candidates (ignored).
    pub fn add_ice_candidate(&self, mline: u32, candidate: &str) {
        let c = candidate.trim();
        let c = c.strip_prefix("a=").unwrap_or(c);
        if c.is_empty() {
            return;
        }
        self.webrtc.emit_by_name::<()>("add-ice-candidate", &[&mline, &c]);
    }

    pub fn dc_send(&self, text: &str) -> Result<(), String> {
        let guard = self.dc.lock().map_err(|_| "poisoned")?;
        let dc = guard.as_ref().ok_or("no data channel")?;
        if dc.ready_state() != gst_webrtc::WebRTCDataChannelState::Open {
            return Err("data channel not open".into());
        }
        dc.send_string_full(Some(text)).map_err(|e| e.to_string())
    }

    /// 0.0 … 1.0 (muted = 0).
    pub fn set_volume(&self, v: f64) {
        let v = if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 };
        if let Ok(mut cur) = self.shared.volume.lock() {
            *cur = v;
        }
        if let Some(el) = self.shared.volume_el.lock().ok().and_then(|g| g.clone()) {
            el.set_property("volume", v);
        }
    }

    pub fn set_latency(&self, ms: u32) {
        self.webrtc.set_property("latency", ms.clamp(0, 2000));
    }

    /// Asks the sender for a key frame (PLI/FIR through rtpsession), e.g. after a decoder error.
    pub fn request_keyframe(&self) {
        let Some(depay) = self.shared.video_depay.lock().ok().and_then(|g| g.clone()) else { return };
        let ev = gst::event::CustomUpstream::new(
            gst::Structure::builder("GstForceKeyUnit").field("all-headers", true).build(),
        );
        let _ = depay.send_event(ev);
    }

    pub fn stats(&self) -> Result<Stats, String> {
        call_promise(&self.webrtc, "get-stats", &[&None::<gst::Pad>], |reply| {
            let mut out = Stats::new();
            let Some(reply) = reply else { return Ok(out) };
            for (id, value) in reply.iter() {
                let Ok(s) = value.get::<gst::Structure>() else { continue };
                let mut fields = BTreeMap::new();
                for (k, v) in s.iter() {
                    if let Some(sv) = stat_value(v) {
                        fields.insert(k.to_string(), sv);
                    }
                }
                out.insert(id.to_string(), fields);
            }
            Ok(out)
        })
    }

    pub fn connection_state(&self) -> (&'static str, &'static str) {
        (
            pc_state(self.webrtc.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state")),
            ice_state(self.webrtc.property::<gst_webrtc::WebRTCICEConnectionState>("ice-connection-state")),
        )
    }

    /// Stops everything; no events afterwards. Idempotent.
    pub fn close(&self) {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut dc) = self.dc.lock() {
            if let Some(dc) = dc.take() {
                dc.close();
            }
        }
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Ok(mut g) = self.shared.volume_el.lock() {
            *g = None;
        }
        if let Ok(mut g) = self.shared.video_depay.lock() {
            *g = None;
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

/// Links a new webrtcbin src pad to the matching decode branch (unknown media → fakesink).
fn link_media_pad(pipeline: &gst::Pipeline, pad: &gst::Pad, sh: &Arc<Shared>, audio_sink: &str) -> Result<(), String> {
    let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
    let s = caps.structure(0).ok_or("pad without caps")?;
    let encoding = s.get::<&str>("encoding-name").unwrap_or("").to_ascii_uppercase();
    let (desc, kind): (String, Option<&'static str>) = match encoding.as_str() {
        "H264" => (
            "rtph264depay name=vdepay request-keyframe=true wait-for-keyframe=true ! h264parse config-interval=-1 \
             ! video/x-h264,stream-format=byte-stream,alignment=au \
             ! appsink name=vsink sync=false max-buffers=30 drop=false"
                .to_string(),
            Some("video"),
        ),
        "OPUS" => (
            format!(
                "queue max-size-time=500000000 leaky=downstream ! rtpopusdepay ! opusdec plc=true \
                 ! audioconvert ! audioresample ! volume name=vol ! {audio_sink}"
            ),
            Some("audio"),
        ),
        _ => ("fakesink sync=false async=false".to_string(), None),
    };
    let bin = gst::parse_bin_from_description(&desc, true).map_err(|e| format!("{encoding}: {e}"))?;
    if kind == Some("video") {
        let sink = bin
            .by_name("vsink")
            .and_then(|e| e.downcast::<gst_app::AppSink>().ok())
            .ok_or("appsink missing")?;
        let shv = sh.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(buf) = sample.buffer() {
                        let key = !buf.flags().contains(gst::BufferFlags::DELTA_UNIT);
                        let pts_us = buf.pts().map(|t| t.useconds()).unwrap_or(0);
                        if let Ok(map) = buf.map_readable() {
                            shv.emit(Event::Video { pts_us, key, data: map.as_slice().to_vec() });
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        if let Ok(mut g) = sh.video_depay.lock() {
            *g = bin.by_name("vdepay");
        }
    } else if kind == Some("audio") {
        if let Some(vol) = bin.by_name("vol") {
            let v = sh.volume.lock().map(|g| *g).unwrap_or(1.0);
            vol.set_property("volume", v);
            if let Ok(mut g) = sh.volume_el.lock() {
                *g = Some(vol);
            }
        }
    }
    pipeline.add(&bin).map_err(|e| e.to_string())?;
    bin.sync_state_with_parent().map_err(|e| e.to_string())?;
    let sinkpad = bin.static_pad("sink").ok_or("bin without sink pad")?;
    pad.link(&sinkpad).map_err(|e| format!("link {encoding}: {e:?}"))?;
    if let Some(k) = kind {
        sh.emit(Event::Track(k));
    }
    Ok(())
}

/// "stun:host:port" (W3C) → "stun://host:port" (webrtcbin). None for anything else.
pub fn stun_url(w3c: &str) -> Option<String> {
    let s = w3c.trim();
    let rest = s.strip_prefix("stun:").or_else(|| s.strip_prefix("STUN:"))?;
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("stun://{rest}"))
}

fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// "turn:host:port?transport=udp" + credentials (W3C) → "turn://user:pass@host:port?transport=udp" (webrtcbin).
pub fn turn_url(w3c: &str, user: &str, pass: &str) -> Option<String> {
    let s = w3c.trim();
    let (scheme, rest) = if let Some(r) = s.strip_prefix("turns:") {
        ("turns", r)
    } else if let Some(r) = s.strip_prefix("turn:") {
        ("turn", r)
    } else {
        return None;
    };
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() || user.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{}:{}@{rest}", pct(user), pct(pass)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(stun_url("stun:stun.l.google.com:19302").as_deref(), Some("stun://stun.l.google.com:19302"));
        assert_eq!(stun_url("turn:x"), None);
        assert_eq!(
            turn_url("turn:example.org:3478?transport=udp", "u@1", "p:w").as_deref(),
            Some("turn://u%401:p%3Aw@example.org:3478?transport=udp")
        );
        assert_eq!(turn_url("turns:example.org:443", "u", "p").as_deref(), Some("turns://u:p@example.org:443"));
        assert_eq!(turn_url("stun:x", "u", "p"), None);
    }

    #[test]
    fn codec_preferences_carry_rtcp_fb_and_extmap() {
        init().unwrap();
        let sdp = [
            "v=0",
            "o=- 1 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "m=video 9 UDP/TLS/RTP/SAVPF 102 103",
            "c=IN IP4 0.0.0.0",
            "a=mid:0",
            "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            "a=rtpmap:102 H264/90000",
            "a=rtcp-fb:102 transport-cc",
            "a=rtcp-fb:102 nack pli",
            "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            "a=rtpmap:103 rtx/90000",
            "a=fmtp:103 apt=102",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "a=mid:1",
            "",
        ]
        .join("\r\n");
        let msg = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes()).unwrap();
        let caps = offer_codec_preferences(msg.media(0).unwrap()).expect("video caps");
        eprintln!("{caps}");
        assert_eq!(caps.size(), 2);
        let h264 = caps.structure(0).unwrap();
        assert_eq!(h264.name(), "application/x-rtp");
        assert_eq!(h264.get::<&str>("encoding-name").unwrap(), "H264");
        assert!(h264.get::<bool>("rtcp-fb-transport-cc").unwrap_or(false));
        assert!(h264.get::<&str>("extmap-3").unwrap().contains("transport-wide-cc"));
        assert!(offer_codec_preferences(msg.media(1).unwrap()).is_none());
    }
}

//! The sharer's pipeline for one codec (docs/NATIVE-PATH.md §3): WGC (or the test pattern) → copy into the
//! converter → NV12 slot → NVENC → [`EncodedFrame`] to the sink, on one thread `st-capture` per session.
//!
//! * WGC hands over every composition (MinUpdateInterval 4 ms); [`Cadence`] picks the pictures that are encoded, at
//!   exactly `fps`: one per beat, the first that arrives near its beat at once, an early one waits and is replaced
//!   by any newer one (newest wins); frame ids count encoded frames from 1;
//! * nothing new for 2 / fps (static content, minimized window) → the last NV12 slot is encoded again with
//!   `repeat = true`, then once per interval while nothing changes, so the encoder keeps its fixed fps, text
//!   sharpens and a minimized window keeps its last picture;
//! * requests ([`EncoderRequest`]) are applied before the next encode: Keyframe → IDR, InvalidateRefs →
//!   `Encoder::invalidate` (IDR if that fails), Bitrate → `Encoder::set_bitrate` (never above the target, and
//!   ignored when the user set the bitrate by hand);
//! * resolution and fps stay fixed: only a new source size, [`CaptureSession::set_source`] or
//!   [`CaptureSession::reconfigure`] (user actions) change them, always with an IDR. A window that is being resized
//!   is letterboxed into the old size until its size has been stable for 250 ms;
//! * the window closed → the sink gets nothing more and `stats().closed` turns true (the glue ends the native
//!   share; the web view's track ends on its own);
//! * ten encode errors in a row (driver reset, device removed) rebuild the whole pipeline on a fresh device, frame
//!   ids continuing; when that fails, or after three rebuilds, the session ends like a closed window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BOX};

use crate::clock::now_us;
use crate::net::rate::lan_bitrate_kbps;
use crate::win::d3d::{self, output_size, Converter, Gpu, TestPattern};
use crate::win::nvenc::{self, Encoder, EncoderConfig, NvencLib, INPUT_SLOTS};
use crate::win::prio;
use crate::win::wgc::{CaptureItem, WgcCapture, WgcFrame};
use crate::{Codec, EncodedFrame, EncoderRequest};

/// What the sharer captures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// HWND from the track's "window:<hwnd>:0"
    Window(isize),
    /// HMONITOR resolved from "screen:<id>:0" (`wgc::resolve_screen`)
    Monitor(isize),
    /// synthetic frames (tests, never the screen)
    TestPattern { width: u32, height: u32 },
}

/// The getDisplayMedia track's `deviceId` → source. `hint_w × hint_h` = the track's size (screen matching).
/// Err for anything else (browser tab, test stream, unknown screen) — that share stays on WebRTC.
pub fn parse_source(device_id: &str, hint_w: u32, hint_h: u32) -> Result<Source, String> {
    let mut parts = device_id.split(':');
    let kind = parts.next().unwrap_or("");
    let id: i64 = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| format!("unknown source '{device_id}'"))?;
    match kind {
        "window" if id != 0 => Ok(Source::Window(id as isize)),
        "screen" => crate::win::wgc::resolve_screen(id, hint_w, hint_h).map(Source::Monitor),
        _ => Err(format!("unknown source '{device_id}'")),
    }
}

/// Session settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureConfig {
    pub codec: Codec,
    pub fps: u32,
    /// max output lines, 0 = native (≤ 2160)
    pub max_height: u32,
    /// the user's CBR target; 0 = Auto: `net::rate::lan_bitrate_kbps(encoder size, fps, codec)`, recomputed at
    /// every size change
    pub bitrate_kbps: u32,
    /// VBV in frames (2.0 by default; see nvenc.rs)
    pub vbv_frames: f32,
    /// draw the mouse pointer
    pub cursor: bool,
}

/// Encoded frames go here, on the `st-capture` thread (the glue hands them to `send::Sender::push_frame`).
pub type FrameSink = Box<dyn FnMut(EncodedFrame) + Send>;

/// Snapshot of a session.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    /// "h264" | "hevc" | "av1"
    pub codec: String,
    /// always "NVENC" in this milestone
    pub encoder: String,
    /// adapter name, e.g. "NVIDIA GeForce RTX 4080"
    pub gpu: String,
    /// encoder size
    pub width: u32,
    pub height: u32,
    /// target fps (fixed)
    pub fps: u32,
    /// the target from the settings (user value or Auto for the current size); changes only with size / settings.
    /// The glue forwards a change to `send::Sender::set_target`.
    pub target_kbps: u32,
    /// the encoder's current rate (target after back-off requests)
    pub bitrate_kbps: u32,
    /// frames delivered by the capture / encoded, per second over the last second
    pub capture_fps: f32,
    pub encode_fps: f32,
    /// mean capture → encoded over the last second (ms)
    pub encode_ms: f32,
    /// totals
    pub frames: u64,
    pub repeated: u64,
    pub keyframes: u64,
    /// the source window is minimized (last picture repeated)
    pub minimized: bool,
    /// the source is gone (window closed), or the encoder failed for good (`failed`)
    pub closed: bool,
    /// the encoder kept failing and rebuilding it did not help: the capture stopped although its source is still
    /// there (the glue reports `{t:'ended', reason:'error'}`, the page moves the native watchers to WebRTC)
    pub failed: bool,
}

/// A picture may arrive this share of an interval before its beat and still be encoded at once ([`Cadence`]).
const EARLY_SHARE: f64 = 0.25;
/// WGC's MinUpdateInterval: every composition up to 250 Hz (MEDIA-PLAN §2.3, as Sunshine). Not 1 / fps: WGC drops
/// what comes sooner, so a 144 Hz monitor would give only every third refresh at 60 fps (48 fps), and at 30 fps on
/// 60 Hz the floor sits on every second refresh, where timestamp jitter alone pushes it to every third (20 fps).
/// [`Cadence`] holds the fixed fps.
const WGC_MIN_UPDATE_US: u64 = 4_000;
/// Nothing new for this many intervals → repeat the last picture.
const REPEAT_AFTER_INTERVALS: u64 = 2;
/// A new source size must hold this long before the encoder follows it (µs).
const RESIZE_SETTLE_US: u64 = 250_000;
/// The thread looks at the source (closed, minimized) and the stats at least this often (µs).
const POLL_US: u64 = 100_000;
/// Encode errors in a row that make the session rebuild its pipeline.
const MAX_ERRORS: u32 = 10;
/// Rebuilds per session before it gives up.
const MAX_REBUILDS: u32 = 3;
/// How long start / set_source / reconfigure wait for the capture thread.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

enum Command {
    Target(u32),
    Source(Source, SyncSender<Result<(), String>>),
    Reconfigure { fps: u32, max_height: u32, reply: SyncSender<Result<(), String>> },
}

#[derive(Default)]
struct Inbox {
    stop: bool,
    requests: Vec<EncoderRequest>,
    commands: Vec<Command>,
    /// arrival time of the newest captured picture not yet seen by the thread (WGC)
    fresh: Option<u64>,
    /// test pattern only: no new pictures (static content)
    paused: bool,
}

#[derive(Default)]
struct Shared {
    inbox: Mutex<Inbox>,
    wake: Condvar,
    stats: Mutex<CaptureStats>,
    /// pictures the source delivered (total)
    captured: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    /// Changes the inbox and wakes the thread; false once the session stopped.
    fn post(&self, f: impl FnOnce(&mut Inbox)) -> bool {
        let mut inbox = lock(&self.inbox);
        if inbox.stop {
            return false;
        }
        f(&mut inbox);
        self.wake.notify_one();
        true
    }
}

/// One running capture + encoder.
pub struct CaptureSession {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureSession {
    /// Creates the device, the WGC capture (or test pattern), the converter and the encoder, and starts the
    /// `st-capture` thread. Err when any of them fails (the glue answers the viewer "unavailable").
    pub fn start(source: Source, cfg: CaptureConfig, sink: FrameSink) -> Result<CaptureSession, String> {
        if cfg.fps == 0 || cfg.fps > 240 {
            return Err(format!("bad fps {}", cfg.fps));
        }
        let shared = Arc::new(Shared::default());
        let (tx, rx) = sync_channel(1);
        let sh = shared.clone();
        let thread = std::thread::Builder::new()
            .name("st-capture".into())
            .spawn(move || {
                let _boost = prio::ThreadBoost::new();
                prio::boost_process();
                match Pipeline::new(source, cfg, &sh) {
                    Ok(p) => {
                        p.publish(&sh, None);
                        let _ = tx.send(Ok(()));
                        run(p, &sh, sink);
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("capture thread: {e}"))?;
        let mut session = CaptureSession { shared, thread: Some(thread) };
        match rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(Ok(())) => Ok(session),
            Ok(Err(e)) => {
                session.stop();
                Err(e)
            }
            Err(_) => {
                // never join a thread that hangs in the driver: let it finish on its own
                session.shared.post(|i| i.stop = true);
                session.thread = None;
                Err("capture start timed out".into())
            }
        }
    }

    /// Queues a request for the next frame (never blocks).
    pub fn request(&self, r: EncoderRequest) {
        self.shared.post(|i| i.requests.push(r));
    }

    /// A cloneable handle doing the same as [`CaptureSession::request`] (the `send::Sender`'s request sink; it
    /// does nothing once the session stopped).
    pub fn request_handle(&self) -> crate::send::RequestSink {
        let weak = Arc::downgrade(&self.shared);
        Arc::new(move |r| {
            if let Some(shared) = weak.upgrade() {
                shared.post(|i| i.requests.push(r));
            }
        })
    }

    /// Bitrate / fixed flag changed in the settings (no IDR). 0 = Auto.
    pub fn set_target(&self, kbps: u32) {
        self.shared.post(|i| i.commands.push(Command::Target(kbps)));
    }

    /// Switches to another window / monitor (the user picked a new source): new capture item, new size, IDR.
    pub fn set_source(&self, source: Source) -> Result<(), String> {
        let (tx, rx) = sync_channel(1);
        self.call(Command::Source(source, tx), rx)
    }

    /// The user changed fps or the resolution cap: reconfigure + IDR.
    pub fn reconfigure(&self, fps: u32, max_height: u32) -> Result<(), String> {
        if fps == 0 || fps > 240 {
            return Err(format!("bad fps {fps}"));
        }
        let (tx, rx) = sync_channel(1);
        self.call(Command::Reconfigure { fps, max_height, reply: tx }, rx)
    }

    fn call(&self, c: Command, rx: std::sync::mpsc::Receiver<Result<(), String>>) -> Result<(), String> {
        if !self.shared.post(|i| i.commands.push(c)) {
            return Err("capture stopped".into());
        }
        rx.recv_timeout(REPLY_TIMEOUT).map_err(|_| "capture thread did not answer".to_string())?
    }

    /// Test pattern only: stop (true) or resume producing new pictures, like a static window. The session then
    /// repeats its last picture.
    pub fn pause_pattern(&self, paused: bool) {
        self.shared.post(|i| i.paused = paused);
    }

    pub fn stats(&self) -> CaptureStats {
        lock(&self.shared.stats).clone()
    }

    /// Stops the thread and releases everything. Idempotent; also done on drop.
    pub fn stop(&mut self) {
        self.shared.post(|i| i.stop = true);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Our own copy of the newest WGC picture (WGC recycles its surfaces).
struct Captured {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

enum Input {
    Wgc { capture: WgcCapture, frame: Arc<Mutex<Option<Captured>>> },
    Pattern(TestPattern),
}

/// Starts capturing `source`; returns the input and its current size.
fn start_input(gpu: &Gpu, source: Source, cfg: &CaptureConfig, shared: &Arc<Shared>) -> Result<(Input, (u32, u32)), String> {
    let item = match source {
        Source::TestPattern { width, height } => {
            if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
                return Err(format!("test pattern size must be even: {width}x{height}"));
            }
            return Ok((Input::Pattern(TestPattern::new(gpu, width, height)?), (width, height)));
        }
        Source::Window(h) => CaptureItem::Window(h),
        Source::Monitor(h) => CaptureItem::Monitor(h),
    };
    let frame: Arc<Mutex<Option<Captured>>> = Arc::new(Mutex::new(None));
    let (device, context) = (gpu.device.clone(), gpu.context.clone());
    let latest = frame.clone();
    let weak = Arc::downgrade(shared);
    let on_frame = Box::new(move |f: WgcFrame| {
        let Some(shared) = weak.upgrade() else { return };
        {
            let mut cap = lock(&latest);
            if cap.as_ref().map(|c| (c.width, c.height)) != Some((f.width, f.height)) {
                match d3d::bgra_texture(&device, f.width, f.height) {
                    Ok(texture) => *cap = Some(Captured { texture, width: f.width, height: f.height }),
                    Err(e) => {
                        eprintln!("[native] capture copy: {e}");
                        return;
                    }
                }
            }
            let Some(c) = cap.as_ref() else { return };
            let region = D3D11_BOX { left: 0, top: 0, front: 0, right: f.width, bottom: f.height, back: 1 };
            unsafe { context.CopySubresourceRegion(&c.texture, 0, 0, 0, 0, &f.texture, 0, Some(&region)) };
        }
        shared.captured.fetch_add(1, Ordering::Relaxed);
        shared.post(|i| i.fresh = Some(f.arrived_us));
    });
    let capture = WgcCapture::start(gpu, item, cfg.cursor, wgc_min_update_us(cfg.fps), on_frame)?;
    let size = capture.content_size();
    Ok((Input::Wgc { capture, frame }, size))
}

fn interval_us(fps: u32) -> u64 {
    1_000_000 / fps.max(1) as u64
}

/// [`WGC_MIN_UPDATE_US`], at most half an interval (fps above 125).
fn wgc_min_update_us(fps: u32) -> u64 {
    WGC_MIN_UPDATE_US.min(interval_us(fps) / 2)
}

/// The CBR target for an encoder size: the user's value, or Auto.
fn target_for(cfg: &CaptureConfig, width: u32, height: u32) -> u32 {
    if cfg.bitrate_kbps > 0 { cfg.bitrate_kbps } else { lan_bitrate_kbps(width, height, cfg.fps, cfg.codec) }
}

fn encoder_config(cfg: &CaptureConfig, width: u32, height: u32, kbps: u32) -> EncoderConfig {
    EncoderConfig { codec: cfg.codec, width, height, fps: cfg.fps, bitrate_kbps: kbps, vbv_frames: cfg.vbv_frames }
}

/// Everything the `st-capture` thread owns.
struct Pipeline {
    gpu: Gpu,
    cfg: CaptureConfig,
    source: Source,
    input: Input,
    /// source size the encoder size was made for
    src_size: (u32, u32),
    /// a different source size and since when it holds
    resize: Option<((u32, u32), u64)>,
    converter: Converter,
    encoder: Encoder,
    target_kbps: u32,
    slot: usize,
    /// slot holding the newest picture (repeats encode it again); None until the first picture
    last_slot: Option<usize>,
    frame_id: u32,
    /// the next frame is an IDR
    idr: bool,
    /// the source is gone or the encoder failed for good
    closed: bool,
    /// the encoder failed for good
    failed: bool,
    frames: u64,
    repeated: u64,
    keyframes: u64,
}

impl Pipeline {
    fn new(source: Source, cfg: CaptureConfig, shared: &Arc<Shared>) -> Result<Pipeline, String> {
        NvencLib::get()?;
        let gpu = Gpu::nvidia()?;
        prio::boost_device(&gpu.device);
        let (input, src_size) = start_input(&gpu, source, &cfg, shared)?;
        let (w, h) = output_size(src_size.0, src_size.1, cfg.max_height);
        let target_kbps = target_for(&cfg, w, h);
        let encoder = Encoder::open(&gpu, &encoder_config(&cfg, w, h, target_kbps))?;
        let converter = Converter::new(&gpu, src_size.0, src_size.1, w, h)?;
        Ok(Pipeline {
            gpu,
            cfg,
            source,
            input,
            src_size,
            resize: None,
            converter,
            encoder,
            target_kbps,
            slot: 0,
            last_slot: None,
            frame_id: 0,
            idr: true,
            closed: false,
            failed: false,
            frames: 0,
            repeated: 0,
            keyframes: 0,
        })
    }

    fn interval(&self) -> u64 {
        interval_us(self.cfg.fps)
    }

    /// Converts the newest picture into the next slot and encodes it. Ok(None) when the source has not delivered
    /// a picture yet.
    fn encode_new(&mut self, capture_us: u64) -> Result<Option<EncodedFrame>, String> {
        let slot = (self.slot + 1) % INPUT_SLOTS;
        let target = self.encoder.input(slot).clone();
        match &mut self.input {
            Input::Pattern(p) => {
                let texture = p.next()?;
                self.converter.convert(&texture, &target)?;
            }
            Input::Wgc { frame, .. } => {
                let cap = lock(frame);
                let Some(c) = cap.as_ref() else { return Ok(None) };
                self.converter.convert(&c.texture, &target)?;
            }
        }
        self.slot = slot;
        self.encode_slot(slot, capture_us, false).map(Some)
    }

    /// Encodes the last picture again (static content).
    fn encode_repeat(&mut self, now: u64) -> Result<Option<EncodedFrame>, String> {
        let Some(slot) = self.last_slot else { return Ok(None) };
        self.encode_slot(slot, now, true).map(Some)
    }

    fn encode_slot(&mut self, slot: usize, capture_us: u64, repeat: bool) -> Result<EncodedFrame, String> {
        let idr = std::mem::take(&mut self.idr);
        let id = match self.frame_id.wrapping_add(1) {
            0 => 1,
            n => n,
        };
        let out = match self.encoder.encode(slot, id, idr) {
            Ok(out) => out,
            Err(e) => {
                self.idr |= idr;
                return Err(e);
            }
        };
        self.frame_id = id;
        self.last_slot = Some(slot);
        self.frames += 1;
        self.repeated += repeat as u64;
        self.keyframes += out.key as u64;
        let ec = self.encoder.config();
        Ok(EncodedFrame {
            frame_id: id,
            codec: self.cfg.codec,
            key: out.key,
            after_invalidation: out.after_invalidation,
            repeat,
            data: out.data,
            capture_us,
            encoded_us: now_us(),
            width: ec.width,
            height: ec.height,
        })
    }

    fn request(&mut self, r: EncoderRequest) {
        match r {
            EncoderRequest::Keyframe => self.idr = true,
            EncoderRequest::InvalidateRefs { first, last } => {
                if !matches!(self.encoder.invalidate(first, last), Ok(true)) {
                    self.idr = true;
                }
            }
            EncoderRequest::Bitrate { kbps } => {
                // a bitrate the user set by hand never changes
                if self.cfg.bitrate_kbps == 0 {
                    if let Err(e) = self.encoder.set_bitrate(kbps.clamp(100, self.target_kbps)) {
                        eprintln!("[native] bitrate: {e}");
                    }
                }
            }
        }
    }

    /// Size, fps or rate changed: a new encoder (and converter) when its settings differ. Returns whether the
    /// encoder was replaced (then the latest picture must be converted again: the new slots are empty).
    fn rebuild(&mut self, src: (u32, u32)) -> Result<bool, String> {
        let (w, h) = output_size(src.0, src.1, self.cfg.max_height);
        let target = target_for(&self.cfg, w, h);
        let ec = encoder_config(&self.cfg, w, h, target);
        let current = self.encoder.config();
        let replaced = EncoderConfig { bitrate_kbps: ec.bitrate_kbps, ..current } != ec;
        if replaced {
            self.encoder.reopen(&ec)?;
            self.converter = Converter::new(&self.gpu, src.0, src.1, w, h)?;
            self.last_slot = None;
            self.idr = true;
        } else if current.bitrate_kbps != target {
            self.encoder.set_bitrate(target)?;
        }
        self.target_kbps = target;
        self.src_size = src;
        self.resize = None;
        Ok(replaced)
    }

    /// Applies a command; true when the latest picture must be encoded again (new encoder / source).
    fn command(&mut self, c: Command, shared: &Arc<Shared>) -> bool {
        match c {
            Command::Target(kbps) => {
                self.cfg.bitrate_kbps = kbps;
                let ec = self.encoder.config();
                self.target_kbps = target_for(&self.cfg, ec.width, ec.height);
                if let Err(e) = self.encoder.set_bitrate(self.target_kbps) {
                    eprintln!("[native] bitrate: {e}");
                }
                false
            }
            Command::Source(source, reply) => {
                let r = start_input(&self.gpu, source, &self.cfg, shared).and_then(|(input, size)| {
                    // the old capture stops here (on this thread, no lock held)
                    self.input = input;
                    self.source = source;
                    self.closed = false;
                    self.idr = true;
                    self.rebuild(size)
                });
                let ok = r.is_ok();
                let _ = reply.send(r.map(|_| ()));
                ok
            }
            Command::Reconfigure { fps, max_height, reply } => {
                let old = self.cfg;
                self.cfg.fps = fps;
                self.cfg.max_height = max_height;
                if let Input::Wgc { capture, .. } = &self.input {
                    capture.set_min_interval(wgc_min_update_us(fps));
                }
                let r = self.rebuild(self.src_size);
                if r.is_err() {
                    self.cfg = old;
                }
                let again = r.as_ref().is_ok_and(|&replaced| replaced);
                let _ = reply.send(r.map(|_| ()));
                again
            }
        }
    }

    /// WGC: follows a new window size once it has settled; also notices a closed source.
    fn watch_source(&mut self, now: u64) -> bool {
        let Input::Wgc { capture, frame } = &self.input else { return false };
        if capture.closed() {
            self.closed = true;
            return false;
        }
        let size = lock(frame).as_ref().map(|c| (c.width, c.height));
        let Some(size) = size.filter(|&s| s != self.src_size) else {
            self.resize = None;
            return false;
        };
        match self.resize {
            Some((s, since)) if s == size => {
                if now.saturating_sub(since) < RESIZE_SETTLE_US {
                    return false;
                }
                match self.rebuild(size) {
                    Ok(replaced) => replaced,
                    Err(e) => {
                        eprintln!("[native] resize to {}x{}: {e}", size.0, size.1);
                        self.resize = None;
                        false
                    }
                }
            }
            _ => {
                self.resize = Some((size, now));
                false
            }
        }
    }

    /// Everything new on a fresh device (after a driver reset); frame ids and totals continue.
    fn rebuild_all(&mut self, shared: &Arc<Shared>) -> Result<(), String> {
        let mut fresh = Pipeline::new(self.source, self.cfg, shared)?;
        fresh.frame_id = self.frame_id;
        fresh.frames = self.frames;
        fresh.repeated = self.repeated;
        fresh.keyframes = self.keyframes;
        *self = fresh;
        Ok(())
    }

    fn minimized(&self) -> bool {
        matches!(&self.input, Input::Wgc { capture, .. } if capture.minimized())
    }

    /// Writes the settings part of the stats (and the per-second rates when given).
    fn publish(&self, shared: &Shared, rates: Option<(f32, f32, f32)>) {
        let ec = self.encoder.config();
        let mut s = lock(&shared.stats);
        s.codec = self.cfg.codec.name().into();
        s.encoder = "NVENC".into();
        s.gpu = self.gpu.name.clone();
        s.width = ec.width;
        s.height = ec.height;
        s.fps = self.cfg.fps;
        s.target_kbps = self.target_kbps;
        s.bitrate_kbps = ec.bitrate_kbps;
        s.frames = self.frames;
        s.repeated = self.repeated;
        s.keyframes = self.keyframes;
        s.minimized = self.minimized();
        s.closed = self.closed;
        s.failed = self.failed;
        if let Some((capture_fps, encode_fps, encode_ms)) = rates {
            s.capture_fps = capture_fps;
            s.encode_fps = encode_fps;
            s.encode_ms = encode_ms;
        }
    }
}

/// Per-second counters for the stats.
struct Window {
    start: u64,
    captured: u64,
    encoded: u32,
    latency_us: u64,
}

impl Window {
    fn new(now: u64, captured: u64) -> Window {
        Window { start: now, captured, encoded: 0, latency_us: 0 }
    }
}

/// Which pictures are encoded, so that the encoder runs at exactly fps however often the source delivers (WGC
/// hands over every composition: 144 pictures a second from a 144 Hz monitor). Time is cut into beats one interval
/// apart, and each beat encodes at most one picture:
/// * the first picture that arrives in a beat's window (from a quarter interval before the beat to a quarter
///   interval before the next one) is encoded at once;
/// * a picture that arrives while the beat before it is already used waits (a newer one replaces it); it is encoded
///   a quarter interval after its beat if nothing arrived by then. Encoding it as soon as the window opens would
///   lock every frame a fixed delay behind the display: from a 60 Hz monitor at 30 fps each picture would be 8 ms
///   old, from 120 Hz at 60 fps 4 ms;
/// * beats nothing arrived for are skipped; the others keep their phase, so the rate stays exactly fps.
#[derive(Clone, Copy, Debug)]
struct Cadence {
    interval: u64,
    /// the next beat to use (µs); 0 = none yet: the next picture is encoded at once and sets the phase
    next: u64,
}

impl Cadence {
    fn new(interval: u64) -> Cadence {
        Cadence { interval, next: 0 }
    }

    fn early(&self) -> u64 {
        (self.interval as f64 * EARLY_SHARE) as u64
    }

    /// When a picture that arrived at `arrived` may be encoded.
    fn ready(&self, arrived: u64) -> u64 {
        if self.next == 0 || arrived + self.early() >= self.next {
            arrived
        } else {
            self.next + self.early()
        }
    }

    /// A picture was encoded that was ready at `at` ([`Self::ready`]; a repeat: its time): it used the beat whose
    /// window holds `at`.
    fn used(&mut self, at: u64) {
        let early = self.early();
        if self.next == 0 {
            self.next = at;
        } else if at + early >= self.next + self.interval {
            // nothing arrived in the windows of one or more beats: skip them
            self.next += (at + early - self.next) / self.interval * self.interval;
        }
        self.next += self.interval;
    }
}

/// The `st-capture` loop: wait for a picture, a request, a command or a deadline; then encode at most one frame.
fn run(mut p: Pipeline, shared: &Arc<Shared>, mut sink: FrameSink) {
    let start = now_us();
    let mut cadence = Cadence::new(p.interval());
    // arrival time of a picture not encoded yet
    let mut pending: Option<u64> = None;
    let mut last_new = start;
    let mut last_encode = start;
    let mut next_tick = start;
    let mut paused = false;
    let mut errors = 0u32;
    let mut rebuilds = 0u32;
    let mut window = Window::new(start, 0);
    loop {
        let interval = p.interval();
        if cadence.interval != interval {
            cadence = Cadence::new(interval);
        }
        let is_pattern = matches!(p.input, Input::Pattern(_));
        // the latest moment something is due
        let now = now_us();
        let mut deadline = now + POLL_US;
        if is_pattern && !paused {
            deadline = deadline.min(next_tick);
        }
        if let Some(t) = pending {
            deadline = deadline.min(cadence.ready(t));
        } else if p.last_slot.is_some() {
            deadline = deadline.min((last_new + REPEAT_AFTER_INTERVALS * interval).max(last_encode + interval));
        }
        if let Some((_, since)) = p.resize {
            deadline = deadline.min(since + RESIZE_SETTLE_US);
        }

        let (requests, commands, fresh, stop) = {
            let mut inbox = lock(&shared.inbox);
            loop {
                if inbox.stop || inbox.fresh.is_some() || !inbox.requests.is_empty() || !inbox.commands.is_empty() {
                    break;
                }
                let now = now_us();
                if now >= deadline {
                    break;
                }
                inbox = shared.wake.wait_timeout(inbox, Duration::from_micros(deadline - now)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            paused = inbox.paused;
            (std::mem::take(&mut inbox.requests), std::mem::take(&mut inbox.commands), inbox.fresh.take(), inbox.stop)
        };
        if stop {
            break;
        }
        let mut again = false;
        // settings changed: the stats show it at once
        let mut changed = !commands.is_empty() || !requests.is_empty();
        for c in commands {
            again |= p.command(c, shared);
        }
        for r in requests {
            p.request(r);
        }
        let now = now_us();
        if let Some(t) = fresh {
            pending = Some(t);
            last_new = t;
        }
        if is_pattern && !paused && now >= next_tick {
            shared.captured.fetch_add(1, Ordering::Relaxed);
            pending = Some(now);
            last_new = now;
            next_tick += interval;
            if next_tick <= now {
                next_tick = now + interval;
            }
        }
        again |= p.watch_source(now);
        changed |= again;
        if again {
            // new encoder or source: encode the latest picture at its new size right away
            cadence = Cadence::new(p.interval());
            if pending.is_none() {
                pending = Some(now);
                last_new = now;
            }
        }

        if !p.closed {
            let repeat_due = now >= (last_new + REPEAT_AFTER_INTERVALS * interval).max(last_encode + interval);
            let job = match pending {
                Some(t) => Some((t, false, cadence.ready(t))).filter(|j| now >= j.2),
                None if repeat_due && p.last_slot.is_some() => Some((now, true, now)),
                None => None,
            };
            if let Some((capture_us, repeat, ready)) = job {
                let r = if repeat { p.encode_repeat(now) } else { p.encode_new(capture_us) };
                if !repeat {
                    pending = None;
                }
                match r {
                    Ok(Some(frame)) => {
                        errors = 0;
                        cadence.used(ready);
                        last_encode = now;
                        window.encoded += 1;
                        window.latency_us += frame.encoded_us.saturating_sub(frame.capture_us);
                        sink(frame);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        errors += 1;
                        eprintln!("[native] encode: {e}");
                        if errors >= MAX_ERRORS {
                            errors = 0;
                            rebuilds += 1;
                            let r = if rebuilds > MAX_REBUILDS { Err("too many failures".to_string()) } else { p.rebuild_all(shared) };
                            match r {
                                Ok(()) => {
                                    eprintln!("[native] capture rebuilt after encode errors");
                                    pending = Some(now_us());
                                }
                                Err(e) => {
                                    eprintln!("[native] capture ends: {e}");
                                    p.closed = true;
                                    p.failed = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        let now = now_us();
        let elapsed = now.saturating_sub(window.start);
        if elapsed >= 1_000_000 || changed {
            let captured = shared.captured.load(Ordering::Relaxed);
            let secs = elapsed.max(1) as f32 / 1e6;
            let rates = (elapsed >= 1_000_000).then(|| {
                let capture_fps = captured.saturating_sub(window.captured) as f32 / secs;
                let encode_fps = window.encoded as f32 / secs;
                let encode_ms = if window.encoded > 0 { window.latency_us as f32 / window.encoded as f32 / 1000.0 } else { 0.0 };
                (capture_fps, encode_fps, encode_ms)
            });
            p.publish(shared, rates);
            if rates.is_some() {
                window = Window::new(now, captured);
            }
        } else if p.closed {
            p.publish(shared, None);
        }
    }
    p.publish(shared, None);
}

/// What the machine can share natively. Cached after the first call (NVENC probing opens a session: ~100 ms).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvencCaps {
    /// NVENC usable: driver library, API ≥ 12.0, an NVIDIA adapter, WGC supported
    pub available: bool,
    pub h264: bool,
    pub hevc: bool,
    pub av1: bool,
    /// adapter name ("" if none)
    pub gpu: String,
    pub max_width: u32,
    pub max_height: u32,
    /// why not available (log only, never shown raw in the UI)
    pub reason: String,
}

pub fn probe() -> NvencCaps {
    static CAPS: OnceLock<NvencCaps> = OnceLock::new();
    CAPS.get_or_init(|| {
        std::panic::catch_unwind(probe_now)
            .unwrap_or_else(|_| NvencCaps { reason: "probe failed".into(), ..Default::default() })
    })
    .clone()
}

fn probe_now() -> NvencCaps {
    let mut caps = NvencCaps { gpu: Gpu::nvidia_name(), ..Default::default() };
    if caps.gpu.is_empty() {
        caps.reason = "no NVIDIA adapter".into();
        return caps;
    }
    if let Err(e) = NvencLib::get() {
        caps.reason = e;
        return caps;
    }
    if !WgcCapture::supported() {
        caps.reason = "Windows.Graphics.Capture not supported".into();
        return caps;
    }
    let support = Gpu::nvidia().and_then(|gpu| nvenc::query(&gpu));
    match support {
        Ok(s) => {
            caps.h264 = s.h264;
            caps.hevc = s.hevc;
            caps.av1 = s.av1;
            caps.max_width = s.max_width;
            caps.max_height = s.max_height;
            caps.available = s.h264 || s.hevc;
            if !caps.available {
                caps.reason = "NVENC offers neither H.264 nor HEVC".into();
            }
        }
        Err(e) => caps.reason = e,
    }
    caps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids() {
        assert_eq!(parse_source("window:132456:0", 0, 0), Ok(Source::Window(132456)));
        assert!(parse_source("window:0:0", 0, 0).is_err());
        assert!(parse_source("web-contents-media-stream://1:2", 0, 0).is_err());
        assert!(parse_source("", 0, 0).is_err());
    }

    #[test]
    fn auto_target_follows_size() {
        let cfg = CaptureConfig { codec: Codec::Hevc, fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: true };
        assert_eq!(target_for(&cfg, 2560, 1440), 35_600);
        assert_eq!(target_for(&cfg, 1920, 1080), 20_000);
        assert_eq!(target_for(&CaptureConfig { bitrate_kbps: 12_000, ..cfg }, 2560, 1440), 12_000);
    }

    /// Pictures of a display at `hz` for `secs` from t = 1 s, each up to `jitter_us` late (fixed pseudo-random).
    fn display(hz: f64, secs: f64, jitter_us: u64) -> Vec<u64> {
        let mut r = 0x2545_f491_4f6c_dd1du64;
        (0..(hz * secs) as u64)
            .map(|k| {
                r ^= r << 13;
                r ^= r >> 7;
                r ^= r << 17;
                1_000_000 + (k as f64 * 1e6 / hz) as u64 + r % jitter_us.max(1)
            })
            .collect()
    }

    /// Runs [`Cadence`] the way `run` does: a picture is encoded once it is ready, a newer one replaces a waiting
    /// one. Returns (encode time, arrival of the picture encoded).
    fn encodes(arrivals: &[u64], fps: u32) -> Vec<(u64, u64)> {
        let mut cadence = Cadence::new(interval_us(fps));
        let mut pending: Option<u64> = None;
        let mut out = Vec::new();
        for &t in arrivals.iter().chain([u64::MAX].iter()) {
            if let Some(a) = pending.filter(|&a| cadence.ready(a) < t) {
                let at = cadence.ready(a);
                cadence.used(at);
                out.push((at, a));
            }
            if t == u64::MAX {
                break;
            }
            pending = Some(t);
            if cadence.ready(t) <= t {
                cadence.used(t);
                out.push((t, t));
                pending = None;
            }
        }
        out
    }

    /// Faster displays: exactly fps, and every encoded picture is the newest at once (no wait for a beat), also at
    /// rates that are no multiple of fps. With WGC's old 1 / fps floor 144 Hz gave 48 fps; a credit that is
    /// spent as soon as it allows kept every picture waiting up to a refresh (30 fps on 60 Hz: 8 ms each).
    #[test]
    fn cadence_holds_fps_without_delay() {
        for (hz, fps) in [(60.0, 60), (120.0, 60), (144.0, 60), (165.0, 60), (240.0, 60), (60.0, 30), (144.0, 30), (240.0, 120), (60.0, 120)] {
            let out = encodes(&display(hz, 12.0, 500), fps);
            // seconds 2..11 (no start, no end)
            let mid: Vec<_> = out.iter().filter(|e| (3_000_000..12_000_000).contains(&e.0)).collect();
            let want = (fps as f64).min(hz) * 9.0;
            assert!((mid.len() as f64 - want).abs() <= 1.0, "{hz} Hz at {fps} fps: {} frames in 9 s", mid.len());
            let late = mid.iter().filter(|e| e.0 != e.1).count();
            assert_eq!(late, 0, "{hz} Hz at {fps} fps: {late} pictures waited");
            // never faster than fps allows: at most one picture per beat window
            let min_gap = mid.windows(2).map(|w| w[1].0 - w[0].0).min().unwrap();
            assert!(min_gap >= interval_us(fps) / 2, "{hz} Hz at {fps} fps: frames {min_gap} µs apart");
        }
    }

    /// A picture that comes too early waits for its beat (+ a quarter interval) unless a newer one arrives; a
    /// source that pauses starts a new phase.
    #[test]
    fn cadence_early_pictures_wait_and_newest_wins() {
        let i = interval_us(60);
        let mut c = Cadence::new(i);
        assert_eq!(c.ready(1_000_000), 1_000_000);
        c.used(1_000_000);
        // 5 ms later: too early, waits until a quarter interval after the next beat
        assert_eq!(c.ready(1_005_000), 1_000_000 + i + i / 4);
        // from a quarter interval before the beat on: at once
        assert_eq!(c.ready(1_000_000 + i - i / 4), 1_000_000 + i - i / 4);
        // two pictures early, then nothing: the newest is encoded once, at beat + ¼
        let out = encodes(&[1_000_000, 1_004_000, 1_008_000], 60);
        assert_eq!(out, vec![(1_000_000, 1_000_000), (1_000_000 + i + i / 4, 1_008_000)]);
        // a long pause skips the beats in between and keeps the phase
        let mut c = Cadence::new(i);
        c.used(1_000_000);
        c.used(1_000_000 + 10 * i + 1_000);
        assert_eq!(c.next, 1_000_000 + 11 * i);
    }

    /// The WGC floor stays at 4 ms (every composition up to 250 Hz) and below half an interval.
    #[test]
    fn wgc_floor_is_not_the_frame_interval() {
        assert_eq!(wgc_min_update_us(30), 4_000);
        assert_eq!(wgc_min_update_us(60), 4_000);
        assert_eq!(wgc_min_update_us(120), 4_000);
        assert_eq!(wgc_min_update_us(240), 2_083);
    }

    /// Never panics, with or without NVIDIA; when not available it says why.
    #[test]
    fn probe_is_safe() {
        let caps = probe();
        assert!(caps.available || !caps.reason.is_empty());
        assert_eq!(caps.available, caps.h264 || caps.hevc);
    }
}

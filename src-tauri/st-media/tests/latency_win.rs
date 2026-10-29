//! End-to-end timing of the native path on this PC (docs/NATIVE-PATH.md §12): TestPattern frames drawn on the GPU (no
//! screen access, no window) → NVENC → `send::Sender` → stm/1 over 127.0.0.1 → `recv::Receiver` → access units, every
//! frame timed on the one process clock, at 2560x1440 / 60 fps with the Auto bitrate for 10 s per codec. Share sound
//! runs alongside (4 × 5 ms chunks every 20 ms, as the glue's sysaudio tap pushes them), so its packets compete with
//! the video as they do in the app.
//!
//! Ignored by default: it runs for about half a minute and wants a release build (debug AES-GCM and Reed-Solomon add
//! milliseconds that the app does not have, see the NET note in §14):
//!   cargo test --release --manifest-path st-media/Cargo.toml --target-dir target --test latency_win -- --ignored --nocapture
//! `ST_NV_DUMP=<dir>` also writes `<dir>/<codec>.nvdump` (every access unit as the raw Channel message the page gets,
//! §9.3, with its delivery time) and `<dir>/<codec>.json` (the numbers printed here); `tests/e2e/native-latency.mjs`
//! replays the dump into the page's decoder in headless Edge.
#![cfg(windows)]

mod win_common;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver as Rx};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use st_media::clock::{epoch_us, now_us};
use st_media::net::ctrl::ByeReason;
use st_media::recv::{RecvEvent, Receiver};
use st_media::send::{Sender, SenderConfig, ViewerCaps};
use st_media::win::{CaptureConfig, CaptureSession, Source};
use st_media::{AudioChunk, Codec, Endpoint, EndpointConfig, LinkEvent, Role, AUDIO_CHANNELS, AUDIO_PACKET_FRAMES, AUDIO_RATE};
use win_common::{gpu_lock, nvenc_gpu};

const WIDTH: u32 = 2560;
const HEIGHT: u32 = 1440;
const FPS: u32 = 60;
/// Frames before this are the warm-up (link up, first key frame, encoder settling) and not measured.
const WARMUP_MS: u64 = 1000;
const MEASURE_MS: u64 = 10_000;

/// One encoded frame on the sharer side.
#[derive(Clone, Copy)]
struct Sent {
    capture_us: u64,
    encoded_us: u64,
    /// `push_frame` returned: sharded, FEC computed, queued on the link
    pushed_us: u64,
}

/// One access unit on the viewer side.
struct Got {
    frame_id: u32,
    key: bool,
    capture_us: u64,
    /// handed to the sink (the glue sends it to the page from here)
    at_us: u64,
    /// the receiver's own capture → handed-over estimate (through the ping/pong clock offset)
    age_us: u32,
    bytes: usize,
    /// the raw Channel message (§9.3)
    msg: Vec<u8>,
}

/// The page message of `native_media::video_message` (that function lives in the app crate).
fn video_message(au: &st_media::recv::VideoAu) -> Vec<u8> {
    let mut b = Vec::with_capacity(32 + au.data.len());
    b.extend_from_slice(&[1, u8::from(au.key) | (u8::from(au.recovered) << 1) | (u8::from(au.after_loss) << 2), au.codec as u8, 0]);
    b.extend_from_slice(&au.frame_id.to_le_bytes());
    b.extend_from_slice(&au.pts_us.to_le_bytes());
    b.extend_from_slice(&au.age_us.to_le_bytes());
    b.extend_from_slice(&au.sender_latency_us.to_le_bytes());
    b.extend_from_slice(&epoch_us().to_le_bytes());
    b.extend_from_slice(&au.data);
    b
}

/// p50 / p95 / p99 / max / mean of `v` (ms).
#[derive(Clone, Copy, Debug, Default)]
struct Dist {
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
    mean: f64,
    sd: f64,
}

fn dist(v: &[f64]) -> Dist {
    if v.is_empty() {
        return Dist::default();
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    let sd = (s.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / s.len() as f64).sqrt();
    Dist { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.len() - 1], mean, sd }
}

impl Dist {
    fn json(&self) -> String {
        format!(
            r#"{{"p50":{:.3},"p95":{:.3},"p99":{:.3},"max":{:.3},"mean":{:.3},"sd":{:.3}}}"#,
            self.p50, self.p95, self.p99, self.max, self.mean, self.sd
        )
    }

    fn line(&self) -> String {
        format!("p50 {:.2}  p95 {:.2}  p99 {:.2}  max {:.2}  (mean {:.2}, sd {:.2})", self.p50, self.p95, self.p99, self.max, self.mean, self.sd)
    }
}

fn wait_up(events: &Rx<LinkEvent>, who: &str) {
    let deadline = std::time::Instant::now() + Duration::from_millis(st_media::net::ice::DEADLINE_MS + 1000);
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match events.recv_timeout(left) {
            Ok(LinkEvent::Up(_)) => return,
            Ok(LinkEvent::Failed(e)) | Ok(LinkEvent::Closed(e)) => panic!("{who}: link failed: {e}"),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    panic!("{who}: no Up within the deadline");
}

/// Runs one codec for WARMUP_MS + MEASURE_MS, prints the numbers, returns them as JSON (and dumps if asked) and
/// what failed the checks.
fn run(codec: Codec) -> (String, Vec<String>) {
    let share_ep = Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).expect("sharer endpoint");
    let watch_ep = Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).expect("viewer endpoint");
    let (share_tx, share_events) = channel();
    let (watch_tx, watch_events) = channel();
    let (share_tx, watch_tx) = (Mutex::new(share_tx), Mutex::new(watch_tx));
    let share_link = share_ep.create_link(Role::Share, Arc::new(move |e| drop(share_tx.lock().unwrap().send(e)))).expect("share link");
    let watch_link = watch_ep.create_link(Role::Watch, Arc::new(move |e| drop(watch_tx.lock().unwrap().send(e)))).expect("watch link");
    watch_link.set_remote(share_link.id(), share_link.public_key(), &share_link.local_candidates()).expect("viewer remote");
    share_link.set_remote(watch_link.id(), watch_link.public_key(), &watch_link.local_candidates()).expect("sharer remote");
    wait_up(&share_events, "sharer");
    wait_up(&watch_events, "viewer");

    // viewer: what the glue's Receiver sink sees
    let got: Arc<Mutex<Vec<Got>>> = Arc::new(Mutex::new(Vec::new()));
    let audio: Arc<Mutex<Vec<(u64, u64, u8)>>> = Arc::new(Mutex::new(Vec::new()));
    let (g, a) = (got.clone(), audio.clone());
    let receiver = Receiver::attach(
        &watch_link,
        Arc::new(move |e| {
            let at_us = now_us();
            match e {
                RecvEvent::Video(au) => {
                    let msg = video_message(&au);
                    let got = Got { frame_id: au.frame_id, key: au.key, capture_us: au.pts_us, at_us, age_us: au.age_us, bytes: au.data.len(), msg };
                    g.lock().unwrap().push(got);
                }
                RecvEvent::Audio(b) => a.lock().unwrap().push((b.capture_us, at_us, b.concealed)),
            }
        }),
    );

    // sharer: §8 "Wiring a share codec", with the sink timed around push_frame
    let sent: Arc<Mutex<HashMap<u32, Sent>>> = Arc::new(Mutex::new(HashMap::new()));
    let cell: Arc<OnceLock<Arc<Sender>>> = Arc::new(OnceLock::new());
    let (c, s) = (cell.clone(), sent.clone());
    let cfg = CaptureConfig { codec, fps: FPS, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
    let mut capture = CaptureSession::start(
        Source::TestPattern { width: WIDTH, height: HEIGHT },
        cfg,
        Box::new(move |f| {
            let Some(sender) = c.get() else { return };
            sender.push_frame(&f);
            let pushed_us = now_us();
            s.lock().unwrap().insert(f.frame_id, Sent { capture_us: f.capture_us, encoded_us: f.encoded_us, pushed_us });
        }),
    )
    .expect("capture");
    let target_kbps = capture.stats().target_kbps;
    let sender = Sender::new(SenderConfig { codec, target_kbps, fixed: false }, capture.request_handle());
    let _ = cell.set(sender.clone());
    sender.add_link(&share_link, ViewerCaps { rfi: false });

    // share sound: a 440 Hz tone, 20 ms at a time split into 4 × 5 ms (as the glue's sysaudio tap does)
    let stop_audio = Arc::new(AtomicBool::new(false));
    let audio_thread = {
        let (sender, stop) = (sender.clone(), stop_audio.clone());
        std::thread::spawn(move || {
            let (mut seq, mut phase, mut next) = (0u32, 0f32, now_us());
            while !stop.load(Ordering::Relaxed) {
                next += 20_000;
                while now_us() < next {
                    std::thread::sleep(Duration::from_micros(500));
                }
                let now = now_us();
                for i in 0..4u64 {
                    let mut pcm = Vec::with_capacity(AUDIO_PACKET_FRAMES * AUDIO_CHANNELS);
                    for _ in 0..AUDIO_PACKET_FRAMES {
                        let v = (phase.sin() * 0.3 * 32767.0) as i16;
                        phase += 2.0 * std::f32::consts::PI * 440.0 / AUDIO_RATE as f32;
                        pcm.extend_from_slice(&[v, v]);
                    }
                    sender.push_audio(&AudioChunk { seq, capture_us: now.saturating_sub(20_000) + i * 5_000, pcm });
                    seq = seq.wrapping_add(1);
                }
            }
        })
    };

    let t0 = now_us();
    std::thread::sleep(Duration::from_millis(WARMUP_MS + MEASURE_MS + 300));
    let (from, to) = (t0 + WARMUP_MS * 1000, t0 + (WARMUP_MS + MEASURE_MS) * 1000);
    stop_audio.store(true, Ordering::Relaxed);
    let _ = audio_thread.join();
    let cap_stats = capture.stats();
    let send_stats = sender.stats();
    let recv_stats = receiver.stats();
    let link_stats = share_link.stats();
    capture.stop();
    receiver.close();
    sender.remove_link(share_link.id());
    share_link.close(ByeReason::Ended);
    watch_link.close(ByeReason::Closed);
    share_ep.close();
    watch_ep.close();

    let got = std::mem::take(&mut *got.lock().unwrap());
    let sent = sent.lock().unwrap().clone();
    let audio = audio.lock().unwrap().clone();
    assert!(!got.is_empty(), "{}: no access unit arrived", codec.name());
    // frames that never reached the viewer: (last delivered, next delivered)
    let gaps: Vec<(u32, u32)> = got.windows(2).filter(|w| w[1].frame_id != w[0].frame_id + 1).map(|w| (w[0].frame_id, w[1].frame_id)).collect();
    let win: Vec<&Got> = got.iter().filter(|g| g.capture_us >= from && g.capture_us < to).collect();
    let encoded_in_win = sent.values().filter(|s| s.capture_us >= from && s.capture_us < to).count();
    let ms = |us: u64| us as f64 / 1000.0;
    let mut cap_enc = Vec::new();
    let mut enc_push = Vec::new();
    let mut enc_recv = Vec::new();
    let mut cap_recv = Vec::new();
    let mut age_err = Vec::new();
    for g in &win {
        let s = sent.get(&g.frame_id).expect("every delivered frame was sent");
        assert_eq!(s.capture_us, g.capture_us, "frame {}: pts is the capture time", g.frame_id);
        cap_enc.push(ms(s.encoded_us - s.capture_us));
        enc_push.push(ms(s.pushed_us.saturating_sub(s.encoded_us)));
        enc_recv.push(ms(g.at_us - s.encoded_us));
        cap_recv.push(ms(g.at_us - s.capture_us));
        if g.age_us > 0 {
            age_err.push((g.age_us as f64 / 1000.0 - ms(g.at_us - s.capture_us)).abs());
        }
    }
    // steadiness: frame intervals at the capture and at the viewer, bitrate per second and per 100 ms
    let interval = |t: Vec<u64>| -> Vec<f64> { t.windows(2).map(|w| ms(w[1] - w[0])).collect() };
    let mut cap_times: Vec<u64> = sent.values().map(|s| s.capture_us).filter(|t| (from..to).contains(t)).collect();
    cap_times.sort_unstable();
    let cap_iv = dist(&interval(cap_times));
    let recv_iv_v = interval(win.iter().map(|g| g.at_us).collect());
    let recv_iv = dist(&recv_iv_v);
    let frame_ms = 1000.0 / FPS as f64;
    let jitter = dist(&recv_iv_v.iter().map(|x| (x - frame_ms).abs()).collect::<Vec<_>>());
    let kbps_per = |bucket_us: u64| -> Vec<f64> {
        let n = ((to - from) / bucket_us) as usize;
        let mut b = vec![0usize; n];
        for g in &win {
            let i = ((g.capture_us - from) / bucket_us) as usize;
            if i < n {
                b[i] += g.bytes;
            }
        }
        b.iter().map(|&x| x as f64 * 8.0 / (bucket_us as f64 / 1e6) / 1000.0).collect()
    };
    let kbps_s = dist(&kbps_per(1_000_000));
    let kbps_100 = dist(&kbps_per(100_000));
    let delta_kb = dist(&win.iter().filter(|g| !g.key).map(|g| g.bytes as f64 / 1000.0).collect::<Vec<_>>());
    let keys: Vec<&Got> = got.iter().filter(|g| g.key).collect();
    let key_ms: Vec<String> = keys.iter().map(|g| format!("{:.2} ms / {} KB", ms(g.at_us - sent[&g.frame_id].capture_us), g.bytes / 1000)).collect();
    // sound: capture of the block's first sample → block handed over (20 ms of samples + reordering wait)
    let aud: Vec<f64> = audio.iter().filter(|a| (from..to).contains(&a.0)).map(|a| ms(a.1.saturating_sub(a.0))).collect();
    let concealed: u32 = audio.iter().filter(|a| (from..to).contains(&a.0)).map(|a| a.2 as u32).sum();
    let aud = dist(&aud);
    let cap_enc = dist(&cap_enc);
    let enc_push = dist(&enc_push);
    let enc_recv = dist(&enc_recv);
    let cap_recv = dist(&cap_recv);
    let age_err = dist(&age_err);

    let name = codec.name();
    eprintln!("── {name} {WIDTH}x{HEIGHT}@{FPS}, Auto target {target_kbps} kbit/s, {} s measured ──", MEASURE_MS / 1000);
    eprintln!("frames: {} encoded, {} delivered in the window; receiver {recv_stats:?}", encoded_in_win, win.len());
    eprintln!("sender {send_stats:?}; link {link_stats:?}");
    eprintln!("gaps in decode order: {gaps:?}");
    eprintln!("capture {cap_stats:?}");
    eprintln!("capture → encoded     {}", cap_enc.line());
    eprintln!("encoded → pushed      {}", enc_push.line());
    eprintln!("encoded → delivered   {}", enc_recv.line());
    eprintln!("capture → delivered   {}", cap_recv.line());
    eprintln!("age estimate error    {}", age_err.line());
    eprintln!("capture interval      {}", cap_iv.line());
    eprintln!("delivery interval     {}", recv_iv.line());
    eprintln!("|interval − {frame_ms:.2}|   {}", jitter.line());
    eprintln!("kbit/s per second     {}", kbps_s.line());
    eprintln!("kbit/s per 100 ms     {}", kbps_100.line());
    eprintln!("delta frame KB        {}", delta_kb.line());
    eprintln!("key frames            {}", key_ms.join(", "));
    eprintln!("sound capture → out   {}  ({} blocks, {concealed} × 5 ms concealed)", aud.line(), audio.len());

    let mut json = String::new();
    let _ = write!(
        json,
        r#"{{"codec":"{name}","width":{WIDTH},"height":{HEIGHT},"fps":{FPS},"targetKbps":{target_kbps},"measuredS":{},"encoded":{encoded_in_win},"delivered":{},"lost":{},"recovered":{},"keyframes":{},"captureToEncoded":{},"encodedToPushed":{},"encodedToDelivered":{},"captureToDelivered":{},"ageEstimateError":{},"captureInterval":{},"deliveryInterval":{},"deliveryJitter":{},"kbpsPerSecond":{},"kbpsPer100ms":{},"deltaFrameKB":{},"audioCaptureToDelivered":{},"audioConcealed":{concealed},"encodeMsNvenc":{:.3}}}"#,
        MEASURE_MS / 1000,
        win.len(),
        recv_stats.frames_lost,
        recv_stats.frames_recovered,
        keys.len(),
        cap_enc.json(),
        enc_push.json(),
        enc_recv.json(),
        cap_recv.json(),
        age_err.json(),
        cap_iv.json(),
        recv_iv.json(),
        jitter.json(),
        kbps_s.json(),
        kbps_100.json(),
        delta_kb.json(),
        aud.json(),
        cap_stats.encode_ms,
    );
    if let Ok(dir) = std::env::var("ST_NV_DUMP") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("dump dir");
        // [u32 message length][u64 µs since the first hand-over][message], little-endian, every access unit
        let mut dump = Vec::new();
        let first = got[0].at_us;
        for g in &got {
            dump.extend_from_slice(&(g.msg.len() as u32).to_le_bytes());
            dump.extend_from_slice(&(g.at_us - first).to_le_bytes());
            dump.extend_from_slice(&g.msg);
        }
        std::fs::write(dir.join(format!("{name}.nvdump")), dump).expect("write dump");
        std::fs::write(dir.join(format!("{name}.json")), &json).expect("write summary");
        eprintln!("dumped {} access units to {}", got.len(), dir.display());
    }

    // loose bounds (this PC may be busy): every frame of the window arrives, well within one frame interval
    let mut problems = Vec::new();
    let mut check = |ok: bool, what: String| {
        if !ok {
            problems.push(format!("{name}: {what}"));
        }
    };
    check(got[0].key, "the first access unit is no key frame".into());
    check(gaps.is_empty(), format!("frames missing on loopback (last delivered, next delivered): {gaps:?}"));
    check(recv_stats.frames_lost == 0, format!("{} frames lost on loopback", recv_stats.frames_lost));
    check(win.len() + 2 >= encoded_in_win, format!("{} of {encoded_in_win} frames delivered", win.len()));
    let min_frames = MEASURE_MS * FPS as u64 / 1000 * 4 / 5;
    check(win.len() as u64 >= min_frames, format!("{} frames in {} s at {FPS} fps", win.len(), MEASURE_MS / 1000));
    check(cap_recv.p50 < frame_ms, format!("capture → delivered median {:.2} ms", cap_recv.p50));
    (json, problems)
}

#[test]
#[ignore = "about 25 s on an NVIDIA GPU; run with --release --ignored --nocapture"]
fn loopback_latency_1440p60() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() {
        return;
    }
    let caps = st_media::win::probe();
    let (mut out, mut problems) = (Vec::new(), Vec::new());
    for codec in [Codec::Av1, Codec::Hevc, Codec::H264] {
        let supported = match codec {
            Codec::Av1 => caps.av1,
            Codec::Hevc => caps.hevc,
            Codec::H264 => caps.h264,
        };
        if !supported {
            eprintln!("{}: not supported by this GPU, skipped", codec.name());
            continue;
        }
        let (json, p) = run(codec);
        out.push(json);
        problems.extend(p);
    }
    println!("[{}]", out.join(","));
    assert!(problems.is_empty(), "{}", problems.join("; "));
}

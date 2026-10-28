//! A whole `CaptureSession` on the real GPU with `Source::TestPattern` (docs/NATIVE-PATH.md §12, WIN): frames at
//! the requested rate, repeats when the picture stands still, requests honoured, reconfigure. Never captures the
//! screen. Skips without NVIDIA / NVENC (`ST_REQUIRE_NVENC=1` makes that a failure).
#![cfg(windows)]

mod win_common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use st_media::win::{probe, CaptureConfig, CaptureSession, FrameSink, Source};
use st_media::{Codec, EncodedFrame, EncoderRequest};
use win_common::{check_au, gpu_lock, nvenc_gpu};

#[derive(Clone, Debug)]
struct Seen {
    id: u32,
    key: bool,
    repeat: bool,
    after_invalidation: bool,
    bytes: usize,
    width: u32,
    height: u32,
    latency_us: u64,
    /// sink time (µs, process clock)
    at_us: u64,
}

fn collect() -> (Arc<Mutex<Vec<Seen>>>, FrameSink) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let sink = Box::new(move |f: EncodedFrame| {
        let codec = if f.codec == Codec::Hevc { win_common::Codec::Hevc } else { win_common::Codec::H264 };
        let (key, _) = check_au(codec, &f.data).unwrap_or_else(|e| panic!("frame {}: {e}", f.frame_id));
        assert_eq!(key, f.key, "frame {}: key flag matches the bitstream", f.frame_id);
        s.lock().unwrap().push(Seen {
            id: f.frame_id,
            key: f.key,
            repeat: f.repeat,
            after_invalidation: f.after_invalidation,
            bytes: f.data.len(),
            width: f.width,
            height: f.height,
            latency_us: f.encoded_us - f.capture_us,
            at_us: st_media::clock::now_us(),
        });
    });
    (seen, sink)
}

/// Frames seen since `from` (index).
fn since(seen: &Arc<Mutex<Vec<Seen>>>, from: usize) -> Vec<Seen> {
    seen.lock().unwrap()[from..].to_vec()
}

fn count(seen: &Arc<Mutex<Vec<Seen>>>) -> usize {
    seen.lock().unwrap().len()
}

fn codec_for_this_gpu() -> Codec {
    if probe().hevc { Codec::Hevc } else { Codec::H264 }
}

#[test]
fn probe_reports_nvenc() {
    let caps = probe();
    eprintln!("{caps:?}");
    if nvenc_gpu().is_some() {
        assert!(caps.available && caps.max_width >= 3840, "{caps:?}");
    }
}

#[test]
fn test_pattern_session_end_to_end() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() {
        return;
    }
    let codec = codec_for_this_gpu();
    let cfg = CaptureConfig { codec, fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
    let (seen, sink) = collect();
    let mut session = CaptureSession::start(Source::TestPattern { width: 2560, height: 1440 }, cfg, sink).expect("start");

    // 1. two seconds at 60 fps: ids 1, 2, 3 …, the first one key, nothing repeated (the pattern moves)
    std::thread::sleep(Duration::from_millis(2100));
    let frames = since(&seen, 0);
    let first = frames.iter().position(|f| f.at_us >= frames[0].at_us + 50_000).unwrap();
    let last = frames.iter().rposition(|f| f.at_us <= frames[first].at_us + 2_000_000).unwrap();
    let rate = (last - first) as f64 / ((frames[last].at_us - frames[first].at_us) as f64 / 1e6);
    let mean_latency = frames.iter().map(|f| f.latency_us).sum::<u64>() as f64 / frames.len() as f64 / 1000.0;
    let stats = session.stats();
    eprintln!(
        "{} 2560x1440@60: {} frames, {rate:.1} fps, capture→encoded mean {mean_latency:.2} ms; stats {stats:?}",
        codec.name(),
        frames.len()
    );
    assert!(frames[0].key && frames[0].id == 1);
    assert!(frames.windows(2).all(|w| w[1].id == w[0].id + 1), "frame ids count up by one");
    assert!(frames[1..].iter().all(|f| !f.key && !f.repeat));
    assert!((57.0..=61.0).contains(&rate), "{rate:.1} fps for a 60 fps session");
    assert!(frames.iter().all(|f| (f.width, f.height) == (2560, 1440)));
    // the encoder keeps up with 60 fps (release builds measure ~5 ms here on an RTX 4080)
    assert!(mean_latency < 1000.0 / 60.0, "capture → encoded {mean_latency:.2} ms");
    assert_eq!((stats.width, stats.height, stats.fps), (2560, 1440, 60));
    assert_eq!(stats.encoder, "NVENC");
    assert_eq!(stats.target_kbps, st_media::net::rate::lan_bitrate_kbps(2560, 1440, 60, codec));
    assert!((55.0..=62.0).contains(&stats.encode_fps), "{stats:?}");
    assert!((55.0..=62.0).contains(&stats.capture_fps), "{stats:?}");

    // 2. a key frame request: the next frame or the one after is an IDR
    let n = count(&seen);
    session.request(EncoderRequest::Keyframe);
    std::thread::sleep(Duration::from_millis(100));
    let after = since(&seen, n);
    assert!(after.iter().take(2).any(|f| f.key), "key frame on request: {after:?}");
    assert_eq!(after.iter().filter(|f| f.key).count(), 1);

    // 3. back-off: a lower rate without an IDR; never above the target
    let target = stats.target_kbps;
    let n = count(&seen);
    let handle = session.request_handle();
    handle(EncoderRequest::Bitrate { kbps: target / 2 });
    std::thread::sleep(Duration::from_millis(1100));
    assert!(since(&seen, n).iter().all(|f| !f.key));
    assert_eq!(session.stats().bitrate_kbps, target / 2);
    handle(EncoderRequest::Bitrate { kbps: target * 2 });
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(session.stats().bitrate_kbps, target, "never above the target");

    // 4. invalidation: inside the DPB → an after-invalidation frame (or an IDR where the GPU cannot)
    let n = count(&seen);
    let newest = since(&seen, 0).last().unwrap().id;
    session.request(EncoderRequest::InvalidateRefs { first: newest, last: newest });
    std::thread::sleep(Duration::from_millis(100));
    let after = since(&seen, n);
    assert!(after.iter().take(2).any(|f| f.after_invalidation || f.key), "{after:?}");

    // 5. static picture: repeats at the full rate, marked as such
    session.pause_pattern(true);
    std::thread::sleep(Duration::from_millis(100));
    let n = count(&seen);
    std::thread::sleep(Duration::from_millis(1000));
    let still = since(&seen, n);
    eprintln!("static: {} repeats in 1 s, {} B mean", still.len(), still.iter().map(|f| f.bytes).sum::<usize>() / still.len().max(1));
    assert!(still.iter().all(|f| f.repeat), "only repeats while the picture stands still");
    assert!((50..=62).contains(&still.len()), "{} repeats in 1 s", still.len());
    let n = count(&seen);
    session.request(EncoderRequest::Keyframe);
    std::thread::sleep(Duration::from_millis(100));
    assert!(since(&seen, n).iter().any(|f| f.key && f.repeat), "an IDR comes even while static");
    session.pause_pattern(false);
    std::thread::sleep(Duration::from_millis(100));
    assert!(!since(&seen, count(&seen) - 1)[0].repeat);

    // 6. the user picks 30 fps and 720p: new size with an IDR, then 30 fps
    session.reconfigure(30, 720).expect("reconfigure");
    std::thread::sleep(Duration::from_millis(100));
    let n = count(&seen);
    std::thread::sleep(Duration::from_millis(1000));
    let after = since(&seen, n);
    let stats = session.stats();
    eprintln!("after reconfigure: {} frames in 1 s, {stats:?}", after.len());
    assert!(after.iter().all(|f| (f.width, f.height) == (1280, 720)));
    assert!((28..=32).contains(&after.len()), "{} frames in 1 s at 30 fps", after.len());
    assert_eq!(stats.target_kbps, st_media::net::rate::lan_bitrate_kbps(1280, 720, 30, codec));
    assert!(since(&seen, 0).iter().any(|f| f.key && f.width == 1280), "the new size starts with an IDR");

    // 7. a bitrate set by hand: the target is that value and back-off requests are ignored
    session.set_target(5_000);
    std::thread::sleep(Duration::from_millis(50));
    handle(EncoderRequest::Bitrate { kbps: 2_000 });
    std::thread::sleep(Duration::from_millis(50));
    let stats = session.stats();
    assert_eq!((stats.target_kbps, stats.bitrate_kbps), (5_000, 5_000));

    session.stop();
    let n = count(&seen);
    handle(EncoderRequest::Keyframe); // after stop: nothing happens
    session.stop();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(count(&seen), n);
}

#[test]
fn bad_sources_fail_cleanly() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() {
        return;
    }
    let cfg = CaptureConfig { codec: Codec::H264, fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
    let (_, sink) = collect();
    // an HWND that does not exist: no window opened, no screen touched
    assert!(CaptureSession::start(Source::Window(0x7fff_fff0), cfg, sink).is_err());
    let (_, sink) = collect();
    assert!(CaptureSession::start(Source::TestPattern { width: 2560, height: 1440 }, CaptureConfig { fps: 0, ..cfg }, sink).is_err());
}

/// The user picks another source: a new size, starting with an IDR, frame ids continuing.
#[test]
fn set_source_switches_size() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() {
        return;
    }
    let cfg = CaptureConfig { codec: codec_for_this_gpu(), fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
    let (seen, sink) = collect();
    let session = CaptureSession::start(Source::TestPattern { width: 1280, height: 720 }, cfg, sink).expect("start");
    std::thread::sleep(Duration::from_millis(300));
    let n = count(&seen);
    session.set_source(Source::TestPattern { width: 1920, height: 1080 }).expect("set_source");
    std::thread::sleep(Duration::from_millis(300));
    let all = since(&seen, 0);
    let switched = all.iter().position(|f| f.width == 1920).expect("frames at the new size");
    assert!(switched + 1 >= n);
    assert!(all[switched].key, "the new source starts with an IDR");
    assert!(all[switched..].iter().all(|f| (f.width, f.height) == (1920, 1080)));
    assert!(all.windows(2).all(|w| w[1].id == w[0].id + 1), "frame ids continue across the switch");
    assert_eq!(session.stats().target_kbps, st_media::net::rate::lan_bitrate_kbps(1920, 1080, 60, cfg.codec));
}

/// One share watched in both codecs runs two sessions side by side (as nm_share_add does), each at full rate.
#[test]
fn two_codecs_side_by_side() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() || !probe().h264 || !probe().hevc {
        return;
    }
    let mut sessions = Vec::new();
    for codec in [Codec::H264, Codec::Hevc] {
        let cfg = CaptureConfig { codec, fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
        let (seen, sink) = collect();
        let s = CaptureSession::start(Source::TestPattern { width: 2560, height: 1440 }, cfg, sink).expect("start");
        sessions.push((s, seen));
    }
    std::thread::sleep(Duration::from_millis(1300));
    for (s, seen) in &sessions {
        let stats = s.stats();
        eprintln!("{}: {} frames, {:.1} fps, capture→encoded {:.2} ms", stats.codec, count(seen), stats.encode_fps, stats.encode_ms);
        assert!((55.0..=62.0).contains(&stats.encode_fps), "{stats:?}");
    }
}

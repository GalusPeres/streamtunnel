//! NVENC on the real GPU with synthetic frames (docs/NATIVE-PATH.md §12, WIN): TestPattern → Converter → Encoder.
//! Never captures the screen. Skips (passes with a note) without an NVIDIA GPU; `ST_REQUIRE_NVENC=1` makes a
//! missing NVENC a failure. `ST_WRITE_FIXTURES=1` also rewrites `tests/fixtures/` (receiver test input).
//! Run: cargo test --manifest-path src-tauri/st-media/Cargo.toml --target-dir src-tauri/target --test win_nvenc -- --nocapture
#![cfg(windows)]

mod win_common;

use std::time::Instant;

use st_media::net::rate::lan_bitrate_kbps;
use st_media::win::d3d::{Converter, Gpu, TestPattern};
use st_media::win::nvenc::{Encoder, EncoderConfig, EncodedOutput, INPUT_SLOTS};
use st_media::Codec;
use win_common::{check_au, gpu_lock, nvenc_gpu};

fn test_codec(c: Codec) -> win_common::Codec {
    match c {
        Codec::H264 => win_common::Codec::H264,
        Codec::Hevc => win_common::Codec::Hevc,
    }
}

/// Pattern → NV12 slot → NVENC, `n` frames; `each(i, encoder)` runs before frame i (requests). Returns the access
/// units and the mean / max time of convert + encode (ms).
fn encode_frames(
    gpu: &Gpu,
    cfg: &EncoderConfig,
    n: u32,
    mut each: impl FnMut(u32, &mut Encoder) -> bool,
) -> (Vec<EncodedOutput>, f64, f64) {
    let mut pattern = TestPattern::new(gpu, cfg.width, cfg.height).expect("pattern");
    let mut conv = Converter::new(gpu, cfg.width, cfg.height, cfg.width, cfg.height).expect("converter");
    let mut enc = Encoder::open(gpu, cfg).expect("encoder");
    let mut out = Vec::new();
    let (mut total, mut max) = (0.0f64, 0.0f64);
    for i in 0..n {
        let idr = each(i, &mut enc);
        let slot = i as usize % INPUT_SLOTS;
        let t = Instant::now();
        let frame = pattern.next().expect("pattern frame");
        conv.convert(&frame, enc.input(slot)).expect("convert");
        let au = enc.encode(slot, i + 1, idr).expect("encode");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        // the first frames include driver warm-up
        if i >= 5 {
            total += ms;
            max = max.max(ms);
        }
        out.push(au);
    }
    (out, total / (n - 5) as f64, max)
}

/// 2 s of 1440p60 per codec: parameter sets + IDR first, P frames after (no B), forced IDR and a bitrate change
/// honoured, the rate near the CBR target, and each frame encoded well inside one frame time.
#[test]
fn encodes_1440p60_both_codecs() {
    let _gpu_lock = gpu_lock();
    let Some(gpu) = nvenc_gpu() else { return };
    let caps = st_media::win::nvenc::query(&gpu).expect("query");
    eprintln!("{}: h264 {} hevc {} max {}x{}", gpu.name, caps.h264, caps.hevc, caps.max_width, caps.max_height);
    for codec in [Codec::H264, Codec::Hevc] {
        if (codec == Codec::H264 && !caps.h264) || (codec == Codec::Hevc && !caps.hevc) {
            eprintln!("{}: not offered by this GPU", codec.name());
            continue;
        }
        let (w, h, fps) = (2560, 1440, 60);
        let kbps = lan_bitrate_kbps(w, h, fps, codec);
        let cfg = EncoderConfig { codec, width: w, height: h, fps, bitrate_kbps: kbps, vbv_frames: 2.0 };
        let n = 120;
        let (aus, mean_ms, max_ms) = encode_frames(&gpu, &cfg, n, |i, enc| {
            if i == 80 {
                enc.set_bitrate(kbps / 2).expect("set_bitrate");
            }
            i == 60
        });
        let tc = test_codec(codec);
        let mut bytes = 0usize;
        for (i, au) in aus.iter().enumerate() {
            let (key, slice) = check_au(tc, &au.data).unwrap_or_else(|e| panic!("{} frame {i}: {e}", codec.name()));
            assert_eq!(key, au.key, "{} frame {i}: key flag matches the bitstream", codec.name());
            assert_ne!(slice, 'B', "{} frame {i}: B slice", codec.name());
            assert_eq!(au.frame_id, i as u32 + 1);
            assert!(!au.after_invalidation);
            let expect_key = i == 0 || i == 60;
            assert_eq!(au.key, expect_key, "{} frame {i}: key {} (forced only at 0 and 60)", codec.name(), au.key);
            if i < 60 {
                bytes += au.data.len();
            }
        }
        // frames 1..60 at the full target (frame 0 is the IDR, frame 60 the next one)
        let kbps_seen = (bytes - aus[0].data.len()) as f64 * 8.0 / (59.0 / fps as f64) / 1000.0;
        let after = aus[81..].iter().map(|a| a.data.len()).sum::<usize>() as f64 * 8.0 / ((n - 81) as f64 / fps as f64) / 1000.0;
        eprintln!(
            "{} {w}x{h}@{fps}: target {kbps} kbit/s, seen {kbps_seen:.0}; after halving {after:.0}; IDR {} KB, P avg {} KB; \
             convert+encode mean {mean_ms:.2} ms, max {max_ms:.2} ms",
            codec.name(),
            aus[0].data.len() / 1024,
            bytes / 1024 / 60,
        );
        assert!(kbps_seen > kbps as f64 * 0.5 && kbps_seen < kbps as f64 * 1.3, "{}: {kbps_seen:.0} kbit/s for a {kbps} target", codec.name());
        assert!(after < kbps_seen * 0.75, "{}: halving the rate shows ({after:.0} vs {kbps_seen:.0})", codec.name());
        assert!(mean_ms < 1000.0 / fps as f64 / 2.0, "{}: encode {mean_ms:.2} ms is too slow for {fps} fps", codec.name());
    }
}

/// A lost range inside the DPB is invalidated (the next frame is marked after-invalidation, not an IDR); a range
/// older than the DPB is refused (the caller sends an IDR).
#[test]
fn invalidation_inside_dpb() {
    let _gpu_lock = gpu_lock();
    let Some(gpu) = nvenc_gpu() else { return };
    let cfg = EncoderConfig { codec: Codec::Hevc, width: 1280, height: 720, fps: 60, bitrate_kbps: 8_000, vbv_frames: 2.0 };
    let mut supported = false;
    let mut refused_old = false;
    let (aus, _, _) = encode_frames(&gpu, &cfg, 30, |i, enc| {
        if i == 20 {
            supported = enc.supports_invalidation();
            // frames 19 and 20 (ids) were lost; 18 is still a reference
            let ok = enc.invalidate(19, 20).expect("invalidate");
            assert_eq!(ok, supported);
            refused_old = !enc.invalidate(2, 3).expect("invalidate old");
        }
        false
    });
    assert!(refused_old, "a range older than the DPB must be refused");
    if !supported {
        eprintln!("skipped: this GPU cannot invalidate references");
        return;
    }
    let tc = test_codec(cfg.codec);
    assert!(aus[20].after_invalidation && !aus[20].key);
    assert!(aus[21..].iter().all(|a| !a.after_invalidation && !a.key));
    for au in &aus {
        check_au(tc, &au.data).expect("valid access unit");
    }
}

/// An intra refresh wave on request: no IDR, P frames stay P (the wave is spread over several frames).
#[test]
fn intra_refresh_on_request() {
    let _gpu_lock = gpu_lock();
    let Some(gpu) = nvenc_gpu() else { return };
    for codec in [Codec::H264, Codec::Hevc] {
        let cfg = EncoderConfig { codec, width: 1280, height: 720, fps: 60, bitrate_kbps: 8_000, vbv_frames: 2.0 };
        let mut started = false;
        let (aus, _, _) = encode_frames(&gpu, &cfg, 40, |i, enc| {
            if i == 20 {
                started = enc.intra_refresh().expect("intra refresh");
            }
            false
        });
        let tc = test_codec(codec);
        for (i, au) in aus.iter().enumerate() {
            let (key, slice) = check_au(tc, &au.data).expect("valid access unit");
            assert_eq!(key, i == 0, "{} frame {i}", codec.name());
            assert_ne!(slice, 'B');
        }
        let p_avg = aus[10..20].iter().map(|a| a.data.len()).sum::<usize>() / 10;
        let wave_avg = aus[20..30].iter().map(|a| a.data.len()).sum::<usize>() / 10;
        eprintln!("{}: intra refresh {started}; P avg {p_avg} B, during the wave {wave_avg} B, IDR {} B", codec.name(), aus[0].data.len());
    }
}

/// Writes the receiver fixtures (`ST_WRITE_FIXTURES=1`): 2 s of 720p30 test pattern per codec, 2 Mbit/s, with an
/// index of access units. Small enough to commit (< 2 MB together).
#[test]
fn write_fixtures() {
    if std::env::var("ST_WRITE_FIXTURES").as_deref() != Ok("1") {
        return;
    }
    let _gpu_lock = gpu_lock();
    let Some(gpu) = nvenc_gpu() else { return };
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures");
    std::fs::create_dir_all(&dir).expect("fixtures dir");
    for (codec, ext) in [(Codec::H264, "h264"), (Codec::Hevc, "hevc")] {
        let cfg = EncoderConfig { codec, width: 1280, height: 720, fps: 30, bitrate_kbps: 2_000, vbv_frames: 2.0 };
        // an IDR in the middle too (a receiver test can start there)
        let (aus, _, _) = encode_frames(&gpu, &cfg, 60, |i, _| i == 30);
        let mut stream = Vec::new();
        let mut index = String::from("# offset length key (one access unit per line; 1280x720, 30 fps, 2 Mbit/s CBR, test pattern)\n");
        for au in &aus {
            index.push_str(&format!("{} {} {}\n", stream.len(), au.data.len(), au.key as u8));
            stream.extend_from_slice(&au.data);
        }
        std::fs::write(dir.join(format!("pattern_720p30.{ext}")), &stream).expect("write stream");
        std::fs::write(dir.join(format!("pattern_720p30.{ext}.idx")), index).expect("write index");
        eprintln!("{ext}: {} bytes", stream.len());
    }
}

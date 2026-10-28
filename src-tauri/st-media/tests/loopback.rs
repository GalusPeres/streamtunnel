//! Two endpoints in one process over 127.0.0.1 (docs/NATIVE-PATH.md §12, NET): link setup through the same
//! calls the glue makes, then synthetic access units through a lossy shim. Never touches the screen or a GPU.
//! Run: cargo test --manifest-path src-tauri/st-media/Cargo.toml --target-dir src-tauri/target
//! (add `-- --nocapture` to see the measured latencies).
//!
//! The shim is a UDP relay between the two endpoints. It knows the link keys (derived from the public key halves
//! and link ids, exactly as the endpoints do), so it can open every datagram it forwards or drops: the test knows
//! for each frame how many of its shards were lost and checks the receiver against that.

use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver as Rx};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use st_media::clock::now_us;
use st_media::net::crypto::{derive_link_keys, Opener};
use st_media::net::ctrl::{self, ByeReason, Ctrl};
use st_media::net::ice::{self, Candidate, CandidateKind};
use st_media::net::link::{Endpoint, EndpointConfig, Link, LinkEvent, LinkSink};
use st_media::net::wire::{Header, Kind, VideoShard};
use st_media::recv::{Receiver, RecvEvent};
use st_media::send::{Sender, SenderConfig, ViewerCaps};
use st_media::{AudioChunk, Codec, EncodedFrame, EncoderRequest, Role, AUDIO_CHANNELS, AUDIO_PACKET_FRAMES};

// ───────────────────────── helpers ─────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, p: f64) -> bool {
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p
    }
}

fn frame_bytes(id: u32, len: usize) -> Vec<u8> {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15 ^ ((id as u64) << 20 | 1));
    (0..len).map(|_| r.next() as u8).collect()
}

fn sink() -> (LinkSink, Rx<LinkEvent>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |e| drop(tx.lock().unwrap().send(e))), rx)
}

/// Waits for `Up` (panics on `Failed` / timeout); other events are kept in `seen`.
fn wait_up(rx: &Rx<LinkEvent>, within: Duration, seen: &mut Vec<LinkEvent>) -> st_media::PathInfo {
    let end = std::time::Instant::now() + within;
    loop {
        let left = end.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(LinkEvent::Up(p)) => return p,
            Ok(LinkEvent::Failed(r)) => panic!("link failed: {r}"),
            Ok(e) => seen.push(e),
            Err(_) => panic!("no Up within {within:?}"),
        }
    }
}

/// Collects events until `pred` matches one (returned) or the time is up (None).
fn wait_for(rx: &Rx<LinkEvent>, within: Duration, seen: &mut Vec<LinkEvent>, pred: impl Fn(&LinkEvent) -> bool) -> Option<LinkEvent> {
    let end = std::time::Instant::now() + within;
    loop {
        let left = end.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(e) if pred(&e) => return Some(e),
            Ok(e) => seen.push(e),
            Err(_) => return None,
        }
    }
}

fn loopback() -> Arc<Endpoint> {
    Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).expect("bind 127.0.0.1")
}

fn host(addr: SocketAddr) -> Candidate {
    Candidate { addr, kind: CandidateKind::Host }
}

fn percentile(v: &mut [u64], p: f64) -> u64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[((v.len() - 1) as f64 * p).round() as usize]
}

// ───────────────────────── lossy shim ─────────────────────────

#[derive(Clone, Copy, Debug)]
enum Loss {
    None,
    /// every datagram independently
    Random(f64),
    /// Gilbert model: enter a loss burst with `enter`, leave it with `leave` per datagram
    Burst { enter: f64, leave: f64 },
}

#[derive(Default)]
struct ShimLog {
    forwarded: u64,
    dropped: u64,
    /// video frames the sharer sent: id → (data shards, parity shards, key)
    frames: HashMap<u32, (u16, u16, bool)>,
    /// video shards dropped per frame id
    video_dropped: HashMap<u32, u32>,
    /// FrameLost ranges and Keyframe requests the viewer sent (seen before the drop decision)
    frame_lost: Vec<(u32, u32)>,
    keyframe_requests: u32,
}

/// UDP relay with loss. The viewer sends to `to_sharer`, the sharer to `to_viewer`; each side sees the other at
/// the shim's address, as a peer behind a lossy network would look.
struct Shim {
    to_sharer: SocketAddr,
    to_viewer: SocketAddr,
    log: Arc<Mutex<ShimLog>>,
    stop: Arc<AtomicBool>,
    /// drop everything (a dead network)
    blackhole: Arc<AtomicBool>,
    /// drop nothing any more (the end of a run: Byes and tail frames must not depend on luck)
    calm: Arc<AtomicBool>,
}

impl Shim {
    fn start(sharer: SocketAddr, viewer: SocketAddr, s2v: [u8; 32], v2s: [u8; 32], loss: Loss, seed: u64) -> Shim {
        let a = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap()); // faces the viewer
        let b = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap()); // faces the sharer
        for s in [&a, &b] {
            let r = socket2::SockRef::from(s.as_ref());
            r.set_recv_buffer_size(8 << 20).unwrap();
            r.set_send_buffer_size(8 << 20).unwrap();
            s.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        }
        let shim = Shim {
            to_sharer: a.local_addr().unwrap(),
            to_viewer: b.local_addr().unwrap(),
            log: Arc::new(Mutex::new(ShimLog::default())),
            stop: Arc::new(AtomicBool::new(false)),
            blackhole: Arc::new(AtomicBool::new(false)),
            calm: Arc::new(AtomicBool::new(false)),
        };
        // viewer → sharer: in on `a`, out of `b`; sharer → viewer: in on `b`, out of `a`
        for (rx, tx, dest, key, upstream, seed) in [(a.clone(), b.clone(), sharer, v2s, true, seed), (b, a, viewer, s2v, false, seed ^ 0x55)] {
            let (log, stop, blackhole, calm) = (shim.log.clone(), shim.stop.clone(), shim.blackhole.clone(), shim.calm.clone());
            std::thread::spawn(move || {
                let mut opener = Opener::new(key);
                let mut rng = Rng(seed | 1);
                let mut bad = false;
                let mut buf = vec![0u8; 2048];
                let mut plain = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    let Ok((n, _)) = rx.recv_from(&mut buf) else { continue };
                    let d = &buf[..n];
                    let lose = blackhole.load(Ordering::Relaxed)
                        || !calm.load(Ordering::Relaxed) && match loss {
                            Loss::None => false,
                            Loss::Random(p) => rng.chance(p),
                            Loss::Burst { enter, leave } => {
                                bad = if bad { !rng.chance(leave) } else { rng.chance(enter) };
                                bad
                            }
                        };
                    // forward first (the shim adds no delay of its own), then look inside: only video shards
                    // towards the viewer and ctrl towards the sharer are opened
                    if !lose {
                        let _ = tx.send_to(d, dest);
                    }
                    let kind = Header::decode(d).map(|h| h.kind);
                    let mut log = log.lock().unwrap();
                    if lose {
                        log.dropped += 1;
                    } else {
                        log.forwarded += 1;
                    }
                    let watched = matches!((kind, upstream), (Some(Kind::Video), false) | (Some(Kind::Ctrl), true));
                    if !watched || opener.open(d, &mut plain).is_err() {
                        continue;
                    }
                    if !upstream {
                        let s = VideoShard::parse(&plain).expect("valid shard");
                        log.frames.insert(s.frame_id, (s.data_shards, s.parity_shards, s.flags & 1 != 0));
                        if lose {
                            *log.video_dropped.entry(s.frame_id).or_default() += 1;
                        }
                    } else {
                        match ctrl::decode(&plain) {
                            Some((Ctrl::FrameLost { first, last }, _)) => log.frame_lost.push((first, last)),
                            Some((Ctrl::Keyframe, _)) => log.keyframe_requests += 1,
                            _ => {}
                        }
                    }
                }
            });
        }
        shim
    }
}

impl Drop for Shim {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

// ───────────────────────── the setup the glue does ─────────────────────────

/// A sharer and a viewer endpoint with one link through a shim: what nm_link_open / nm_share_add /
/// nm_link_remote do, in that order. Media handlers are attached before the links are up, as in the app.
struct Pair {
    _sharer_ep: Arc<Endpoint>,
    _viewer_ep: Arc<Endpoint>,
    sl: Arc<Link>,
    vl: Arc<Link>,
    s_events: Rx<LinkEvent>,
    v_events: Rx<LinkEvent>,
    shim: Shim,
    sender: Arc<Sender>,
    receiver: Arc<Receiver>,
    /// (delivery time on our clock, event)
    delivered: Rx<(u64, RecvEvent)>,
    requests: Arc<Mutex<Vec<(u64, EncoderRequest)>>>,
    force_key: Arc<AtomicBool>,
    setup_us: u64,
}

fn pair(loss: Loss, seed: u64, wrong_key: bool) -> Pair {
    let (se, ve) = (loopback(), loopback());
    let (ssink, s_events) = sink();
    let (vsink, v_events) = sink();
    let sl = se.create_link(Role::Share, ssink).unwrap();
    let vl = ve.create_link(Role::Watch, vsink).unwrap();
    assert_eq!(sl.local_candidates(), vec![host(SocketAddr::from(([127, 0, 0, 1], se.port())))]);
    let keys = derive_link_keys(Role::Share, &sl.key_half(), &vl.key_half(), sl.id(), vl.id());
    let shim = Shim::start(SocketAddr::from(([127, 0, 0, 1], se.port())), SocketAddr::from(([127, 0, 0, 1], ve.port())), keys.tx, keys.rx, loss, seed);

    let requests = Arc::new(Mutex::new(Vec::new()));
    let force_key = Arc::new(AtomicBool::new(false));
    let (reqs, force) = (requests.clone(), force_key.clone());
    let sender = Sender::new(
        SenderConfig { codec: Codec::Hevc, target_kbps: 20_000, fixed: true },
        Arc::new(move |r| {
            if r == EncoderRequest::Keyframe {
                force.store(true, Ordering::Relaxed);
            }
            reqs.lock().unwrap().push((now_us(), r));
        }),
    );
    let (dtx, delivered) = channel();
    let dtx = Mutex::new(dtx);
    let receiver = Receiver::attach(&vl, Arc::new(move |e| drop(dtx.lock().unwrap().send((now_us(), e)))));
    sender.add_link(&sl, ViewerCaps { rfi: false });

    let t0 = now_us();
    let viewer_key = if wrong_key { st_media::net::crypto::random_key_half() } else { vl.key_half() };
    sl.set_remote(vl.id(), viewer_key, &[host(shim.to_viewer)]).unwrap();
    vl.set_remote(sl.id(), sl.key_half(), &[host(shim.to_sharer)]).unwrap();
    assert!(vl.set_remote(sl.id(), sl.key_half(), &[]).is_err(), "set_remote twice");
    Pair { _sharer_ep: se, _viewer_ep: ve, sl, vl, s_events, v_events, shim, sender, receiver, delivered, requests, force_key, setup_us: t0 }
}

// ───────────────────────── tests ─────────────────────────

struct RunResult {
    lost_frames: usize,
    /// frames dropped at the sharer because its link queue was full
    at_sharer: usize,
}

/// The streaming runs take turns: in a debug build AES-GCM and Reed-Solomon are unoptimized, and four streams at
/// once (each datagram is opened twice, by the shim and by the viewer) would measure the CPU, not the transport.
static STREAMS: Mutex<()> = Mutex::new(());

/// 300 frames at 60 fps (1 B … 200 KB, the first a key frame), share sound and App messages in both directions
/// through the shim; afterwards every frame is checked against what the shim dropped.
fn stream_under_loss(name: &str, loss: Loss, seed: u64) -> RunResult {
    const FRAMES: u32 = 300;
    /// small frames through a calm shim after the measured ones (≈ 330 ms, longer than the key frame hold), so
    /// every loss among the measured frames is declared and answered with a key frame before the run ends
    const TAIL: u32 = 20;
    const FRAME_GAP_US: u64 = 16_667;
    let _turn = STREAMS.lock().unwrap_or_else(|e| e.into_inner());
    let p = pair(loss, seed, false);
    let (mut s_seen, mut v_seen) = (Vec::new(), Vec::new());
    let up_s = wait_up(&p.s_events, Duration::from_millis(ice::DEADLINE_MS), &mut s_seen);
    let up_v = wait_up(&p.v_events, Duration::from_millis(ice::DEADLINE_MS), &mut v_seen);
    let setup_ms = (now_us() - p.setup_us) as f64 / 1000.0;
    assert!(up_s.lan && up_v.lan, "loopback counts as LAN");
    assert_eq!(up_v.remote, p.shim.to_sharer);
    assert_eq!(up_s.remote, p.shim.to_viewer);

    // share sound: 5 ms chunks on their own thread, sample value = seq (never 0, so silence is recognizable)
    let audio_run = Arc::new(AtomicBool::new(true));
    let audio = {
        let (sender, run) = (p.sender.clone(), audio_run.clone());
        std::thread::spawn(move || {
            let mut seq = 0u32;
            let start = now_us();
            while run.load(Ordering::Relaxed) {
                let v = (seq % 30_000 + 1) as i16;
                sender.push_audio(&AudioChunk { seq, capture_us: now_us(), pcm: vec![v; AUDIO_PACKET_FRAMES * AUDIO_CHANNELS] });
                seq += 1;
                let due = start + seq as u64 * 5_000;
                std::thread::sleep(Duration::from_micros(due.saturating_sub(now_us())));
            }
            seq
        })
    };

    let mut rng = Rng(seed ^ 0xabcdef);
    let mut sent: HashMap<u32, (Vec<u8>, u64, bool)> = HashMap::new();
    let mut next_at = now_us();
    for id in 1..=FRAMES + TAIL {
        if id == FRAMES + 1 {
            std::thread::sleep(Duration::from_millis(50));
            p.shim.calm.store(true, Ordering::Relaxed);
            next_at = now_us();
        }
        let forced = p.force_key.swap(false, Ordering::Relaxed); // the encoder honours a Keyframe request
        let key = id == 1 || forced;
        let len = if id > FRAMES {
            1 + rng.below(3_000) as usize
        } else if key {
            120_000 + rng.below(80_000) as usize
        } else if id % 50 == 0 {
            1
        } else {
            1 + rng.below(60_000) as usize
        };
        let data = frame_bytes(id, len);
        let capture_us = now_us();
        let frame = EncodedFrame {
            frame_id: id,
            codec: Codec::Hevc,
            key,
            after_invalidation: false,
            repeat: false,
            data: data.clone(),
            capture_us,
            encoded_us: capture_us + 1_500,
            width: 1920,
            height: 1080,
        };
        // latency is measured from here: sharding + FEC on the sharer included
        p.sender.push_frame(&frame);
        sent.insert(id, (data, capture_us, key));
        if id % 15 == 0 && id <= FRAMES {
            p.sl.send_message(&format!("{{\"t\":\"tx\",\"n\":{id}}}")).unwrap();
            p.vl.send_message(&format!("{{\"t\":\"rx\",\"n\":{id}}}")).unwrap();
        }
        // like an encoder: one frame per frame time; after a stall the next one comes half a frame time later,
        // never a burst of catch-up frames
        next_at = (next_at + FRAME_GAP_US).max(now_us() + FRAME_GAP_US / 2);
        std::thread::sleep(Duration::from_micros(next_at.saturating_sub(now_us())));
    }
    std::thread::sleep(Duration::from_millis(100));
    audio_run.store(false, Ordering::Relaxed);
    let audio_sent = audio.join().unwrap();

    // ── what arrived (until nothing more comes for half a second) ──
    let mut frames = Vec::new();
    let mut blocks = Vec::new();
    let give_up = now_us() + 20_000_000;
    while let Ok((t, e)) = p.delivered.recv_timeout(Duration::from_millis(500)) {
        match e {
            RecvEvent::Video(au) => frames.push((t, au)),
            RecvEvent::Audio(b) => blocks.push(b),
        }
        assert!(now_us() < give_up, "the receiver never went quiet");
    }
    let delivered: HashSet<u32> = frames.iter().map(|(_, au)| au.frame_id).collect();
    let rs = p.receiver.stats();
    let ss = p.sender.stats();
    let ls = p.sl.stats();
    let requests = p.requests.lock().unwrap().clone();
    let log = std::mem::take(&mut *p.shim.log.lock().unwrap());

    // What the receiver must have done, frame by frame, given what the shim dropped: a frame that lost no more
    // shards than it had parity is delivered unless it waits behind an earlier unrecoverable frame for the next
    // key frame. A frame the shim never saw was dropped at the sharer (its link queue was full) and counts as lost
    // like one the network ate.
    #[derive(Debug, PartialEq)]
    enum Fate {
        Delivered,
        Lost,
        HeldBack,
    }
    let mut fate: Vec<(u32, Fate)> = Vec::new();
    let (mut blocked, mut recoverable_hits, mut at_sharer) = (false, 0, 0);
    for id in 1..=FRAMES + TAIL {
        match log.frames.get(&id) {
            None => {
                at_sharer += 1;
                fate.push((id, Fate::Lost));
                blocked = true;
            }
            Some(&(k, m, key)) => {
                assert!((k as u32) < 800 && m >= 2, "frame {id}: k {k} m {m}");
                let dropped = log.video_dropped.get(&id).copied().unwrap_or(0);
                if dropped > m as u32 {
                    fate.push((id, Fate::Lost));
                    blocked = true;
                } else if key || !blocked {
                    blocked = false;
                    recoverable_hits += u32::from(dropped > 0);
                    fate.push((id, Fate::Delivered));
                } else {
                    fate.push((id, Fate::HeldBack));
                }
            }
        }
    }
    let lost: Vec<u32> = fate.iter().filter(|f| f.1 == Fate::Lost).map(|f| f.0).collect();
    let held_back = fate.iter().filter(|f| f.1 == Fate::HeldBack).count();
    let key_requests = requests.iter().filter(|r| r.1 == EncoderRequest::Keyframe).count();

    // audio: every block is whole, real slots carry their packet, missing ones are silence
    let samples = AUDIO_PACKET_FRAMES * AUDIO_CHANNELS;
    let mut concealed = 0;
    for b in &blocks {
        assert_eq!(b.pcm.len(), 4 * samples);
        let mut silent = 0;
        for (i, slot) in b.pcm.chunks(samples).enumerate() {
            let want = ((b.seq + i as u32) % 30_000 + 1) as i16;
            if slot.iter().all(|s| *s == 0) {
                silent += 1;
            } else {
                assert!(slot.iter().all(|s| *s == want), "audio block {} slot {i}", b.seq);
            }
        }
        assert_eq!(silent, b.concealed);
        concealed += silent as u32;
    }
    let audio_got = blocks.len() as u32 * 4 - concealed;

    // ── report (before the checks, so a failing run still shows its numbers) ──
    let (mut lat_key, mut lat_delta, mut ages) = (Vec::new(), Vec::new(), Vec::new());
    for (t, au) in &frames {
        let l = t.saturating_sub(sent[&au.frame_id].1);
        if au.key {
            lat_key.push(l);
        } else {
            lat_delta.push(l);
        }
        if au.age_us > 0 {
            ages.push(au.age_us as u64);
        }
    }
    let mut all: Vec<u64> = lat_key.iter().chain(lat_delta.iter()).copied().collect();
    println!(
        "[{name}] setup {setup_ms:.1} ms | datagrams {} forwarded, {} dropped ({:.2} %) | frames {} pushed, {} delivered, \
         {} FEC-recovered ({} hit by loss ≤ parity), {} lost ({} dropped at the sharer), {} held back for a key frame | \
         key frames requested {key_requests} (viewer asked {} times) | audio {audio_got}/{audio_sent} packets, {concealed} \
         concealed\n[{name}] sender {ss:?}\n[{name}] sharer link {ls:?}\n[{name}] receiver {rs:?}",
        log.forwarded,
        log.dropped,
        log.dropped as f64 * 100.0 / (log.forwarded + log.dropped).max(1) as f64,
        FRAMES + TAIL,
        frames.len(),
        rs.frames_recovered,
        recoverable_hits,
        lost.len(),
        at_sharer,
        held_back,
        log.keyframe_requests,
    );
    println!(
        "[{name}] latency push → delivered ({} build, µs): all p50 {} p90 {} p99 {} max {} | deltas p50 {} | key \
         frames (120–200 KB) p50 {} max {} | capture → hand-over via the clock sync p50 {}",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        percentile(&mut all, 0.5),
        percentile(&mut all, 0.9),
        percentile(&mut all, 0.99),
        all.iter().max().copied().unwrap_or(0),
        percentile(&mut lat_delta, 0.5),
        percentile(&mut lat_key, 0.5),
        lat_key.iter().max().copied().unwrap_or(0),
        percentile(&mut ages, 0.5),
    );

    // ── checks ──
    // delivered frames: in order, intact, flags right
    let mut prev = 0;
    for (_, au) in &frames {
        assert!(au.frame_id > prev, "out of order: {} after {prev}", au.frame_id);
        prev = au.frame_id;
        let (data, _, key) = &sent[&au.frame_id];
        assert_eq!(&au.data, data, "frame {} corrupted", au.frame_id);
        assert_eq!(au.key, *key);
        assert_eq!(au.codec, Codec::Hevc);
    }
    for (id, f) in &fate {
        let got = delivered.contains(id);
        assert_eq!(got, *f == Fate::Delivered, "frame {id}: expected {f:?}, delivered {got} (shim: {:?}, dropped {:?})", log.frames.get(id), log.video_dropped.get(id));
    }
    assert!((FRAMES + 1..=FRAMES + TAIL).all(|id| !log.video_dropped.contains_key(&id)), "the tail goes through a calm shim");
    for &id in &lost {
        // every loss was reported at once …
        assert!(log.frame_lost.iter().any(|&(f, l)| f <= id && id <= l), "lost frame {id} never reported (FrameLost {:?})", log.frame_lost);
        // … and a key frame followed it
        let key_after = log.frames.iter().any(|(&k, f)| k > id && f.2 && delivered.contains(&k));
        assert!(key_after, "no key frame after the loss of frame {id}");
    }
    assert_eq!(rs.frames_lost as usize, lost.len(), "receiver's lost count");
    assert_eq!(rs.frames_dropped, 0, "the test's sink is never too slow");
    assert_eq!(rs.frames as usize, frames.len());
    assert!(requests.iter().all(|r| !matches!(r.1, EncoderRequest::Bitrate { .. })), "a fixed bitrate never changes");
    assert!(blocks.len() as u32 * 4 + 8 >= audio_sent, "audio blocks missing: {} for {audio_sent} packets", blocks.len());

    // App messages: all of them, in order, both ways; then Bye
    p.sl.close(ByeReason::Ended);
    let bye = wait_for(&p.v_events, Duration::from_secs(1), &mut v_seen, |e| matches!(e, LinkEvent::Closed(_)));
    assert!(matches!(&bye, Some(LinkEvent::Closed(r)) if r == "ended"), "viewer got {bye:?}");
    let ours = wait_for(&p.s_events, Duration::from_secs(1), &mut s_seen, |e| matches!(e, LinkEvent::Closed(_)));
    assert!(matches!(&ours, Some(LinkEvent::Closed(r)) if r == "closed"), "sharer got {ours:?}");
    let texts = |seen: &Vec<LinkEvent>| -> Vec<String> {
        seen.iter().filter_map(|e| if let LinkEvent::Message(m) = e { Some(m.clone()) } else { None }).collect()
    };
    let want = |t: &str| -> Vec<String> { (1..=FRAMES).filter(|i| i % 15 == 0).map(|i| format!("{{\"t\":\"{t}\",\"n\":{i}}}")).collect() };
    assert_eq!(texts(&v_seen), want("tx"));
    assert_eq!(texts(&s_seen), want("rx"));
    assert!(v_seen.iter().any(|e| matches!(e, LinkEvent::Stats(_))), "stats once per second");
    p.receiver.close();
    RunResult { lost_frames: lost.len(), at_sharer }
}

/// Sharer + viewer endpoints (`loopback: true`), exchange link ids / key halves / candidates directly (no
/// signaling), expect `LinkEvent::Up` on both within `ice::DEADLINE_MS`, send 300 synthetic frames (1–200 KB,
/// first one key) with 1 % random loss injected: every frame arrives intact or is reported lost and recovered
/// by the next key frame; App messages arrive in order; Bye closes the peer with "bye".
#[test]
fn loopback_link_delivers_frames_under_loss() {
    stream_under_loss("1 % random", Loss::Random(0.01), 1);
}

#[test]
fn loopback_five_percent_random_loss() {
    stream_under_loss("5 % random", Loss::Random(0.05), 2);
}

#[test]
fn loopback_five_percent_burst_loss() {
    // Gilbert model: bursts of 5 datagrams on average, ≈ 4.8 % of all datagrams
    stream_under_loss("5 % bursts", Loss::Burst { enter: 0.01, leave: 0.2 }, 3);
}

#[test]
fn loopback_without_loss_loses_nothing() {
    let r = stream_under_loss("no loss", Loss::None, 4);
    // nothing is lost on the way; a frame can only be dropped at the sharer when its sending thread was stalled
    // for more than two frame times (a fully loaded machine: other builds running next to the tests)
    assert_eq!(r.lost_frames, r.at_sharer);
    if r.at_sharer > 0 {
        println!("[no loss] note: {} frames dropped at the sharer (the machine was busy)", r.at_sharer);
    }
}

/// A viewer whose key half does not match never gets `Up` and fails after the deadline (no reply to
/// unauthenticated probes).
#[test]
fn wrong_key_fails_after_deadline() {
    let p = pair(Loss::None, 5, true);
    let (mut s_seen, mut v_seen) = (Vec::new(), Vec::new());
    let deadline = Duration::from_millis(ice::DEADLINE_MS + 1_000);
    let v = wait_for(&p.v_events, deadline, &mut v_seen, |e| matches!(e, LinkEvent::Failed(_) | LinkEvent::Up(_)));
    let s = wait_for(&p.s_events, deadline, &mut s_seen, |e| matches!(e, LinkEvent::Failed(_) | LinkEvent::Up(_)));
    let took = (now_us() - p.setup_us) / 1000;
    assert!(matches!(v, Some(LinkEvent::Failed(_))), "viewer: {v:?}");
    assert!(matches!(s, Some(LinkEvent::Failed(_))), "sharer: {s:?}");
    assert!(took >= ice::DEADLINE_MS - 50, "failed too early: {took} ms");
    // the probes of both sides failed authentication and were never answered
    assert!(p.sl.stats().rejected > 0 && p.vl.stats().rejected > 0);
    assert!(p.sl.path().is_none() && p.vl.path().is_none());
    // a failed link is final: close() emits nothing more, send_message is refused
    p.vl.close(ByeReason::Closed);
    assert!(p.vl.send_message("x").is_err());
    assert!(wait_for(&p.v_events, Duration::from_millis(100), &mut v_seen, |_| true).is_none());
}

/// The page's decoder asks for a key frame: the request reaches the encoder (after the join key frame's hold)
/// and the next key frame is delivered.
#[test]
fn keyframe_request_reaches_the_encoder() {
    let p = pair(Loss::None, 6, false);
    let mut seen = Vec::new();
    wait_up(&p.s_events, Duration::from_millis(ice::DEADLINE_MS), &mut seen);
    wait_up(&p.v_events, Duration::from_millis(ice::DEADLINE_MS), &mut seen);
    // a well-behaved encoder: a requested key frame is the next frame
    let mut id = 0u32;
    let mut push = || {
        id += 1;
        let key = p.force_key.swap(false, Ordering::Relaxed);
        let data = frame_bytes(id, 5_000);
        let t = now_us();
        p.sender.push_frame(&EncodedFrame {
            frame_id: id,
            codec: Codec::Hevc,
            key,
            after_invalidation: false,
            repeat: false,
            data,
            capture_us: t,
            encoded_us: t,
            width: 64,
            height: 64,
        });
        (id, key)
    };
    // the join asked for a key frame (the link was added before it was up)
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(push(), (1, true), "join → Keyframe request");
    // stream for longer than the key frame hold, so the next request is executed at once
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(10));
        push();
    }
    let before = p.requests.lock().unwrap().len();
    let asked = now_us();
    p.receiver.request_keyframe();
    let mut got = None;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(2));
        if let Some(r) = p.requests.lock().unwrap()[before..].iter().find(|r| r.1 == EncoderRequest::Keyframe) {
            got = Some(r.0 - asked);
            break;
        }
    }
    let after_ms = got.expect("Keyframe request reached the encoder") / 1000;
    assert!(after_ms < 50, "took {after_ms} ms");
    let (last, key) = push();
    assert!(key);
    std::thread::sleep(Duration::from_millis(100));
    let keys: Vec<u32> = std::iter::from_fn(|| p.delivered.try_recv().ok())
        .filter_map(|(_, e)| if let RecvEvent::Video(au) = e { au.key.then_some(au.frame_id) } else { None })
        .collect();
    assert_eq!((keys.first(), keys.last()), (Some(&1), Some(&last)));
    let rs = p.receiver.stats();
    assert_eq!((rs.frames, rs.frames_lost), (last as u64, 0));
    assert!(rs.keyframe_requests >= 1);
    // the clock offset is known by now: ages are real numbers
    assert!(rs.age_ms > 0.0 && rs.age_ms < 50.0, "age {}", rs.age_ms);
}

/// A network that goes dead: both sides close with "timeout" after LINK_TIMEOUT_MS.
#[test]
fn silence_closes_the_link_with_timeout() {
    let p = pair(Loss::None, 7, false);
    let (mut s_seen, mut v_seen) = (Vec::new(), Vec::new());
    wait_up(&p.s_events, Duration::from_millis(ice::DEADLINE_MS), &mut s_seen);
    wait_up(&p.v_events, Duration::from_millis(ice::DEADLINE_MS), &mut v_seen);
    std::thread::sleep(Duration::from_millis(300)); // a few pings: RTT known
    assert!(p.vl.rtt_us().is_some() && p.sl.rtt_us().is_some());
    assert!(p.vl.peer_to_local_us(now_us()).is_some());
    p.shim.blackhole.store(true, Ordering::Relaxed);
    let t = now_us();
    let limit = Duration::from_millis(st_media::net::link::LINK_TIMEOUT_MS + 1_000);
    let v = wait_for(&p.v_events, limit, &mut v_seen, |e| matches!(e, LinkEvent::Closed(_)));
    let s = wait_for(&p.s_events, limit, &mut s_seen, |e| matches!(e, LinkEvent::Closed(_)));
    let ms = (now_us() - t) / 1000;
    assert!(matches!(&v, Some(LinkEvent::Closed(r)) if r == "timeout"), "{v:?}");
    assert!(matches!(&s, Some(LinkEvent::Closed(r)) if r == "timeout"), "{s:?}");
    assert!(ms + 100 >= st_media::net::link::LINK_TIMEOUT_MS, "closed after {ms} ms");
}

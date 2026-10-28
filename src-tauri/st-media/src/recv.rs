//! Viewer side of one link (docs/NATIVE-PATH.md §6): reassembly without a jitter buffer, loss feedback, audio
//! blocks, delivery to the glue.
//!
//! * video shards → [`crate::net::frame::Reassembler`]; every complete access unit is delivered IN ORDER (a
//!   decoder needs every delta frame — "newest wins" happens when the page draws);
//! * `Lost` → FrameLost to the sharer at once, repeated every max(2 × RTT, 10 ms) until a key / after-RFI frame
//!   newer than the loss arrives (at most 3 times, then a Keyframe request);
//! * [`Receiver::request_keyframe`] (page decoder error / decoder (re)configured) → Keyframe, same repetition;
//! * a receiver report every 200 ms;
//! * audio: packets are put in order, a missing 5 ms packet becomes silence; every 4 packets (20 ms, or after
//!   25 ms) one [`AudioBlock`] goes out;
//! * delivery runs on the receiver's own thread `st-recv` through a queue of at most [`MAX_QUEUED_AUS`] access
//!   units: if the sink falls behind, the queue is dropped, video waits for the next key frame and one is
//!   requested. The network thread never waits on IPC.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use crate::clock::now_us;
use crate::net::ctrl::{Ctrl, ReceiverReport, PING_MS};
use crate::net::frame::{newer, CompleteFrame, Reassembled, Reassembler};
use crate::net::link::{Link, PacketHandler};
use crate::net::wire::{vflags, AudioPacket, VideoShard};
use crate::stats::RecvStats;
use crate::{Codec, AUDIO_BLOCK_FRAMES, AUDIO_CHANNELS, AUDIO_PACKET_FRAMES};

/// Access units queued for the sink before the queue is dropped (see module docs).
pub const MAX_QUEUED_AUS: usize = 8;
/// Loss and key frame feedback repeats every max(2 × RTT, this) (ms).
pub const FEEDBACK_MIN_MS: u64 = 10;
/// FrameLost repeats before it turns into a Keyframe request.
pub const FRAME_LOST_REPEATS: u8 = 3;
/// A missing 5 ms audio packet becomes silence once a later packet waited this long (ms).
pub const AUDIO_REORDER_MS: u64 = 20;
/// An incomplete audio block goes out (filled with silence) this long after its first packet (ms).
pub const AUDIO_BLOCK_MAX_MS: u64 = 25;
/// Without a key frame this long after the link came up, one is requested (the sharer normally sends one).
const FIRST_KEY_WAIT_MS: u64 = 100;
/// Audio blocks queued for the sink, at most (0.5 s; older ones are dropped).
const MAX_QUEUED_AUDIO: usize = 25;
/// Window of the one-way delay trend (µs).
const TREND_WINDOW_US: u64 = 1_000_000;
/// A jump of the audio sequence by more than this (1 s of packets) restarts the reordering.
const AUDIO_RESYNC: u32 = 200;
const PACKETS_PER_BLOCK: usize = AUDIO_BLOCK_FRAMES / AUDIO_PACKET_FRAMES;
const PACKET_SAMPLES: usize = AUDIO_PACKET_FRAMES * AUDIO_CHANNELS;

/// One complete access unit for the page.
#[derive(Clone, Debug)]
pub struct VideoAu {
    pub frame_id: u32,
    pub codec: Codec,
    pub key: bool,
    /// completed with FEC
    pub recovered: bool,
    /// first frame after a loss (the page may show a short hint / count it)
    pub after_loss: bool,
    /// sender capture time (sender clock, µs) — the WebCodecs timestamp
    pub pts_us: u64,
    /// capture → handed to the sink on OUR clock (µs), 0 while the clock offset is unknown
    pub age_us: u32,
    /// capture → encoded on the sender (µs)
    pub sender_latency_us: u32,
    /// Annex B
    pub data: Vec<u8>,
}

/// 20 ms of sound for the page.
#[derive(Clone, Debug)]
pub struct AudioBlock {
    /// seq of the first 5 ms packet in the block
    pub seq: u32,
    /// sender capture time of the first sample (sender clock, µs)
    pub capture_us: u64,
    /// s16 interleaved stereo, [`crate::AUDIO_BLOCK_FRAMES`] frames
    pub pcm: Vec<i16>,
    /// 5 ms packets replaced with silence in this block
    pub concealed: u8,
}

#[derive(Clone, Debug)]
pub enum RecvEvent {
    Video(VideoAu),
    Audio(AudioBlock),
}

/// Gets the receiver's output on its `st-recv` thread.
pub type RecvSink = Arc<dyn Fn(RecvEvent) + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ───────────────────────── audio reordering ─────────────────────────

/// Puts 5 ms packets in order and cuts them into 20 ms blocks; a packet that does not come in time is silence.
#[derive(Default)]
struct AudioReorder {
    /// seq of the next slot to fill
    next: Option<u32>,
    /// (seq, capture µs, samples, arrival µs) of packets ahead of `next`
    pending: Vec<(u32, u64, Vec<i16>, u64)>,
    block: Vec<i16>,
    block_seq: u32,
    block_capture: Option<u64>,
    block_start_us: u64,
    slots: usize,
    concealed: u8,
    /// (seq, capture µs) of the last real packet (capture time of a block that starts with silence)
    last: Option<(u32, u64)>,
}

impl AudioReorder {
    fn push(&mut self, seq: u32, capture_us: u64, pcm: Vec<i16>, now: u64) -> Vec<AudioBlock> {
        let next = *self.next.get_or_insert(seq);
        let mut out = Vec::new();
        if seq != next && !newer(seq, next) {
            if next.wrapping_sub(seq) <= AUDIO_RESYNC {
                return self.drain(now); // late: its slot is silence already, or a duplicate
            }
            self.restart(seq, now, &mut out);
        } else if seq.wrapping_sub(next) > AUDIO_RESYNC {
            self.restart(seq, now, &mut out);
        }
        if !self.pending.iter().any(|p| p.0 == seq) {
            self.pending.push((seq, capture_us, pcm, now));
        }
        out.extend(self.drain(now));
        out
    }

    /// The sender restarted its sequence (or we lost a whole second): finish the block, start over at `seq`.
    fn restart(&mut self, seq: u32, now: u64, out: &mut Vec<AudioBlock>) {
        while self.slots > 0 {
            self.place(None, now, out);
        }
        self.pending.clear();
        self.next = Some(seq);
    }

    fn drain(&mut self, now: u64) -> Vec<AudioBlock> {
        let mut out = Vec::new();
        while let Some(next) = self.next {
            if let Some(i) = self.pending.iter().position(|p| p.0 == next) {
                let p = self.pending.swap_remove(i);
                self.place(Some(p), now, &mut out);
            } else if self.pending.iter().any(|p| now.saturating_sub(p.3) >= AUDIO_REORDER_MS * 1000) {
                self.place(None, now, &mut out); // a later packet waited long enough: `next` is lost
            } else {
                break;
            }
        }
        out
    }

    /// Fills the next slot with a packet or silence.
    fn place(&mut self, p: Option<(u32, u64, Vec<i16>, u64)>, now: u64, out: &mut Vec<AudioBlock>) {
        let next = self.next.unwrap_or(0);
        if self.slots == 0 {
            self.block_seq = next;
            self.block_start_us = now;
            self.block_capture = None;
            self.block.clear();
        }
        match p {
            Some((seq, capture, pcm, _)) => {
                if self.block_capture.is_none() {
                    self.block_capture = Some(capture.saturating_sub(self.slots as u64 * 5_000));
                }
                self.last = Some((seq, capture));
                self.block.extend_from_slice(&pcm);
            }
            None => {
                self.block.resize(self.block.len() + PACKET_SAMPLES, 0);
                self.concealed += 1;
            }
        }
        self.slots += 1;
        self.next = Some(next.wrapping_add(1));
        if self.slots == PACKETS_PER_BLOCK {
            let capture = self.block_capture.unwrap_or_else(|| {
                // the whole block is silence: continue the last real packet's clock
                self.last.map_or(0, |(seq, cap)| cap + self.block_seq.wrapping_sub(seq) as u64 * 5_000)
            });
            out.push(AudioBlock { seq: self.block_seq, capture_us: capture, pcm: std::mem::take(&mut self.block), concealed: self.concealed });
            self.slots = 0;
            self.concealed = 0;
        }
    }

    /// Called on every tick: a block started more than 25 ms ago goes out now, missing packets as silence.
    fn flush(&mut self, now: u64) -> Vec<AudioBlock> {
        let mut out = self.drain(now);
        if self.slots > 0 && now.saturating_sub(self.block_start_us) >= AUDIO_BLOCK_MAX_MS * 1000 {
            while self.slots > 0 {
                let next = self.next.unwrap_or(0);
                let p = self.pending.iter().position(|p| p.0 == next).map(|i| self.pending.swap_remove(i));
                self.place(p, now, &mut out);
            }
        }
        out
    }
}

// ───────────────────────── delivery ─────────────────────────

#[derive(Default)]
struct Queue {
    items: VecDeque<RecvEvent>,
    videos: usize,
    audios: usize,
}

/// The queue between the network thread and `st-recv`.
#[derive(Default)]
struct Delivery {
    q: Mutex<Queue>,
    cv: Condvar,
    closed: AtomicBool,
}

impl Delivery {
    /// Queues an access unit. On overflow the queued video is dropped; returns (frames dropped, whether video
    /// must now wait for a key frame).
    fn push_video(&self, au: VideoAu) -> (u64, bool) {
        let mut q = lock(&self.q);
        let mut dropped = 0;
        if q.videos >= MAX_QUEUED_AUS {
            let before = q.items.len();
            q.items.retain(|e| !matches!(e, RecvEvent::Video(_)));
            dropped = (before - q.items.len()) as u64;
            q.videos = 0;
            if !au.key {
                return (dropped + 1, true);
            }
        }
        q.videos += 1;
        q.items.push_back(RecvEvent::Video(au));
        drop(q);
        self.cv.notify_one();
        (dropped, false)
    }

    fn push_audio(&self, block: AudioBlock) {
        let mut q = lock(&self.q);
        if q.audios >= MAX_QUEUED_AUDIO {
            if let Some(i) = q.items.iter().position(|e| matches!(e, RecvEvent::Audio(_))) {
                q.items.remove(i);
                q.audios -= 1;
            }
        }
        q.audios += 1;
        q.items.push_back(RecvEvent::Audio(block));
        drop(q);
        self.cv.notify_one();
    }
}

/// What reached the sink (for the stats).
#[derive(Default)]
struct Delivered {
    frames: u64,
    /// (time, bytes, age µs) of the access units of the last second
    recent: VecDeque<(u64, usize, u32)>,
}

fn deliver_loop(out: Arc<Delivery>, delivered: Arc<Mutex<Delivered>>, link: Weak<Link>, sink: RecvSink) {
    crate::net::link::boost_media_thread();
    loop {
        let ev = {
            let mut q = lock(&out.q);
            loop {
                if out.closed.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(ev) = q.items.pop_front() {
                    match ev {
                        RecvEvent::Video(_) => q.videos -= 1,
                        RecvEvent::Audio(_) => q.audios -= 1,
                    }
                    break ev;
                }
                q = out.cv.wait_timeout(q, Duration::from_millis(100)).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
            }
        };
        let ev = match ev {
            RecvEvent::Video(mut au) => {
                let now = now_us();
                let local = link.upgrade().and_then(|l| l.peer_to_local_us(au.pts_us));
                au.age_us = local.map_or(0, |t| now.saturating_sub(t).min(u32::MAX as u64) as u32);
                let mut d = lock(&delivered);
                d.frames += 1;
                d.recent.push_back((now, au.data.len(), au.age_us));
                while d.recent.front().is_some_and(|r| now.saturating_sub(r.0) > 1_000_000) {
                    d.recent.pop_front();
                }
                RecvEvent::Video(au)
            }
            audio => audio,
        };
        sink(ev);
    }
}

// ───────────────────────── receiver ─────────────────────────

/// FrameLost feedback in progress.
struct LossFeedback {
    first: u32,
    last: u32,
    repeats: u8,
    next_us: u64,
}

struct RecvState {
    reasm: Reassembler,
    loss: Option<LossFeedback>,
    /// a Keyframe request is in progress: next repeat at
    key_next_us: Option<u64>,
    got_key: bool,
    up_us: Option<u64>,
    skipped_seen: u64,
    next_report_us: u64,
    last_report_us: u64,
    rep_frames: u32,
    rep_recovered: u32,
    rep_lost: u32,
    rep_bytes: u64,
    /// (first shard arrival on our clock, arrival − encoded on the sender clock) of the last second's frames
    owd: VecDeque<(u64, i64)>,
    audio: AudioReorder,
    frames_recovered: u64,
    frames_lost: u64,
    frames_dropped: u64,
    keyframes: u64,
    keyframe_requests: u64,
    audio_lost: u64,
}

pub struct Receiver {
    link: Weak<Link>,
    st: Mutex<RecvState>,
    out: Arc<Delivery>,
    delivered: Arc<Mutex<Delivered>>,
}

/// Least-squares slope of the one-way delay over the window (µs per second); 0 with too few samples.
fn delay_trend(samples: &VecDeque<(u64, i64)>) -> i32 {
    if samples.len() < 5 {
        return 0;
    }
    let t0 = samples[0].0;
    let n = samples.len() as f64;
    let (sx, sy) = samples.iter().fold((0.0, 0.0), |a, s| (a.0 + s.0.saturating_sub(t0) as f64 / 1e6, a.1 + s.1 as f64));
    let (mx, my) = (sx / n, sy / n);
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for s in samples {
        let dx = s.0.saturating_sub(t0) as f64 / 1e6 - mx;
        sxy += dx * (s.1 as f64 - my);
        sxx += dx * dx;
    }
    if sxx < 1e-3 {
        return 0; // the samples span too little time
    }
    (sxy / sxx).clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

impl Receiver {
    /// Becomes `link`'s packet handler and starts the delivery thread. Requests a key frame once the link is up.
    pub fn attach(link: &Arc<Link>, sink: RecvSink) -> Arc<Receiver> {
        let r = Arc::new(Receiver {
            link: Arc::downgrade(link),
            st: Mutex::new(RecvState {
                reasm: Reassembler::new(),
                loss: None,
                key_next_us: None,
                got_key: false,
                up_us: None,
                skipped_seen: 0,
                next_report_us: 0,
                last_report_us: 0,
                rep_frames: 0,
                rep_recovered: 0,
                rep_lost: 0,
                rep_bytes: 0,
                owd: VecDeque::new(),
                audio: AudioReorder::default(),
                frames_recovered: 0,
                frames_lost: 0,
                frames_dropped: 0,
                keyframes: 0,
                keyframe_requests: 0,
                audio_lost: 0,
            }),
            out: Arc::new(Delivery::default()),
            delivered: Arc::new(Mutex::new(Delivered::default())),
        });
        link.set_handler(r.clone());
        let (out, delivered, weak) = (r.out.clone(), r.delivered.clone(), Arc::downgrade(link));
        if std::thread::Builder::new().name("st-recv".into()).spawn(move || deliver_loop(out, delivered, weak, sink)).is_err() {
            r.out.closed.store(true, Ordering::Relaxed);
        }
        r
    }

    /// The page's decoder needs a key frame (error, reconfigure).
    pub fn request_keyframe(&self) {
        let Some(link) = self.link.upgrade() else { return };
        let mut st = lock(&self.st);
        Self::want_key(&mut st, &link, now_us());
    }

    pub fn stats(&self) -> RecvStats {
        let now = now_us();
        let (frames, fps, kbps, age_ms) = {
            let d = lock(&self.delivered);
            let recent: Vec<&(u64, usize, u32)> = d.recent.iter().filter(|r| now.saturating_sub(r.0) <= 1_000_000).collect();
            let bytes: usize = recent.iter().map(|r| r.1).sum();
            let mut ages: Vec<u32> = recent.iter().map(|r| r.2).filter(|a| *a > 0).collect();
            ages.sort_unstable();
            let age = ages.get(ages.len() / 2).map_or(0.0, |a| *a as f32 / 1000.0);
            (d.frames, recent.len() as f32, (bytes as u64 * 8 / 1000) as u32, age)
        };
        let st = lock(&self.st);
        RecvStats {
            frames,
            frames_recovered: st.frames_recovered,
            frames_lost: st.frames_lost,
            frames_dropped: st.frames_dropped,
            keyframes: st.keyframes,
            keyframe_requests: st.keyframe_requests,
            fps,
            video_kbps: kbps,
            age_ms,
            audio_lost: st.audio_lost,
        }
    }

    /// Stops the delivery thread (the link is not closed here). Idempotent.
    pub fn close(&self) {
        self.out.closed.store(true, Ordering::Relaxed);
        self.out.cv.notify_all();
        if let Some(link) = self.link.upgrade() {
            link.clear_handler(self);
        }
    }

    // ── feedback (called with the state locked) ──

    fn feedback_interval(link: &Link) -> u64 {
        let rtt = link.rtt_us().or(link.path().map(|p| p.rtt_us)).unwrap_or(0);
        (2 * rtt).max(FEEDBACK_MIN_MS * 1000)
    }

    fn want_key(st: &mut RecvState, link: &Link, now: u64) {
        if st.key_next_us.is_some() {
            return; // already asking
        }
        st.key_next_us = Some(now + Self::feedback_interval(link));
        st.keyframe_requests += 1;
        link.send_ctrl(&Ctrl::Keyframe);
    }

    fn on_lost(st: &mut RecvState, link: &Link, first: u32, last: u32, now: u64) {
        let n = last.wrapping_sub(first).wrapping_add(1);
        st.rep_lost = st.rep_lost.saturating_add(n);
        st.frames_lost += n as u64;
        let first = st.loss.as_ref().map_or(first, |l| l.first);
        st.loss = Some(LossFeedback { first, last, repeats: 0, next_us: now + Self::feedback_interval(link) });
        link.send_ctrl(&Ctrl::FrameLost { first, last });
    }

    fn on_frame(&self, st: &mut RecvState, link: &Link, f: CompleteFrame, now: u64) {
        let key = f.flags & vflags::KEY != 0;
        let cures = key || (f.flags & vflags::AFTER_RFI != 0 && st.loss.as_ref().is_some_and(|l| newer(f.frame_id, l.last)));
        if cures {
            st.loss = None;
        }
        if key {
            st.key_next_us = None;
            st.got_key = true;
            st.keyframes += 1;
        }
        st.rep_frames += 1;
        st.rep_bytes += f.data.len() as u64;
        if f.recovered {
            st.rep_recovered += 1;
            st.frames_recovered += 1;
        }
        let encoded = f.capture_us + f.sender_latency_us as u64;
        st.owd.push_back((f.first_us, f.first_us as i64 - encoded as i64));
        while st.owd.front().is_some_and(|s| now.saturating_sub(s.0) > TREND_WINDOW_US) {
            st.owd.pop_front();
        }
        let au = VideoAu {
            frame_id: f.frame_id,
            codec: f.codec,
            key,
            recovered: f.recovered,
            after_loss: f.after_loss,
            pts_us: f.capture_us,
            age_us: 0,
            sender_latency_us: f.sender_latency_us,
            data: f.data,
        };
        let (dropped, need_key) = self.out.push_video(au);
        st.frames_dropped += dropped;
        if need_key {
            // the page fell behind: skip to the next key frame instead of decoding a backlog
            st.reasm.require_key();
            Self::want_key(st, link, now);
        }
    }
}

impl PacketHandler for Receiver {
    fn on_video(&self, link: &Link, shard: VideoShard<'_>, now: u64) {
        let mut st = lock(&self.st);
        for r in st.reasm.push(shard, now) {
            match r {
                Reassembled::Lost { first, last } => Self::on_lost(&mut st, link, first, last, now),
                Reassembled::Frame(f) => self.on_frame(&mut st, link, f, now),
            }
        }
        // deltas held back while nothing is under way to end that (e.g. the first key frame was lost whole)
        let skipped = st.reasm.skipped();
        if skipped > st.skipped_seen {
            st.skipped_seen = skipped;
            if st.loss.is_none() {
                Self::want_key(&mut st, link, now);
            }
        }
    }

    fn on_audio(&self, _link: &Link, p: AudioPacket<'_>, now: u64) {
        if p.frames as usize != AUDIO_PACKET_FRAMES || p.channels as usize != AUDIO_CHANNELS {
            return; // the page plays 48 kHz stereo in 20 ms blocks only
        }
        let pcm: Vec<i16> = p.pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let blocks = {
            let mut st = lock(&self.st);
            let blocks = st.audio.push(p.seq, p.capture_us, pcm, now);
            st.audio_lost += blocks.iter().map(|b| b.concealed as u64).sum::<u64>();
            blocks
        };
        for b in blocks {
            self.out.push_audio(b);
        }
    }

    fn on_ctrl(&self, _link: &Link, _msg: Ctrl, _now_us: u64) {} // the sharer sends no media feedback

    fn on_tick(&self, link: &Link, now: u64) {
        let blocks = {
            let mut st = lock(&self.st);
            let up = *st.up_us.get_or_insert(now);
            if st.last_report_us == 0 {
                st.last_report_us = now;
                st.next_report_us = now + PING_MS * 1000;
            }
            let interval = Self::feedback_interval(link);
            let mut lost_again = None;
            let mut give_up = false;
            if let Some(l) = st.loss.as_mut() {
                if now >= l.next_us {
                    if l.repeats < FRAME_LOST_REPEATS {
                        l.repeats += 1;
                        l.next_us = now + interval;
                        lost_again = Some((l.first, l.last));
                    } else {
                        give_up = true;
                    }
                }
            }
            if let Some((first, last)) = lost_again {
                link.send_ctrl(&Ctrl::FrameLost { first, last });
            }
            if give_up {
                st.loss = None;
                Self::want_key(&mut st, link, now); // FrameLost was not answered: ask for a key frame instead
            }
            if st.key_next_us.is_some_and(|t| now >= t) {
                st.key_next_us = Some(now + interval);
                link.send_ctrl(&Ctrl::Keyframe);
            }
            if !st.got_key && st.loss.is_none() && now.saturating_sub(up) >= FIRST_KEY_WAIT_MS * 1000 {
                Self::want_key(&mut st, link, now);
            }
            if now >= st.next_report_us {
                let (packets_expected, packets_received) = st.reasm.take_packet_counts();
                let ms = (now.saturating_sub(st.last_report_us) / 1000).max(1);
                let report = ReceiverReport {
                    frames: st.rep_frames,
                    recovered: st.rep_recovered,
                    lost: st.rep_lost,
                    packets_expected,
                    packets_received,
                    kbps: (st.rep_bytes * 8 / ms).min(u32::MAX as u64) as u32,
                    delay_trend_us: delay_trend(&st.owd),
                };
                st.rep_frames = 0;
                st.rep_recovered = 0;
                st.rep_lost = 0;
                st.rep_bytes = 0;
                st.last_report_us = now;
                st.next_report_us = now + PING_MS * 1000;
                link.send_ctrl(&Ctrl::Report(report));
            }
            let blocks = st.audio.flush(now);
            st.audio_lost += blocks.iter().map(|b| b.concealed as u64).sum::<u64>();
            blocks
        };
        for b in blocks {
            self.out.push_audio(b);
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.out.closed.store(true, Ordering::Relaxed);
        self.out.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(seq: u32) -> Vec<i16> {
        vec![seq as i16; PACKET_SAMPLES]
    }

    #[test]
    fn audio_in_order_makes_blocks_of_four() {
        let mut a = AudioReorder::default();
        let mut blocks = Vec::new();
        for seq in 10..18u32 {
            blocks.extend(a.push(seq, seq as u64 * 5_000, packet(seq), seq as u64 * 5_000));
        }
        assert_eq!(blocks.len(), 2);
        assert_eq!((blocks[0].seq, blocks[0].capture_us, blocks[0].concealed), (10, 50_000, 0));
        assert_eq!(blocks[1].seq, 14);
        assert_eq!(blocks[0].pcm.len(), AUDIO_BLOCK_FRAMES * AUDIO_CHANNELS);
        assert_eq!(blocks[0].pcm[PACKET_SAMPLES * 3], 13);
    }

    #[test]
    fn audio_reorders_within_20_ms_and_conceals_after() {
        let mut a = AudioReorder::default();
        let ms = 1_000u64;
        assert!(a.push(0, 0, packet(0), 0).is_empty());
        assert!(a.push(2, 10_000, packet(2), 10 * ms).is_empty()); // 1 is late
        assert!(a.push(1, 5_000, packet(1), 12 * ms).is_empty()); // ... and arrives in time
        let b = a.push(3, 15_000, packet(3), 15 * ms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].concealed, b[0].pcm[PACKET_SAMPLES]), (0, 1));
        // 5 never arrives: silence once 6 waited 20 ms
        assert!(a.push(4, 20_000, packet(4), 20 * ms).is_empty());
        assert!(a.push(6, 30_000, packet(6), 30 * ms).is_empty());
        assert!(a.flush(44 * ms).is_empty());
        let b = a.push(7, 35_000, packet(7), 50 * ms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].seq, b[0].concealed), (4, 1));
        assert_eq!(b[0].pcm[PACKET_SAMPLES], 0); // slot of packet 5
        assert_eq!(b[0].pcm[PACKET_SAMPLES * 2], 6);
        // 5 arriving now is too late and changes nothing
        assert!(a.push(5, 25_000, packet(5), 51 * ms).is_empty());
    }

    #[test]
    fn audio_block_goes_out_after_25_ms() {
        let mut a = AudioReorder::default();
        assert!(a.push(100, 0, packet(100), 0).is_empty());
        assert!(a.push(101, 5_000, packet(101), 5_000).is_empty());
        assert!(a.flush(20_000).is_empty());
        let b = a.flush(25_000);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].seq, b[0].concealed), (100, 2));
        // a jump of more than a second (the sender restarted its sequence): a fresh start, no flood of silence
        assert!(a.push(5_000, 900_000, packet(5_000), 900_000).is_empty());
        assert_eq!(a.next, Some(5_001));
        // ... also backwards; the started block goes out first, filled with silence
        let b = a.push(7, 905_000, packet(7), 905_000);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].seq, b[0].concealed), (5_000, 3));
        assert_eq!(a.next, Some(8));
        assert_eq!(a.slots, 1);
    }

    #[test]
    fn trend_of_a_growing_queue() {
        let rising: VecDeque<(u64, i64)> = (0..60).map(|i| (i * 16_667, 1_000 + i as i64 * 100)).collect();
        let t = delay_trend(&rising);
        assert!((5_900..=6_100).contains(&t), "{t}"); // 100 µs per 16.7 ms frame = 6 ms/s
        let flat: VecDeque<(u64, i64)> = (0..60).map(|i| (i * 16_667, 5_000 + (i % 3) as i64 * 50)).collect();
        assert!(delay_trend(&flat).abs() < 200);
        assert_eq!(delay_trend(&VecDeque::new()), 0);
    }
}

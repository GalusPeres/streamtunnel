//! Sharer side of one encoder (docs/NATIVE-PATH.md §6): fans every encoded frame out to the links that watch this
//! codec, sends the share sound, and turns the viewers' feedback into encoder requests.
//!
//! * a frame is sharded + FEC-coded once ([`crate::net::frame::shard_frame`], 10 % parity when every link is
//!   "lan", else 20 %) and queued on every link that is up and has seen a key frame;
//! * a link added with [`Sender::add_link`] gets nothing until the next key frame; joins request one, coalesced
//!   over 250 ms;
//! * FrameLost → `InvalidateRefs` when every link of this encoder has the RFI capability, else `Keyframe`
//!   (WebCodecs viewers: no RFI in this milestone); Keyframe requests are executed at most once per 200 ms
//!   (requests during the hold merge into one at its end);
//! * receiver reports drive [`crate::net::rate::RateCtl`] (the minimum over the links); a change becomes
//!   `EncoderRequest::Bitrate`. A bitrate set by hand never changes.
//!
//! No thread of its own: everything runs in `push_frame` / `push_audio` (capture thread, glue) and in the
//! links' `on_ctrl` (network thread).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::clock::now_us;
use crate::net::ctrl::Ctrl;
use crate::net::fec::{FEC_PCT_LAN, FEC_PCT_WAN};
use crate::net::frame::{newer, shard_frame};
use crate::net::link::{Link, PacketHandler};
use crate::net::rate::{RateCtl, MIN_CHANGE_MS};
use crate::net::wire::{AudioPacket, VideoShard, AUDIO_HEADER_LEN, MAX_PLAINTEXT};
use crate::stats::SenderStats;
use crate::{AudioChunk, Codec, EncodedFrame, EncoderRequest, AUDIO_CHANNELS};

/// Joins within this window share one key frame (ms).
pub const JOIN_COALESCE_MS: u64 = 250;
/// Minimum gap between two key frame requests (ms).
pub const KEYFRAME_HOLD_MS: u64 = 200;
/// A Keyframe request this soon after a key frame went out (or max(2 × RTT, this)) crossed that key frame on the
/// way: ignored (ms).
const CROSSED_MS: u64 = 20;
/// Rate controllers tick this often (µs).
const RATE_TICK_US: u64 = 100_000;

/// What one viewer's decoder can do (from its `nv` join caps).
#[derive(Clone, Copy, Debug, Default)]
pub struct ViewerCaps {
    /// recovers from reference-frame invalidation (false for every WebCodecs viewer in this milestone)
    pub rfi: bool,
}

/// Encoder requests go here (the glue forwards them to `win::capture::CaptureSession::request`).
pub type RequestSink = Arc<dyn Fn(EncoderRequest) + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub struct SenderConfig {
    pub codec: Codec,
    /// CBR target (kbit/s): the user's value, or `rate::lan_bitrate_kbps` for Auto
    pub target_kbps: u32,
    /// the user set the bitrate by hand: never adapt
    pub fixed: bool,
}

struct SendLink {
    link: Arc<Link>,
    caps: ViewerCaps,
    /// gets nothing until the next key frame (new link, or frames dropped on it)
    waiting_key: bool,
    /// newest frame id of a loss already handled (the viewer repeats FrameLost until it recovers)
    lost_upto: Option<u32>,
    rate: RateCtl,
}

struct SendState {
    links: Vec<SendLink>,
    target_kbps: u32,
    fixed: bool,
    /// the encoder's current rate: the target, or the backed-off minimum over the links
    enc_kbps: u32,
    bitrate_us: Option<u64>,
    key_issued_us: Option<u64>,
    /// a Keyframe request went to the encoder and no key frame came back yet
    key_outstanding: bool,
    /// a request arrived during the hold: issue it when the hold ends
    key_held: bool,
    last_key_us: Option<u64>,
    last_key_id: Option<u32>,
    next_rate_tick_us: u64,
    frames: u64,
    keyframes: u64,
    invalidations: u64,
    /// (time, access-unit bytes) sent over the last second
    sent: VecDeque<(u64, usize)>,
}

pub struct Sender {
    codec: Codec,
    requests: RequestSink,
    st: Mutex<SendState>,
}

impl Sender {
    pub fn new(cfg: SenderConfig, requests: RequestSink) -> Arc<Sender> {
        Arc::new(Sender {
            codec: cfg.codec,
            requests,
            st: Mutex::new(SendState {
                links: Vec::new(),
                target_kbps: cfg.target_kbps,
                fixed: cfg.fixed,
                enc_kbps: cfg.target_kbps,
                bitrate_us: None,
                key_issued_us: None,
                key_outstanding: false,
                key_held: false,
                last_key_us: None,
                last_key_id: None,
                next_rate_tick_us: 0,
                frames: 0,
                keyframes: 0,
                invalidations: 0,
                sent: VecDeque::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, SendState> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Hands requests to the encoder (never with the state locked: the sink may block briefly).
    fn emit(&self, reqs: Vec<EncoderRequest>) {
        for r in reqs {
            (self.requests)(r);
        }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    /// Feeds `link` from the next key frame on (requests one) and becomes its packet handler.
    pub fn add_link(self: &Arc<Self>, link: &Arc<Link>, caps: ViewerCaps) {
        let mut reqs = Vec::new();
        {
            let mut st = self.lock();
            if let Some(l) = st.links.iter_mut().find(|l| l.link.id() == link.id()) {
                l.caps = caps;
            } else {
                let rate = RateCtl::new(st.target_kbps, st.fixed);
                st.links.push(SendLink { link: link.clone(), caps, waiting_key: true, lost_upto: None, rate });
                link.set_pace_target(st.enc_kbps);
                if link.is_up() {
                    Self::request_key(&mut st, now_us(), &mut reqs);
                } // else: requested once it is up (tick)
            }
        }
        link.set_handler(self.clone());
        self.emit(reqs);
    }

    /// Stops feeding a link (it is not closed here).
    pub fn remove_link(&self, link_id: u32) {
        let mut reqs = Vec::new();
        let removed = {
            let mut st = self.lock();
            let i = st.links.iter().position(|l| l.link.id() == link_id);
            let removed = i.map(|i| st.links.remove(i).link);
            Self::apply_rate(&mut st, now_us(), &mut reqs);
            removed
        };
        if let Some(link) = removed {
            link.clear_handler(self);
        }
        self.emit(reqs);
    }

    /// Links currently fed.
    pub fn link_count(&self) -> usize {
        self.lock().links.len()
    }

    /// One encoded frame from the capture session.
    pub fn push_frame(&self, frame: &EncodedFrame) {
        let now = now_us();
        let mut reqs = Vec::new();
        let (targets, pct) = {
            let mut st = self.lock();
            Self::tick(&mut st, now, &mut reqs);
            if frame.key {
                st.key_outstanding = false;
                st.key_held = false;
                st.last_key_us = Some(now);
                st.last_key_id = Some(frame.frame_id);
            }
            let mut all_lan = true;
            let mut targets = Vec::new();
            for l in st.links.iter_mut() {
                let Some(path) = l.link.path().filter(|_| l.link.is_up()) else { continue };
                all_lan &= path.lan;
                if l.waiting_key {
                    if !frame.key {
                        continue;
                    }
                    l.waiting_key = false;
                }
                targets.push(l.link.clone());
            }
            if !targets.is_empty() {
                st.frames += 1;
                st.sent.push_back((now, frame.data.len()));
                while st.sent.front().is_some_and(|s| now.saturating_sub(s.0) > 1_000_000) {
                    st.sent.pop_front();
                }
            }
            (targets, if all_lan { FEC_PCT_LAN } else { FEC_PCT_WAN })
        };
        self.emit(reqs);
        if targets.is_empty() {
            return;
        }
        let shards = Arc::new(shard_frame(frame, pct));
        let dropped: Vec<u32> = targets.iter().filter(|l| l.send_frame(shards.clone()) > 0).map(|l| l.id()).collect();
        if !dropped.is_empty() {
            // those links are slower than the encoder: they skip ahead to the next key frame
            let mut reqs = Vec::new();
            {
                let mut st = self.lock();
                for l in st.links.iter_mut().filter(|l| dropped.contains(&l.link.id())) {
                    l.waiting_key = true;
                }
                Self::request_key(&mut st, now, &mut reqs);
            }
            self.emit(reqs);
        }
    }

    /// 5 ms of share sound (sent to every link of this sender, ahead of queued video).
    pub fn push_audio(&self, chunk: &AudioChunk) {
        if chunk.pcm.is_empty() || !chunk.pcm.len().is_multiple_of(AUDIO_CHANNELS) || AUDIO_HEADER_LEN + chunk.pcm.len() * 2 > MAX_PLAINTEXT {
            return;
        }
        let links: Vec<Arc<Link>> = self.lock().links.iter().filter(|l| l.link.is_up()).map(|l| l.link.clone()).collect();
        if links.is_empty() {
            return;
        }
        let mut pcm = Vec::with_capacity(chunk.pcm.len() * 2);
        for s in &chunk.pcm {
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        let mut p = Vec::with_capacity(AUDIO_HEADER_LEN + pcm.len());
        AudioPacket {
            seq: chunk.seq,
            capture_us: chunk.capture_us,
            frames: (chunk.pcm.len() / AUDIO_CHANNELS) as u16,
            channels: AUDIO_CHANNELS as u8,
            pcm: &pcm,
        }
        .encode(&mut p);
        for l in links {
            l.send_audio(&p);
        }
    }

    /// The user changed the bitrate (or Auto got a new value): resets the rate controller.
    pub fn set_target(&self, kbps: u32, fixed: bool) {
        let mut st = self.lock();
        st.target_kbps = kbps;
        st.fixed = fixed;
        st.enc_kbps = kbps; // the glue gave the encoder this target itself
        for l in st.links.iter_mut() {
            l.rate.set_target(kbps, fixed);
            l.link.set_pace_target(kbps);
        }
    }

    pub fn stats(&self) -> SenderStats {
        let now = now_us();
        let st = self.lock();
        let bytes: usize = st.sent.iter().filter(|s| now.saturating_sub(s.0) <= 1_000_000).map(|s| s.1).sum();
        SenderStats {
            codec: self.codec.name().into(),
            target_kbps: st.enc_kbps,
            video_kbps: (bytes as u64 * 8 / 1000) as u32,
            frames: st.frames,
            keyframes: st.keyframes,
            invalidations: st.invalidations,
            links: st.links.len() as u32,
        }
    }

    // ── state machine (called with the state locked) ──

    fn request_key(st: &mut SendState, now: u64, reqs: &mut Vec<EncoderRequest>) {
        let since = |t: Option<u64>| t.map_or(u64::MAX, |t| now.saturating_sub(t));
        if st.key_outstanding && since(st.key_issued_us) < JOIN_COALESCE_MS * 1000 {
            return; // the key frame on its way serves this request too
        }
        if since(st.key_issued_us) < KEYFRAME_HOLD_MS * 1000 {
            st.key_held = true;
            return;
        }
        st.key_issued_us = Some(now);
        st.key_outstanding = true;
        st.key_held = false;
        st.keyframes += 1;
        reqs.push(EncoderRequest::Keyframe);
    }

    fn tick(st: &mut SendState, now: u64, reqs: &mut Vec<EncoderRequest>) {
        let hold_over = st.key_issued_us.is_none_or(|t| now.saturating_sub(t) >= KEYFRAME_HOLD_MS * 1000);
        if st.key_held && hold_over {
            st.key_held = false;
            Self::request_key(st, now, reqs);
        }
        // a link that came up (or skipped frames) and still waits for a key frame
        if !st.key_outstanding && !st.key_held && st.links.iter().any(|l| l.waiting_key && l.link.is_up()) {
            Self::request_key(st, now, reqs);
        }
        if now >= st.next_rate_tick_us {
            st.next_rate_tick_us = now + RATE_TICK_US;
            for l in st.links.iter_mut() {
                l.rate.tick(now);
            }
            Self::apply_rate(st, now, reqs);
        }
    }

    /// The encoder follows the slowest link's rate controller, at most one change per 500 ms.
    fn apply_rate(st: &mut SendState, now: u64, reqs: &mut Vec<EncoderRequest>) {
        let want = st.links.iter().map(|l| l.rate.current_kbps()).min().unwrap_or(st.target_kbps);
        if want == st.enc_kbps || st.bitrate_us.is_some_and(|t| now.saturating_sub(t) < MIN_CHANGE_MS * 1000) {
            return; // unchanged, or the next rate tick retries
        }
        st.enc_kbps = want;
        st.bitrate_us = Some(now);
        reqs.push(EncoderRequest::Bitrate { kbps: want });
        for l in &st.links {
            l.link.set_pace_target(want);
        }
    }
}

impl PacketHandler for Sender {
    fn on_video(&self, _link: &Link, _shard: VideoShard<'_>, _now_us: u64) {} // viewers send no media

    fn on_audio(&self, _link: &Link, _packet: AudioPacket<'_>, _now_us: u64) {}

    fn on_ctrl(&self, link: &Link, msg: Ctrl, now: u64) {
        let crossed = (2 * link.rtt_us().unwrap_or(0)).max(CROSSED_MS * 1000);
        let mut reqs = Vec::new();
        {
            let mut st = self.lock();
            let Some(i) = st.links.iter().position(|l| l.link.id() == link.id()) else { return };
            match msg {
                Ctrl::FrameLost { first, last } => {
                    let l = &mut st.links[i];
                    if l.lost_upto.is_some_and(|u| !newer(last, u)) || l.waiting_key {
                        return; // a repeat, or the link waits for a key frame anyway
                    }
                    l.lost_upto = Some(last);
                    if st.last_key_id.is_some_and(|k| newer(k, last)) {
                        return; // a key frame after the loss is already on its way
                    }
                    if st.links.iter().all(|l| l.caps.rfi) {
                        st.invalidations += 1;
                        reqs.push(EncoderRequest::InvalidateRefs { first, last });
                    } else {
                        Self::request_key(&mut st, now, &mut reqs);
                    }
                }
                // a request that crossed the last key frame is answered already; one the encoder did not answer
                // within the join window is asked again (request_key coalesces the rest)
                Ctrl::Keyframe if st.last_key_us.is_none_or(|t| now.saturating_sub(t) >= crossed) => {
                    Self::request_key(&mut st, now, &mut reqs);
                }
                Ctrl::Report(r) => {
                    let changed = st.links[i].rate.on_report(now, &r).is_some();
                    if changed {
                        Self::apply_rate(&mut st, now, &mut reqs);
                    }
                }
                _ => {}
            }
        }
        self.emit(reqs);
    }

    fn on_tick(&self, _link: &Link, now: u64) {
        let mut reqs = Vec::new();
        Self::tick(&mut self.lock(), now, &mut reqs);
        self.emit(reqs);
    }
}

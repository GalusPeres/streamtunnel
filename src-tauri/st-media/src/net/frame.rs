//! Frames ↔ shards (docs/NATIVE-PATH.md §6).
//!
//! Sender: an access unit of n bytes becomes k = ⌈n / MAX_SHARD⌉ data shards of [`shard_len`] bytes each (the last
//! zero-padded) plus m parity shards ([`crate::net::fec::parity_count`]); every shard is one video datagram.
//!
//! Receiver ([`Reassembler`]), Moonlight's rules — no jitter buffer:
//! * a frame is delivered the moment its k data shards are in, or as soon as any k shards allow an RS decode;
//! * when a shard of a newer frame arrives while an older frame is still incomplete and cannot be recovered with
//!   what arrived, the older frame is lost: `Lost { first, last }` covers every frame id from the oldest missing
//!   one up to newest − 1;
//! * after a loss, delta frames are not delivered until a key frame or an after-RFI frame newer than the loss
//!   arrives (the decoder would only show garbage).

use std::collections::VecDeque;

use crate::net::fec;
use crate::net::wire::{vflags, VideoShard};
use crate::{Codec, EncodedFrame};

/// Incomplete frames kept at once; older ones are declared lost. With the rule above only the newest frame is
/// ever incomplete; the receiver's packet accounting keeps this many recent frames.
pub const MAX_FRAMES_IN_FLIGHT: usize = 4;
/// Largest access unit the receiver assembles, in data shards (≈ 4.7 MB); a frame claiming more is ignored.
pub const MAX_DATA_SHARDS: usize = 4096;
/// A frame id this far behind the next expected one means the sender restarted its ids, not a late shard.
const RESYNC_GAP: u32 = 1024;

/// Bytes per shard for an access unit of `au_len` bytes split into `data_shards` shards: ⌈au_len / k⌉ rounded up
/// to even (Reed-Solomon needs even shards), at least 2.
pub fn shard_len(au_len: usize, data_shards: usize) -> usize {
    let k = data_shards.max(1);
    let n = au_len.div_ceil(k).max(2);
    n + (n & 1)
}

/// Data shards for an access unit: ⌈au_len / MAX_SHARD⌉, at least 1.
pub fn data_shard_count(au_len: usize) -> usize {
    au_len.div_ceil(crate::net::wire::MAX_SHARD).max(1)
}

/// `a` is a newer frame id than `b` (wrapping u32 arithmetic).
pub fn newer(a: u32, b: u32) -> bool {
    a != b && a.wrapping_sub(b) < 1 << 31
}

/// Splits one encoded frame into video plaintexts (data shards first, then parity), ready for
/// [`crate::net::link::Link::send_video`]. Computed once per frame and shared by every link of a sender.
pub fn shard_frame(frame: &EncodedFrame, fec_pct: u8) -> Vec<Vec<u8>> {
    let n = frame.data.len();
    let k = data_shard_count(n);
    if k > u16::MAX as usize {
        return Vec::new(); // ≈ 75 MB: no encoder makes such a frame
    }
    let len = shard_len(n, k);
    let m = fec::parity_count(k, fec_pct);
    let flags = (if frame.key { vflags::KEY } else { 0 })
        | (if frame.after_invalidation { vflags::AFTER_RFI } else { 0 })
        | (if frame.repeat { vflags::REPEAT } else { 0 });
    let latency = (frame.encoded_us.saturating_sub(frame.capture_us) / 100).min(u16::MAX as u64) as u16;
    let header = |index: usize, shard: &[u8], m: usize, out: &mut Vec<u8>| {
        VideoShard {
            frame_id: frame.frame_id,
            index: index as u16,
            data_shards: k as u16,
            parity_shards: m as u16,
            flags,
            codec: frame.codec as u8,
            au_len: n as u32,
            capture_us: frame.capture_us,
            sender_latency: latency,
            shard,
        }
        .encode(out)
    };
    let hl = crate::net::wire::VIDEO_HEADER_LEN;
    let mut out = Vec::with_capacity(k + m);
    for i in 0..k {
        let piece = &frame.data[(i * len).min(n)..((i + 1) * len).min(n)];
        let mut p = Vec::with_capacity(hl + len);
        header(i, piece, m, &mut p);
        p.resize(hl + len, 0); // the last shard is zero-padded
        out.push(p);
    }
    if m > 0 {
        let refs: Vec<&[u8]> = out.iter().map(|p| &p[hl..]).collect();
        match fec::encode(&refs, m) {
            Ok(parity) => {
                for (j, shard) in parity.iter().enumerate() {
                    let mut p = Vec::with_capacity(hl + len);
                    header(k + j, shard, m, &mut p);
                    out.push(p);
                }
            }
            Err(_) => {
                // never expected (even lengths, supported counts): send the frame without parity
                for p in &mut out {
                    p[8..10].copy_from_slice(&0u16.to_be_bytes());
                }
            }
        }
    }
    out
}

/// A complete access unit on the viewer side.
#[derive(Clone, Debug)]
pub struct CompleteFrame {
    pub frame_id: u32,
    pub codec: Codec,
    /// `crate::net::wire::vflags`
    pub flags: u8,
    /// sender clock
    pub capture_us: u64,
    /// capture → encoded on the sender (µs)
    pub sender_latency_us: u32,
    /// needed parity shards
    pub recovered: bool,
    /// first frame delivered after a loss
    pub after_loss: bool,
    pub data: Vec<u8>,
    /// our clock when the frame's first shard arrived (one-way delay trend)
    pub first_us: u64,
}

/// What [`Reassembler::push`] produced.
#[derive(Clone, Debug)]
pub enum Reassembled {
    Frame(CompleteFrame),
    /// frames `first..=last` will never be delivered
    Lost { first: u32, last: u32 },
}

/// The frame being assembled.
struct Partial {
    id: u32,
    k: usize,
    m: usize,
    len: usize,
    au_len: usize,
    flags: u8,
    codec: Codec,
    capture_us: u64,
    latency: u16,
    first_us: u64,
    /// k × len bytes; data shard i at i × len
    data: Vec<u8>,
    have: Vec<bool>,
    data_count: usize,
    parity: Vec<(usize, Vec<u8>)>,
    /// an RS decode failed (inconsistent shards): wait for the data shards only
    decode_failed: bool,
}

impl Partial {
    fn new(s: &VideoShard<'_>, now_us: u64) -> Option<Partial> {
        let k = s.data_shards as usize;
        if k > MAX_DATA_SHARDS {
            return None;
        }
        Some(Partial {
            id: s.frame_id,
            k,
            m: s.parity_shards as usize,
            len: s.shard.len(),
            au_len: s.au_len as usize,
            flags: s.flags,
            codec: Codec::from_u8(s.codec)?,
            capture_us: s.capture_us,
            latency: s.sender_latency,
            first_us: now_us,
            data: vec![0; k * s.shard.len()],
            have: vec![false; k + s.parity_shards as usize],
            data_count: 0,
            parity: Vec::new(),
            decode_failed: false,
        })
    }

    /// Same frame layout (a shard of a buggy or hostile sender could claim another one).
    fn matches(&self, s: &VideoShard<'_>) -> bool {
        self.k == s.data_shards as usize && self.m == s.parity_shards as usize && self.au_len == s.au_len as usize && self.len == s.shard.len()
    }

    fn add(&mut self, s: &VideoShard<'_>) {
        let i = s.index as usize;
        if self.have[i] {
            return;
        }
        self.have[i] = true;
        if i < self.k {
            self.data[i * self.len..(i + 1) * self.len].copy_from_slice(s.shard);
            self.data_count += 1;
        } else {
            self.parity.push((i, s.shard.to_vec()));
        }
    }

    /// Some(recovered) once the data is complete (restoring missing data shards from parity when possible).
    fn complete(&mut self) -> Option<bool> {
        if self.data_count == self.k {
            return Some(false);
        }
        if self.m == 0 || self.decode_failed || self.data_count + self.parity.len() < self.k {
            return None;
        }
        let len = self.len;
        let restored = {
            let received: Vec<(usize, &[u8])> = (0..self.k)
                .filter(|&i| self.have[i])
                .map(|i| (i, &self.data[i * len..(i + 1) * len]))
                .chain(self.parity.iter().map(|(i, p)| (*i, p.as_slice())))
                .collect();
            fec::decode(self.k, self.m, &received)
        };
        match restored {
            Ok(shards) => {
                for (i, bytes) in shards {
                    if i < self.k && bytes.len() == len {
                        self.data[i * len..(i + 1) * len].copy_from_slice(&bytes);
                        self.have[i] = true;
                        self.data_count += 1;
                    }
                }
                (self.data_count == self.k).then_some(true)
            }
            Err(_) => {
                self.decode_failed = true;
                None
            }
        }
    }
}

/// Packet accounting over the most recent frames (for the receiver report). A frame's count settles once two
/// newer frames started, so its parity shards that arrive after the frame completed are still counted.
#[derive(Default)]
struct PacketCounts {
    /// (frame id, shards sent = k + m, shards received), oldest first
    recs: VecDeque<(u32, u32, u32)>,
    newest: Option<u32>,
    last_total: u32,
    expected: u32,
    received: u32,
}

impl PacketCounts {
    fn settle(&mut self, (_, total, received): (u32, u32, u32)) {
        self.expected = self.expected.saturating_add(total);
        self.received = self.received.saturating_add(received.min(total));
    }

    fn on_shard(&mut self, id: u32, total: u32) {
        if let Some(n) = self.newest {
            if !newer(id, n) {
                if n.wrapping_sub(id) <= RESYNC_GAP {
                    if let Some(r) = self.recs.iter_mut().rev().find(|r| r.0 == id) {
                        if r.2 == 0 {
                            r.1 = total; // a frame we had given up on: now we know its size
                        }
                        r.2 += 1;
                    }
                    return;
                }
                // the sender restarted its frame ids
                while let Some(r) = self.recs.pop_front() {
                    self.settle(r);
                }
                self.newest = None;
            } else {
                // frames that sent us nothing at all count with the last known size
                let gap = id.wrapping_sub(n).wrapping_sub(1).min(MAX_FRAMES_IN_FLIGHT as u32 * 2);
                for j in 0..gap {
                    self.recs.push_back((n.wrapping_add(1 + j), self.last_total, 0));
                }
            }
        }
        self.recs.push_back((id, total, 1));
        self.newest = Some(id);
        self.last_total = total;
        while self.recs.len() > MAX_FRAMES_IN_FLIGHT * 2 {
            let r = self.recs.pop_front().unwrap();
            self.settle(r);
        }
    }

    fn take(&mut self) -> (u32, u32) {
        if let Some(n) = self.newest {
            while self.recs.front().is_some_and(|r| n.wrapping_sub(r.0) >= 2) {
                let r = self.recs.pop_front().unwrap();
                self.settle(r);
            }
        }
        (std::mem::take(&mut self.expected), std::mem::take(&mut self.received))
    }
}

/// Viewer-side reassembly of one link's video.
pub struct Reassembler {
    cur: Option<Partial>,
    /// next frame id to complete or declare lost (None before the first shard)
    next: Option<u32>,
    /// deltas are held back until a key frame (at the start, after a loss, after [`Self::require_key`])
    need_key: bool,
    /// last frame id of the latest loss (an after-RFI frame newer than this may end `need_key`)
    loss_last: Option<u32>,
    after_loss: bool,
    skipped: u64,
    packets: PacketCounts,
}

impl Default for Reassembler {
    fn default() -> Self {
        Reassembler { cur: None, next: None, need_key: true, loss_last: None, after_loss: false, skipped: 0, packets: PacketCounts::default() }
    }
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one shard (already authenticated). Returns frames to deliver and losses to report, in order.
    pub fn push(&mut self, shard: VideoShard<'_>, now_us: u64) -> Vec<Reassembled> {
        let mut out = Vec::new();
        let id = shard.frame_id;
        self.packets.on_shard(id, shard.data_shards as u32 + shard.parity_shards as u32);
        let next = *self.next.get_or_insert(id);
        if newer(next, id) {
            if next.wrapping_sub(id) <= RESYNC_GAP {
                return out; // a late or redundant shard of a frame that is done or lost
            }
            // far behind: the sender restarted its frame ids; start over from a key frame
            self.cur = None;
            self.require_key();
            self.next = Some(id);
        } else if id != next {
            // a newer frame started: every frame from `next` up to id − 1 stays incomplete for good
            self.cur = None;
            let last = id.wrapping_sub(1);
            out.push(Reassembled::Lost { first: next, last });
            self.need_key = true;
            self.loss_last = Some(last);
            self.after_loss = true;
            self.next = Some(id);
        }
        if self.cur.as_ref().is_some_and(|p| !p.matches(&shard)) {
            return out;
        }
        if self.cur.is_none() {
            match Partial::new(&shard, now_us) {
                Some(p) => self.cur = Some(p),
                None => return out,
            }
        }
        let p = self.cur.as_mut().expect("set above");
        p.add(&shard);
        if let Some(recovered) = p.complete() {
            let p = self.cur.take().expect("set above");
            self.next = Some(id.wrapping_add(1));
            self.deliver(p, recovered, &mut out);
        }
        out
    }

    fn deliver(&mut self, p: Partial, recovered: bool, out: &mut Vec<Reassembled>) {
        if p.flags & vflags::KEY != 0 {
            self.need_key = false;
        } else if self.need_key {
            let rfi_cures = p.flags & vflags::AFTER_RFI != 0 && self.loss_last.is_some_and(|l| newer(p.id, l));
            if !rfi_cures {
                self.skipped += 1;
                return;
            }
            self.need_key = false;
        }
        let mut data = p.data;
        data.truncate(p.au_len);
        out.push(Reassembled::Frame(CompleteFrame {
            frame_id: p.id,
            codec: p.codec,
            flags: p.flags,
            capture_us: p.capture_us,
            sender_latency_us: p.latency as u32 * 100,
            recovered,
            after_loss: std::mem::take(&mut self.after_loss),
            data,
            first_us: p.first_us,
        }));
    }

    /// Holds back delta frames until the next key frame (the receiver dropped frames it had already delivered
    /// here, e.g. its queue to the page overflowed). Only a key frame ends this, never an after-RFI frame.
    pub fn require_key(&mut self) {
        self.need_key = true;
        self.loss_last = None;
        self.after_loss = true;
    }

    /// Complete delta frames held back while waiting for a key frame (total).
    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    /// Packets expected / received since the last call (for the receiver report).
    pub fn take_packet_counts(&mut self) -> (u32, u32) {
        self.packets.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shard_sizes() {
        assert_eq!(data_shard_count(1), 1);
        assert_eq!(data_shard_count(1144), 1);
        assert_eq!(data_shard_count(1145), 2);
        assert_eq!(shard_len(1145, 2), 574);
        assert_eq!(shard_len(3, 1), 4);
        assert_eq!(shard_len(1, 1), 2);
    }

    #[test]
    fn frame_id_order() {
        assert!(newer(2, 1));
        assert!(!newer(1, 2));
        assert!(!newer(5, 5));
        assert!(newer(0, u32::MAX)); // wraps
        assert!(newer(3, u32::MAX - 3));
    }

    pub(crate) fn frame(id: u32, len: usize, key: bool) -> EncodedFrame {
        let mut x = (id as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        let data = (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        EncodedFrame {
            frame_id: id,
            codec: Codec::Hevc,
            key,
            after_invalidation: false,
            repeat: false,
            data,
            capture_us: 1_000 * id as u64,
            encoded_us: 1_000 * id as u64 + 2_345,
            width: 1920,
            height: 1080,
        }
    }

    fn feed(r: &mut Reassembler, shards: &[Vec<u8>], order: impl IntoIterator<Item = usize>) -> Vec<Reassembled> {
        let mut out = Vec::new();
        for i in order {
            out.extend(r.push(VideoShard::parse(&shards[i]).expect("valid shard"), 5));
        }
        out
    }

    fn only_frame(out: Vec<Reassembled>) -> CompleteFrame {
        assert_eq!(out.len(), 1, "{out:?}");
        match out.into_iter().next().unwrap() {
            Reassembled::Frame(f) => f,
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    #[test]
    fn shard_and_reassemble_every_size() {
        for (n, len) in [1usize, 2, 3, 1143, 1144, 1145, 2289, 10_000, 100_000, 900_000].into_iter().enumerate() {
            let f = frame(n as u32 + 1, len, true);
            let shards = shard_frame(&f, fec::FEC_PCT_LAN);
            let k = data_shard_count(len);
            assert_eq!(shards.len(), k + fec::parity_count(k, fec::FEC_PCT_LAN), "len {len}");
            assert!(shards.iter().all(|s| s.len() <= crate::net::wire::MAX_PLAINTEXT));
            let mut r = Reassembler::new();
            let got = only_frame(feed(&mut r, &shards, 0..k));
            assert_eq!(got.data, f.data, "len {len}");
            assert!(!got.recovered && !got.after_loss);
            assert_eq!((got.frame_id, got.codec, got.flags, got.capture_us), (f.frame_id, Codec::Hevc, vflags::KEY, f.capture_us));
            assert_eq!(got.sender_latency_us, 2_300);
            // parity that arrives after completion is ignored
            assert!(feed(&mut r, &shards, k..shards.len()).is_empty());
        }
    }

    #[test]
    fn out_of_order_and_loss_up_to_parity() {
        let f = frame(10, 50_000, true); // k = 44, m = 5 on LAN
        let shards = shard_frame(&f, fec::FEC_PCT_LAN);
        let total = shards.len();
        // reversed order: completes from parity + data before all data shards are in
        let mut r = Reassembler::new();
        let out = feed(&mut r, &shards, (0..total).rev());
        let got = only_frame(out);
        assert_eq!(got.data, f.data);
        assert!(got.recovered);
        // lose exactly m data shards spread over the frame
        let m = total - 44;
        let lost: Vec<usize> = (0..m).map(|i| i * 9).collect();
        let mut r = Reassembler::new();
        let got = only_frame(feed(&mut r, &shards, (0..total).filter(|i| !lost.contains(i))));
        assert_eq!(got.data, f.data);
        assert!(got.recovered);
    }

    #[test]
    fn loss_beyond_parity_is_reported_and_deltas_wait_for_a_key_frame() {
        let mut r = Reassembler::new();
        let key = shard_frame(&frame(1, 20_000, true), fec::FEC_PCT_LAN);
        assert!(matches!(only_frame(feed(&mut r, &key, 0..key.len())).frame_id, 1));
        // frame 2: three of 18 + 2 shards lost (m = 2) → incomplete
        let d2 = shard_frame(&frame(2, 20_000, false), fec::FEC_PCT_LAN);
        assert!(feed(&mut r, &d2, 3..d2.len()).is_empty());
        // frame 3 starts: frame 2 is lost at once, and frame 3 (a delta) is held back
        let d3 = shard_frame(&frame(3, 5_000, false), fec::FEC_PCT_LAN);
        let out = feed(&mut r, &d3, 0..d3.len());
        assert!(matches!(out.as_slice(), [Reassembled::Lost { first: 2, last: 2 }]), "{out:?}");
        assert_eq!(r.skipped(), 1);
        // frames 4 and 5 never arrive at all; frame 6 is a delta: lost 4..=5, 6 held back
        let d6 = shard_frame(&frame(6, 3_000, false), fec::FEC_PCT_LAN);
        let out = feed(&mut r, &d6, 0..d6.len());
        assert!(matches!(out.as_slice(), [Reassembled::Lost { first: 4, last: 5 }]), "{out:?}");
        // the key frame 7 is delivered and marked as the first after the loss; deltas flow again
        let k7 = shard_frame(&frame(7, 30_000, true), fec::FEC_PCT_LAN);
        let got = only_frame(feed(&mut r, &k7, 0..k7.len()));
        assert!(got.frame_id == 7 && got.after_loss);
        let d8 = shard_frame(&frame(8, 1_000, false), fec::FEC_PCT_LAN);
        let got = only_frame(feed(&mut r, &d8, 0..d8.len()));
        assert!(got.frame_id == 8 && !got.after_loss);
        // a late shard of the lost frame 2 changes nothing
        assert!(feed(&mut r, &d2, 0..1).is_empty());
    }

    #[test]
    fn after_rfi_frame_newer_than_the_loss_ends_the_wait() {
        let mut r = Reassembler::new();
        let k1 = shard_frame(&frame(1, 2_000, true), fec::FEC_PCT_LAN);
        only_frame(feed(&mut r, &k1, 0..k1.len()));
        let mut f3 = frame(3, 2_000, false);
        f3.after_invalidation = true;
        let s3 = shard_frame(&f3, fec::FEC_PCT_LAN);
        let out = feed(&mut r, &s3, 0..s3.len());
        assert!(matches!(&out[..], [Reassembled::Lost { first: 2, last: 2 }, Reassembled::Frame(f)] if f.frame_id == 3 && f.after_loss));
        // require_key (receiver queue dropped) is only cured by a real key frame
        r.require_key();
        let mut f4 = frame(4, 2_000, false);
        f4.after_invalidation = true;
        let s4 = shard_frame(&f4, fec::FEC_PCT_LAN);
        assert!(feed(&mut r, &s4, 0..s4.len()).is_empty());
        let k5 = shard_frame(&frame(5, 2_000, true), fec::FEC_PCT_LAN);
        assert!(only_frame(feed(&mut r, &k5, 0..k5.len())).after_loss);
    }

    #[test]
    fn deltas_before_the_first_key_frame_are_held_back() {
        let mut r = Reassembler::new();
        let d = shard_frame(&frame(41, 2_000, false), fec::FEC_PCT_LAN);
        assert!(feed(&mut r, &d, 0..d.len()).is_empty());
        assert_eq!(r.skipped(), 1);
        let k = shard_frame(&frame(42, 2_000, true), fec::FEC_PCT_LAN);
        assert_eq!(only_frame(feed(&mut r, &k, 0..k.len())).frame_id, 42);
    }

    #[test]
    fn frame_ids_wrap_and_restart() {
        let mut r = Reassembler::new();
        for (id, key) in [(u32::MAX - 1, true), (u32::MAX, false), (0, false), (1, false)] {
            let s = shard_frame(&frame(id, 3_000, key), fec::FEC_PCT_LAN);
            assert_eq!(only_frame(feed(&mut r, &s, 0..s.len())).frame_id, id);
        }
        // a sender that restarted at 1 000 000 frames earlier: starts over at its key frame, no bogus loss
        let s = shard_frame(&frame(5_000, 3_000, true), fec::FEC_PCT_LAN);
        let mut r2 = Reassembler::new();
        only_frame(feed(&mut r2, &s, 0..s.len()));
        let s = shard_frame(&frame(3, 3_000, true), fec::FEC_PCT_LAN);
        assert_eq!(only_frame(feed(&mut r2, &s, 0..s.len())).frame_id, 3);
    }

    #[test]
    fn packet_counts_settle_after_two_newer_frames() {
        let mut r = Reassembler::new();
        let mut sent = 0u32;
        for id in 1..=5u32 {
            let s = shard_frame(&frame(id, 10_000, id == 1), fec::FEC_PCT_LAN);
            sent += s.len() as u32;
            // frame 3 loses one shard (recovered by FEC)
            let order: Vec<usize> = (0..s.len()).filter(|&i| !(id == 3 && i == 4)).collect();
            feed(&mut r, &s, order);
        }
        // frames 1..=3 have settled; 4 and 5 are still open
        let per_frame = sent / 5;
        assert_eq!(r.take_packet_counts(), (3 * per_frame, 3 * per_frame - 1));
        assert_eq!(r.take_packet_counts(), (0, 0));
        // a frame that sent nothing at all counts with the last known size
        for id in [6u32, 8, 9, 10] {
            let s = shard_frame(&frame(id, 10_000, false), fec::FEC_PCT_LAN);
            feed(&mut r, &s, 0..s.len());
        }
        let (expected, received) = r.take_packet_counts();
        assert_eq!(expected - received, per_frame); // frame 7
        assert_eq!(expected, 5 * per_frame); // 4, 5, 6, 7, 8 settled
    }
}

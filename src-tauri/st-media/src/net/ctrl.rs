//! Control messages (docs/NATIVE-PATH.md §6.4). Plaintext of a `Kind::Ctrl` datagram:
//!
//! ```text
//! [0] u8 type   [1..5] u32 reliable seq (0 = unreliable)   [5..] body (big-endian)
//! 1 Ping      u64 t1                                    every 200 ms, both directions (RTT, clock offset)
//! 2 Pong      u64 t1, u64 t2 (ping received), u64 t3 (pong sent)
//! 3 Ack       u32 seq                                   for every reliable message, immediately
//! 4 FrameLost u32 first, u32 last                       viewer → sharer; repeated until a recovery frame arrives
//! 5 Keyframe  —                                         viewer → sharer (decoder error / start); repeated likewise
//! 6 Report    u32 frames, u32 recovered, u32 lost, u32 packets expected, u32 packets received, u32 kbps,
//!             i32 delay trend µs/s                      viewer → sharer every 200 ms (rate control, stats)
//! 7 App       u16 length, UTF-8 text (≤ 1000 bytes)     reliable, in order: the existing CtlMessage JSON
//! 8 Bye       u8 reason (0 closed, 1 kicked, 2 ended)   sent 3× 20 ms apart, no ack
//! ```
//! Reliable messages are retransmitted every max(2 × RTT, 20 ms) until acked; after 5 s without an ack the link
//! is dead. Receivers deliver App messages in seq order and drop duplicates.

use std::collections::{BTreeMap, VecDeque};

use crate::net::frame::newer;
use crate::net::wire::{be16, be32, be64};

/// Longest App text.
pub const MAX_APP_TEXT: usize = 1000;
/// Interval of Ping and of the receiver report (ms).
pub const PING_MS: u64 = 200;
/// A reliable message unacked for this long kills the link (ms).
pub const RELIABLE_TIMEOUT_MS: u64 = 5000;

/// Why a link was closed (Bye reason byte).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ByeReason {
    Closed = 0,
    Kicked = 1,
    Ended = 2,
}

/// Viewer → sharer report (every [`PING_MS`]); counts are over the interval since the last report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReceiverReport {
    pub frames: u32,
    pub recovered: u32,
    pub lost: u32,
    pub packets_expected: u32,
    pub packets_received: u32,
    pub kbps: u32,
    /// one-way delay trend (µs per second); > 0 = a queue is building up
    pub delay_trend_us: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ctrl {
    Ping { t1: u64 },
    Pong { t1: u64, t2: u64, t3: u64 },
    Ack { seq: u32 },
    FrameLost { first: u32, last: u32 },
    Keyframe,
    Report(ReceiverReport),
    App(String),
    Bye(ByeReason),
}

/// Shortest retransmit interval of a reliable message (ms).
pub const RETRANSMIT_MIN_MS: u64 = 20;
/// Reliable messages queued but not yet acknowledged, at most.
pub const MAX_UNACKED: usize = 256;
/// Out-of-order reliable messages held back, at most (and how far ahead a seq may be).
const MAX_HELD: u32 = 256;

mod ty {
    pub const PING: u8 = 1;
    pub const PONG: u8 = 2;
    pub const ACK: u8 = 3;
    pub const FRAME_LOST: u8 = 4;
    pub const KEYFRAME: u8 = 5;
    pub const REPORT: u8 = 6;
    pub const APP: u8 = 7;
    pub const BYE: u8 = 8;
}

impl ByeReason {
    pub fn from_u8(v: u8) -> Option<ByeReason> {
        match v {
            0 => Some(ByeReason::Closed),
            1 => Some(ByeReason::Kicked),
            2 => Some(ByeReason::Ended),
            _ => None,
        }
    }
}

/// Encodes `msg` with reliable sequence number `seq` (0 for unreliable types).
pub fn encode(msg: &Ctrl, seq: u32, out: &mut Vec<u8>) {
    let t = match msg {
        Ctrl::Ping { .. } => ty::PING,
        Ctrl::Pong { .. } => ty::PONG,
        Ctrl::Ack { .. } => ty::ACK,
        Ctrl::FrameLost { .. } => ty::FRAME_LOST,
        Ctrl::Keyframe => ty::KEYFRAME,
        Ctrl::Report(_) => ty::REPORT,
        Ctrl::App(_) => ty::APP,
        Ctrl::Bye(_) => ty::BYE,
    };
    out.push(t);
    out.extend_from_slice(&seq.to_be_bytes());
    match msg {
        Ctrl::Ping { t1 } => out.extend_from_slice(&t1.to_be_bytes()),
        Ctrl::Pong { t1, t2, t3 } => {
            for t in [t1, t2, t3] {
                out.extend_from_slice(&t.to_be_bytes());
            }
        }
        Ctrl::Ack { seq } => out.extend_from_slice(&seq.to_be_bytes()),
        Ctrl::FrameLost { first, last } => {
            out.extend_from_slice(&first.to_be_bytes());
            out.extend_from_slice(&last.to_be_bytes());
        }
        Ctrl::Keyframe => {}
        Ctrl::Report(r) => {
            for v in [r.frames, r.recovered, r.lost, r.packets_expected, r.packets_received, r.kbps] {
                out.extend_from_slice(&v.to_be_bytes());
            }
            out.extend_from_slice(&r.delay_trend_us.to_be_bytes());
        }
        Ctrl::App(text) => {
            // longer texts are refused by Link::send_message; cut defensively at a char boundary
            let mut n = text.len().min(MAX_APP_TEXT);
            while !text.is_char_boundary(n) {
                n -= 1;
            }
            out.extend_from_slice(&(n as u16).to_be_bytes());
            out.extend_from_slice(&text.as_bytes()[..n]);
        }
        Ctrl::Bye(r) => out.push(*r as u8),
    }
}

/// (message, reliable seq) or None if malformed.
pub fn decode(b: &[u8]) -> Option<(Ctrl, u32)> {
    if b.len() < 5 {
        return None;
    }
    let seq = be32(b, 1);
    let body = &b[5..];
    let need = |n: usize| (body.len() >= n).then_some(());
    let msg = match b[0] {
        ty::PING => {
            need(8)?;
            Ctrl::Ping { t1: be64(body, 0) }
        }
        ty::PONG => {
            need(24)?;
            Ctrl::Pong { t1: be64(body, 0), t2: be64(body, 8), t3: be64(body, 16) }
        }
        ty::ACK => {
            need(4)?;
            Ctrl::Ack { seq: be32(body, 0) }
        }
        ty::FRAME_LOST => {
            need(8)?;
            Ctrl::FrameLost { first: be32(body, 0), last: be32(body, 4) }
        }
        ty::KEYFRAME => Ctrl::Keyframe,
        ty::REPORT => {
            need(28)?;
            Ctrl::Report(ReceiverReport {
                frames: be32(body, 0),
                recovered: be32(body, 4),
                lost: be32(body, 8),
                packets_expected: be32(body, 12),
                packets_received: be32(body, 16),
                kbps: be32(body, 20),
                delay_trend_us: be32(body, 24) as i32,
            })
        }
        ty::APP => {
            need(2)?;
            let n = be16(body, 0) as usize;
            if n > MAX_APP_TEXT || body.len() < 2 + n {
                return None;
            }
            Ctrl::App(std::str::from_utf8(&body[2..2 + n]).ok()?.to_string())
        }
        ty::BYE => {
            need(1)?;
            Ctrl::Bye(ByeReason::from_u8(body[0])?)
        }
        _ => return None,
    };
    Some((msg, seq))
}

/// One App message waiting for its ack.
struct Unacked {
    seq: u32,
    text: String,
    /// first transmission (None = not sent yet, the link is not up)
    first_us: Option<u64>,
    next_us: u64,
}

/// Reliable, ordered delivery of App messages over one link (both directions).
pub struct Reliable {
    // sending
    next_seq: u32,
    unacked: VecDeque<Unacked>,
    // receiving
    expected: u32,
    held: BTreeMap<u32, String>,
}

impl Default for Reliable {
    fn default() -> Self {
        Reliable { next_seq: 1, unacked: VecDeque::new(), expected: 1, held: BTreeMap::new() }
    }
}

fn next_seq(seq: u32) -> u32 {
    match seq.wrapping_add(1) {
        0 => 1, // 0 means "unreliable"
        s => s,
    }
}

impl Reliable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues an App text; returns its seq.
    pub fn send(&mut self, text: String, now_us: u64) -> u32 {
        let seq = self.next_seq;
        self.next_seq = next_seq(seq);
        self.unacked.push_back(Unacked { seq, text, first_us: None, next_us: now_us });
        seq
    }

    /// Messages waiting for an ack.
    pub fn pending(&self) -> usize {
        self.unacked.len()
    }

    /// Messages to (re)transmit now as (seq, message).
    pub fn due(&mut self, now_us: u64, rtt_us: u64) -> Vec<(u32, Ctrl)> {
        let every = (2 * rtt_us).max(RETRANSMIT_MIN_MS * 1000);
        let mut out = Vec::new();
        for u in self.unacked.iter_mut().filter(|u| u.next_us <= now_us) {
            u.first_us.get_or_insert(now_us);
            u.next_us = now_us + every;
            out.push((u.seq, Ctrl::App(u.text.clone())));
        }
        out
    }

    pub fn on_ack(&mut self, seq: u32) {
        self.unacked.retain(|u| u.seq != seq);
    }

    /// An incoming reliable message; returns the texts now deliverable in order (duplicates dropped).
    pub fn on_receive(&mut self, seq: u32, msg: Ctrl) -> Vec<String> {
        let Ctrl::App(text) = msg else { return Vec::new() };
        if seq == 0 || (seq != self.expected && !newer(seq, self.expected)) {
            return Vec::new(); // a duplicate of something already delivered
        }
        if seq.wrapping_sub(self.expected) >= MAX_HELD {
            return Vec::new(); // too far ahead: the sender retransmits it later
        }
        self.held.entry(seq).or_insert(text);
        let mut out = Vec::new();
        while let Some(t) = self.held.remove(&self.expected) {
            out.push(t);
            self.expected = next_seq(self.expected);
        }
        out
    }

    /// true once a message stayed unacked for [`RELIABLE_TIMEOUT_MS`]
    pub fn dead(&self, now_us: u64) -> bool {
        self.unacked.iter().any(|u| u.first_us.is_some_and(|t| now_us.saturating_sub(t) >= RELIABLE_TIMEOUT_MS * 1000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_every_type() {
        let msgs = [
            (Ctrl::Ping { t1: 1 << 40 }, 0),
            (Ctrl::Pong { t1: 1, t2: u64::MAX, t3: 3 }, 0),
            (Ctrl::Ack { seq: 0xdead_beef }, 0),
            (Ctrl::FrameLost { first: u32::MAX, last: 2 }, 0),
            (Ctrl::Keyframe, 0),
            (
                Ctrl::Report(ReceiverReport {
                    frames: 60,
                    recovered: 2,
                    lost: 1,
                    packets_expected: 3000,
                    packets_received: 2990,
                    kbps: 40_000,
                    delay_trend_us: -1234,
                }),
                0,
            ),
            (Ctrl::App("{\"t\":\"hello\",\"name\":\"Jörg\"}".into()), 17),
            (Ctrl::App(String::new()), 1),
            (Ctrl::Bye(ByeReason::Kicked), 0),
        ];
        for (m, seq) in msgs {
            let mut b = Vec::new();
            encode(&m, seq, &mut b);
            assert!(b.len() <= crate::net::wire::MAX_PLAINTEXT);
            assert_eq!(decode(&b), Some((m.clone(), seq)));
            // every truncation is rejected (except for Keyframe, which has no body)
            if m != Ctrl::Keyframe {
                assert_eq!(decode(&b[..b.len() - 1]), None, "{m:?}");
            }
        }
        assert_eq!(decode(&[9, 0, 0, 0, 0]), None);
        assert_eq!(decode(&[ty::BYE, 0, 0, 0, 0, 7]), None);
        // invalid UTF-8 and over-long texts
        assert_eq!(decode(&[ty::APP, 0, 0, 0, 1, 0, 2, 0xc3, 0x28]), None);
        let mut long = vec![ty::APP, 0, 0, 0, 1];
        long.extend_from_slice(&1001u16.to_be_bytes());
        long.extend(std::iter::repeat_n(b'a', 1001));
        assert_eq!(decode(&long), None);
        // the longest text fits one datagram
        let mut b = Vec::new();
        encode(&Ctrl::App("ü".repeat(600)), 5, &mut b); // 1200 bytes of UTF-8, cut to 1000 at a char boundary
        let (Ctrl::App(t), 5) = decode(&b).unwrap() else { panic!() };
        assert_eq!(t.len(), 1000);
    }

    #[test]
    fn reliable_retransmits_until_acked() {
        let mut r = Reliable::new();
        assert_eq!(r.send("a".into(), 0), 1);
        assert_eq!(r.send("b".into(), 0), 2);
        assert_eq!(r.due(0, 1_000).len(), 2);
        assert!(r.due(10_000, 1_000).is_empty()); // 20 ms minimum interval
        assert_eq!(r.due(20_000, 1_000).len(), 2);
        r.on_ack(1);
        let again = r.due(40_000, 1_000);
        assert_eq!(again, vec![(2, Ctrl::App("b".into()))]);
        // a long RTT stretches the interval to 2 × RTT
        assert!(r.due(80_000, 50_000).len() == 1);
        assert!(r.due(150_000, 50_000).is_empty());
        assert!(r.due(180_000, 50_000).len() == 1);
        assert!(!r.dead(4_000_000));
        assert!(r.dead(5_000_000)); // first sent at 0
        r.on_ack(2);
        assert!(!r.dead(9_000_000));
        // queued before the link is up: the 5 s count from the first transmission
        r.send("c".into(), 1_000_000);
        assert!(!r.dead(7_000_000));
        assert_eq!(r.due(7_000_000, 0).len(), 1);
        assert!(!r.dead(11_000_000));
        assert!(r.dead(12_000_000));
    }

    #[test]
    fn reliable_orders_and_drops_duplicates() {
        let mut r = Reliable::new();
        let app = |s: &str| Ctrl::App(s.into());
        assert_eq!(r.on_receive(2, app("two")), Vec::<String>::new());
        assert_eq!(r.on_receive(3, app("three")), Vec::<String>::new());
        assert_eq!(r.on_receive(2, app("two again")), Vec::<String>::new());
        assert_eq!(r.on_receive(1, app("one")), vec!["one", "two", "three"]);
        assert_eq!(r.on_receive(1, app("one")), Vec::<String>::new());
        assert_eq!(r.on_receive(3, app("three")), Vec::<String>::new());
        assert_eq!(r.on_receive(4, app("four")), vec!["four"]);
        assert_eq!(r.on_receive(0, app("unreliable")), Vec::<String>::new());
        assert_eq!(r.on_receive(5 + MAX_HELD, app("far ahead")), Vec::<String>::new());
        assert_eq!(r.on_receive(5, Ctrl::Keyframe), Vec::<String>::new());
    }
}

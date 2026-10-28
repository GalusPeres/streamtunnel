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
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

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

/// Encodes `msg` with reliable sequence number `seq` (0 for unreliable types).
pub fn encode(msg: &Ctrl, seq: u32, out: &mut Vec<u8>) {
    todo!("NET")
}

/// (message, reliable seq) or None if malformed.
pub fn decode(b: &[u8]) -> Option<(Ctrl, u32)> {
    todo!("NET")
}

/// Reliable, ordered delivery of App messages over one link (both directions).
#[derive(Default)]
pub struct Reliable {
    // filled by NET
}

impl Reliable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues an App text; returns its seq.
    pub fn send(&mut self, text: String, now_us: u64) -> u32 {
        todo!("NET")
    }

    /// Messages to (re)transmit now as (seq, message).
    pub fn due(&mut self, now_us: u64, rtt_us: u64) -> Vec<(u32, Ctrl)> {
        todo!("NET")
    }

    pub fn on_ack(&mut self, seq: u32) {
        todo!("NET")
    }

    /// An incoming reliable message; returns the texts now deliverable in order (duplicates dropped).
    pub fn on_receive(&mut self, seq: u32, msg: Ctrl) -> Vec<String> {
        todo!("NET")
    }

    /// true once a message stayed unacked for [`RELIABLE_TIMEOUT_MS`]
    pub fn dead(&self, now_us: u64) -> bool {
        todo!("NET")
    }
}

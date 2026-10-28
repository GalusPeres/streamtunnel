//! Clocks: one monotonic µs clock for the whole process (capture, encode, network, stats all use it) and the
//! NTP-style offset to the peer's clock (ping/pong with a min-RTT filter), so a frame's sender capture time can be
//! mapped to our clock ("capture → shown" latency without synchronized wall clocks).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Monotonic µs since the first call in this process. Never goes backwards; shared by every module.
pub fn now_us() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// Wall clock in µs since the UNIX epoch (only for the page's IPC-delay estimate; never for media timing).
pub fn epoch_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// Samples kept for the min-RTT filter (≈ 6 s at one ping per 200 ms).
pub const SYNC_WINDOW: usize = 32;

/// Offset of the peer's [`now_us`] clock relative to ours, from ping/pong exchanges.
///
/// For one exchange: t1 = our send, t2 = peer receive, t3 = peer send, t4 = our receive.
/// rtt = (t4 − t1) − (t3 − t2); offset = ((t2 − t1) + (t3 − t4)) / 2 (peer − us).
/// The offset of the sample with the smallest RTT in the last [`SYNC_WINDOW`] samples wins (queueing only ever
/// adds delay, so the fastest exchange is the most symmetric one).
#[derive(Debug, Default)]
pub struct ClockSync {
    // filled by NET
}

impl ClockSync {
    pub fn new() -> Self {
        Self::default()
    }

    /// One completed ping/pong exchange (all four times in µs, t1/t4 ours, t2/t3 the peer's).
    pub fn on_pong(&mut self, t1: u64, t2: u64, t3: u64, t4: u64) {
        todo!("NET: push sample, keep SYNC_WINDOW, pick min-RTT sample")
    }

    /// Latest round-trip time (µs), None before the first pong.
    pub fn rtt_us(&self) -> Option<u64> {
        todo!("NET")
    }

    /// Smallest RTT in the window (µs) — the path's base RTT.
    pub fn min_rtt_us(&self) -> Option<u64> {
        todo!("NET")
    }

    /// Peer clock − our clock (µs), None before the first pong.
    pub fn offset_us(&self) -> Option<i64> {
        todo!("NET")
    }

    /// A time on the peer's clock mapped to ours, None before the first pong.
    pub fn to_local(&self, peer_us: u64) -> Option<u64> {
        todo!("NET")
    }
}

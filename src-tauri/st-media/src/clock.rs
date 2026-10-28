//! Clocks: one monotonic µs clock for the whole process (capture, encode, network, stats all use it) and the
//! NTP-style offset to the peer's clock (ping/pong with a min-RTT filter), so a frame's sender capture time can be
//! mapped to our clock ("capture → shown" latency without synchronized wall clocks).

use std::collections::VecDeque;
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
    /// (rtt µs, offset µs) of the last exchanges, oldest first
    samples: VecDeque<(u64, i64)>,
}

impl ClockSync {
    pub fn new() -> Self {
        Self::default()
    }

    /// One completed ping/pong exchange (all four times in µs, t1/t4 ours, t2/t3 the peer's).
    pub fn on_pong(&mut self, t1: u64, t2: u64, t3: u64, t4: u64) {
        if t4 < t1 || t3 < t2 {
            return; // not an exchange of ours (or a peer clock that ran backwards): ignore
        }
        let rtt = (t4 - t1).saturating_sub(t3 - t2);
        let offset = ((t2 as i128 - t1 as i128) + (t3 as i128 - t4 as i128)) / 2;
        self.samples.push_back((rtt, offset.clamp(i64::MIN as i128, i64::MAX as i128) as i64));
        while self.samples.len() > SYNC_WINDOW {
            self.samples.pop_front();
        }
    }

    /// Latest round-trip time (µs), None before the first pong.
    pub fn rtt_us(&self) -> Option<u64> {
        self.samples.back().map(|s| s.0)
    }

    /// Smallest RTT in the window (µs) — the path's base RTT.
    pub fn min_rtt_us(&self) -> Option<u64> {
        self.samples.iter().map(|s| s.0).min()
    }

    /// Peer clock − our clock (µs), None before the first pong.
    pub fn offset_us(&self) -> Option<i64> {
        // the newest of equally fast samples: follows a slow drift of the two clocks
        let mut best: Option<(u64, i64)> = None;
        for &(rtt, offset) in &self.samples {
            if best.is_none_or(|b| rtt <= b.0) {
                best = Some((rtt, offset));
            }
        }
        best.map(|b| b.1)
    }

    /// A time on the peer's clock mapped to ours, None before the first pong.
    pub fn to_local(&self, peer_us: u64) -> Option<u64> {
        let offset = self.offset_us()?;
        Some((peer_us as i128 - offset as i128).clamp(0, u64::MAX as i128) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_until_first_pong() {
        let c = ClockSync::new();
        assert_eq!(c.rtt_us(), None);
        assert_eq!(c.offset_us(), None);
        assert_eq!(c.to_local(5), None);
    }

    /// The peer's clock runs 1 s ahead. Exchanges with asymmetric queueing in either direction must not win
    /// over the one symmetric, fastest exchange.
    #[test]
    fn min_rtt_sample_wins_with_asymmetric_delays() {
        const OFFSET: i64 = 1_000_000;
        let mut c = ClockSync::new();
        let mut t = 10_000u64;
        // (delay there, peer hold, delay back)
        let exchanges = [(5_000, 100, 300), (300, 50, 4_000), (400, 80, 400), (2_000, 100, 2_500), (350, 2_000, 9_000)];
        for (there, hold, back) in exchanges {
            let t1 = t;
            let t2 = (t1 as i64 + there + OFFSET) as u64;
            let t3 = t2 + hold;
            let t4 = (t3 as i64 - OFFSET + back) as u64;
            c.on_pong(t1, t2, t3, t4);
            t += 200_000;
        }
        // the third exchange: 400 µs each way, rtt 800 µs, exact offset
        assert_eq!(c.min_rtt_us(), Some(800));
        assert_eq!(c.offset_us(), Some(OFFSET));
        assert_eq!(c.rtt_us(), Some(350 + 9_000));
        assert_eq!(c.to_local(2_000_000), Some(1_000_000));
        // peer times before our process start clamp to 0
        assert_eq!(c.to_local(10), Some(0));
    }

    #[test]
    fn window_forgets_old_samples() {
        let mut c = ClockSync::new();
        c.on_pong(0, 100, 100, 200); // rtt 200, offset 0
        for i in 0..SYNC_WINDOW as u64 {
            let t1 = 1_000_000 + i * 1000;
            c.on_pong(t1, t1 + 5_500, t1 + 5_500, t1 + 1_000); // rtt 1000, offset 5000
        }
        assert_eq!(c.min_rtt_us(), Some(1_000));
        assert_eq!(c.offset_us(), Some(5_000));
        // nonsense exchanges are ignored
        c.on_pong(100, 0, 0, 50);
        assert_eq!(c.rtt_us(), Some(1_000));
    }
}

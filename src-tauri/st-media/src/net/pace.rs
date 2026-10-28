//! Sender pacing (docs/NATIVE-PATH.md §6.3): a token bucket per link, released in 1 ms groups, so a large frame
//! leaves as a short train instead of one burst that overflows switch / Wi-Fi buffers.
//! "lan" links pace at 800 Mbit/s, every other link at 3 × the video target (at least 20 Mbit/s).

/// Pacing rate of a "lan" link (bit/s).
pub const LAN_PACE_BPS: u64 = 800_000_000;
/// Other links pace at this multiple of the video target.
pub const WAN_PACE_FACTOR: u64 = 3;
/// Lower bound for non-LAN links (bit/s).
pub const MIN_PACE_BPS: u64 = 20_000_000;
/// Size of one release group (µs of tokens).
pub const GROUP_US: u64 = 1000;

/// Pacing rate for a link (bit/s).
pub fn pace_bps(lan: bool, target_kbps: u32) -> u64 {
    if lan {
        LAN_PACE_BPS
    } else {
        (target_kbps as u64 * 1000 * WAN_PACE_FACTOR).max(MIN_PACE_BPS)
    }
}

/// Token bucket: `GROUP_US` worth of burst, refilled continuously.
pub struct Pacer {
    rate_bps: u64,
    /// bytes that may leave now (≤ one group)
    tokens: f64,
    /// None until the first `take` (the bucket starts full)
    last_us: Option<u64>,
}

impl Pacer {
    pub fn new(rate_bps: u64) -> Self {
        let mut p = Pacer { rate_bps: 1, tokens: 0.0, last_us: None };
        p.set_rate(rate_bps);
        p.tokens = p.capacity();
        p
    }

    /// Bytes of one release group at the current rate.
    fn capacity(&self) -> f64 {
        self.rate_bps as f64 * GROUP_US as f64 / 8e6
    }

    pub fn set_rate(&mut self, rate_bps: u64) {
        self.rate_bps = rate_bps.max(8_000);
        self.tokens = self.tokens.min(self.capacity());
    }

    pub fn rate_bps(&self) -> u64 {
        self.rate_bps
    }

    /// Takes tokens for a datagram of `bytes` if available (returns 0), else returns the µs to wait (nothing taken).
    pub fn take(&mut self, now_us: u64, bytes: usize) -> u64 {
        let cap = self.capacity();
        if let Some(last) = self.last_us {
            let elapsed = now_us.saturating_sub(last) as f64;
            self.tokens = (self.tokens + elapsed * self.rate_bps as f64 / 8e6).min(cap);
        }
        self.last_us = Some(now_us.max(self.last_us.unwrap_or(0)));
        let need = bytes as f64;
        // a datagram larger than a whole group may leave once the bucket is full (the bucket then goes negative)
        if self.tokens >= need || self.tokens >= cap {
            self.tokens -= need;
            return 0;
        }
        (((need.min(cap) - self.tokens) * 8e6 / self.rate_bps as f64).ceil() as u64).max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pace_rates() {
        assert_eq!(pace_bps(true, 20_000), LAN_PACE_BPS);
        assert_eq!(pace_bps(false, 20_000), 60_000_000);
        assert_eq!(pace_bps(false, 3_000), MIN_PACE_BPS);
    }

    /// 8 Mbit/s = 1000 bytes per ms: one group of 1000 bytes, then datagrams leave as the tokens come back.
    #[test]
    fn bucket_timing() {
        let mut p = Pacer::new(8_000_000);
        assert_eq!(p.take(10_000, 600), 0);
        assert_eq!(p.take(10_000, 400), 0); // the full group of 1000 bytes went out at once
        assert_eq!(p.take(10_000, 500), 500); // 500 bytes = 500 µs of tokens
        assert_eq!(p.take(10_250, 500), 250); // nothing was taken by the refused call
        assert_eq!(p.take(10_500, 500), 0);
        // idle time refills only up to one group
        assert_eq!(p.take(1_000_000, 1000), 0);
        assert_eq!(p.take(1_000_000, 1), 1);
        // a datagram bigger than a group leaves when the bucket is full
        let mut small = Pacer::new(8_000);
        assert_eq!(small.take(0, 1200), 0);
        assert!(small.take(0, 1200) > 0);
    }

    /// Over a long run the pacer sends at its rate: 100 Mbit/s for 100 ms ≈ 1.25 MB.
    #[test]
    fn long_run_rate() {
        let mut p = Pacer::new(100_000_000);
        let (mut now, mut sent) = (0u64, 0usize);
        while now < 100_000 {
            let w = p.take(now, 1200);
            if w == 0 {
                sent += 1200;
            } else {
                now += w;
            }
        }
        let expected = 100_000_000 / 8 / 10;
        assert!(sent.abs_diff(expected) < 15_000, "sent {sent}, expected ≈ {expected}");
        // a rate change applies at once and caps the burst
        p.set_rate(LAN_PACE_BPS);
        assert_eq!(p.rate_bps(), LAN_PACE_BPS);
    }
}

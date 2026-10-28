//! Sender pacing (docs/NATIVE-PATH.md §6.3): a token bucket per link, released in 1 ms groups, so a large frame
//! leaves as a short train instead of one burst that overflows switch / Wi-Fi buffers.
//! "lan" links pace at 800 Mbit/s, every other link at 3 × the video target (at least 20 Mbit/s).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

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
    // filled by NET
}

impl Pacer {
    pub fn new(rate_bps: u64) -> Self {
        todo!("NET")
    }

    pub fn set_rate(&mut self, rate_bps: u64) {
        todo!("NET")
    }

    /// Takes tokens for a datagram of `bytes` if available (returns 0), else returns the µs to wait (nothing taken).
    pub fn take(&mut self, now_us: u64, bytes: usize) -> u64 {
        todo!("NET")
    }
}

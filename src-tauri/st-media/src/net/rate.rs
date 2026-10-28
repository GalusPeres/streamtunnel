//! Video bitrate (docs/NATIVE-PATH.md §6.5). Resolution and fps are FIXED; only the bitrate may change.
//! * a bitrate the user set by hand (`settings.stream.bitrateKbps` > 0) never changes, on every link;
//! * "Auto" = the LAN model of `src/rtc/defaults.ts` (`effectiveBitrateKbps(…, lan = true)`), ported 1:1 in
//!   [`lan_bitrate_kbps`]; on loss / queueing it backs off and recovers ([`RateCtl`]).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use crate::Codec;

/// Upper clamp of the LAN model (kbit/s) — `LAN_BITRATE_MAX_KBPS` in defaults.ts.
pub const LAN_BITRATE_MAX_KBPS: u32 = 100_000;
/// Lower clamp of the LAN model (kbit/s).
pub const LAN_BITRATE_MIN_KBPS: u32 = 3_000;

/// The automatic rate: 20 Mbit/s × (pixels ÷ 1080p) × (fps / 60)^0.7, × 1.5 for H.264, clamped to
/// 3000..=100000 and rounded to 100 kbit/s. Must stay identical to `effectiveBitrateKbps(…, lan = true)`.
pub fn lan_bitrate_kbps(width: u32, height: u32, fps: u32, codec: Codec) -> u32 {
    let factor = if codec == Codec::H264 { 1.5 } else { 1.0 };
    let kbps = 20_000.0 * ((width as f64 * height as f64) / (1920.0 * 1080.0)) * (fps.max(1) as f64 / 60.0).powf(0.7) * factor;
    let clamped = kbps.clamp(LAN_BITRATE_MIN_KBPS as f64, LAN_BITRATE_MAX_KBPS as f64);
    ((clamped / 100.0).round() * 100.0) as u32
}

/// Back-off when post-FEC frame loss over the last second exceeds this (%).
pub const BACKOFF_LOSS_PCT: f32 = 2.0;
/// … or the one-way delay keeps rising faster than this for [`BACKOFF_TREND_MS`] (µs per second).
pub const BACKOFF_TREND_US_PER_S: i32 = 2_000;
pub const BACKOFF_TREND_MS: u64 = 1_000;
/// One back-off step multiplies the rate by this.
pub const BACKOFF_FACTOR: f32 = 0.8;
/// Recovery: + this share of the target per second.
pub const RECOVER_PER_S: f32 = 0.05;
/// Never below this share of the target.
pub const FLOOR_FACTOR: f32 = 0.5;
/// At most one encoder reconfigure per this many ms.
pub const MIN_CHANGE_MS: u64 = 500;

/// Rate state of one encoder (the minimum over its links' reports). `fixed` = the user's own value: never moves.
pub struct RateCtl {
    // filled by NET
}

impl RateCtl {
    pub fn new(target_kbps: u32, fixed: bool) -> Self {
        todo!("NET")
    }

    /// New target from settings (user changed the bitrate, or Auto with a new size).
    pub fn set_target(&mut self, target_kbps: u32, fixed: bool) {
        todo!("NET")
    }

    /// Current rate (kbit/s).
    pub fn current_kbps(&self) -> u32 {
        todo!("NET")
    }

    /// Feeds one receiver report; returns Some(new kbps) when the encoder must be reconfigured now.
    pub fn on_report(&mut self, now_us: u64, report: &crate::net::ctrl::ReceiverReport) -> Option<u32> {
        todo!("NET")
    }

    /// Called every 100 ms without reports too (recovery); Some(new kbps) when the encoder must change.
    pub fn tick(&mut self, now_us: u64) -> Option<u32> {
        todo!("NET")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same numbers `effectiveBitrateKbps(…, lan = true)` gives (tests/rtc-pure.test.ts keeps the TS side).
    #[test]
    fn lan_model_matches_defaults_ts() {
        assert_eq!(lan_bitrate_kbps(1920, 1080, 60, Codec::Hevc), 20_000);
        assert_eq!(lan_bitrate_kbps(1920, 1080, 60, Codec::H264), 30_000);
        assert_eq!(lan_bitrate_kbps(2560, 1440, 60, Codec::Hevc), 35_600);
        assert_eq!(lan_bitrate_kbps(2560, 1440, 60, Codec::H264), 53_300);
        assert_eq!(lan_bitrate_kbps(2560, 1440, 120, Codec::Hevc), 57_800);
        assert_eq!(lan_bitrate_kbps(3840, 2160, 60, Codec::Hevc), 80_000);
        assert_eq!(lan_bitrate_kbps(3840, 2160, 60, Codec::H264), 100_000);
        assert_eq!(lan_bitrate_kbps(1280, 720, 30, Codec::Hevc), 5_500);
        assert_eq!(lan_bitrate_kbps(640, 360, 30, Codec::H264), 3_000);
    }
}

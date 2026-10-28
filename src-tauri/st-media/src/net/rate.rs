//! Video bitrate (docs/NATIVE-PATH.md §6.5). Resolution and fps are FIXED; only the bitrate may change.
//! * a bitrate the user set by hand (`settings.stream.bitrateKbps` > 0) never changes, on every link;
//! * "Auto" = the LAN model of `src/rtc/defaults.ts` (`effectiveBitrateKbps(…, lan = true)`), ported 1:1 in
//!   [`lan_bitrate_kbps`]; on loss / queueing it backs off and recovers ([`RateCtl`]).

use std::collections::VecDeque;

use crate::net::ctrl::{ReceiverReport, PING_MS};
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

/// The loss share is judged over this many µs of reports (and only over reports after the last change).
const LOSS_WINDOW_US: u64 = 1_000_000;
/// After a back-off, recovery waits this long (µs).
const RECOVER_HOLD_US: u64 = 1_000_000;

fn round100(kbps: f32) -> u32 {
    ((kbps / 100.0).round() * 100.0).max(100.0) as u32
}

/// Rate state of one encoder (the minimum over its links' reports). `fixed` = the user's own value: never moves.
pub struct RateCtl {
    target: u32,
    fixed: bool,
    current: u32,
    /// time of the last change (back-off or recovery step)
    changed_us: Option<u64>,
    backoff_us: Option<u64>,
    /// (report time, frames, lost) since the last change, at most [`LOSS_WINDOW_US`] old
    window: VecDeque<(u64, u32, u32)>,
    /// first report of the current run with a rising delay trend
    trend_since: Option<u64>,
}

impl RateCtl {
    pub fn new(target_kbps: u32, fixed: bool) -> Self {
        RateCtl { target: target_kbps, fixed, current: target_kbps, changed_us: None, backoff_us: None, window: VecDeque::new(), trend_since: None }
    }

    /// New target from settings (user changed the bitrate, or Auto with a new size).
    pub fn set_target(&mut self, target_kbps: u32, fixed: bool) {
        *self = RateCtl::new(target_kbps, fixed);
    }

    /// Current rate (kbit/s).
    pub fn current_kbps(&self) -> u32 {
        self.current
    }

    pub fn target_kbps(&self) -> u32 {
        self.target
    }

    fn floor(&self) -> u32 {
        round100(self.target as f32 * FLOOR_FACTOR).min(self.target)
    }

    fn may_change(&self, now_us: u64) -> bool {
        self.changed_us.is_none_or(|t| now_us.saturating_sub(t) >= MIN_CHANGE_MS * 1000)
    }

    fn changed(&mut self, now_us: u64, kbps: u32) -> Option<u32> {
        self.changed_us = Some(now_us);
        self.window.clear();
        self.trend_since = None;
        if kbps == self.current {
            return None;
        }
        self.current = kbps;
        Some(kbps)
    }

    /// Feeds one receiver report; returns Some(new kbps) when the encoder must be reconfigured now.
    pub fn on_report(&mut self, now_us: u64, report: &ReceiverReport) -> Option<u32> {
        if self.fixed {
            return None;
        }
        self.window.push_back((now_us, report.frames, report.lost));
        while self.window.front().is_some_and(|w| now_us.saturating_sub(w.0) > LOSS_WINDOW_US) {
            self.window.pop_front();
        }
        if report.delay_trend_us > BACKOFF_TREND_US_PER_S {
            self.trend_since.get_or_insert(now_us);
        } else {
            self.trend_since = None;
        }
        // judge the loss only over a full second of reports (one per PING_MS)
        let full = self.window.len() as u64 >= LOSS_WINDOW_US / (PING_MS * 1000);
        let (frames, lost) = self.window.iter().fold((0u64, 0u64), |a, w| (a.0 + w.1 as u64, a.1 + w.2 as u64));
        let loss_pct = if frames + lost == 0 { 0.0 } else { lost as f32 * 100.0 / (frames + lost) as f32 };
        let rising = self.trend_since.is_some_and(|t| now_us.saturating_sub(t) >= BACKOFF_TREND_MS * 1000);
        if (full && loss_pct > BACKOFF_LOSS_PCT) || rising {
            if !self.may_change(now_us) {
                return None;
            }
            self.backoff_us = Some(now_us);
            let kbps = round100(self.current as f32 * BACKOFF_FACTOR).max(self.floor());
            return self.changed(now_us, kbps);
        }
        self.tick(now_us)
    }

    /// Called every 100 ms without reports too (recovery); Some(new kbps) when the encoder must change.
    pub fn tick(&mut self, now_us: u64) -> Option<u32> {
        if self.fixed || self.current >= self.target || !self.may_change(now_us) {
            return None;
        }
        if self.backoff_us.is_some_and(|t| now_us.saturating_sub(t) < RECOVER_HOLD_US) {
            return None;
        }
        let since = self.changed_us.map_or(MIN_CHANGE_MS * 1000, |t| now_us.saturating_sub(t));
        let step = self.target as f32 * RECOVER_PER_S * since as f32 / 1e6;
        let kbps = (self.current + round100(step)).min(self.target);
        self.changed(now_us, kbps)
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

    fn report(frames: u32, lost: u32, trend: i32) -> ReceiverReport {
        ReceiverReport { frames, lost, delay_trend_us: trend, ..Default::default() }
    }

    const MS: u64 = 1000;

    /// Feeds reports every 200 ms from `from` to `to` (ms); returns every change.
    fn run(c: &mut RateCtl, from: u64, to: u64, r: ReceiverReport) -> Vec<(u64, u32)> {
        let mut out = Vec::new();
        let mut t = from;
        while t < to {
            if let Some(k) = c.on_report(t * MS, &r) {
                out.push((t, k));
            }
            t += 200;
        }
        out
    }

    #[test]
    fn clean_reports_never_change_the_rate() {
        let mut c = RateCtl::new(20_000, false);
        assert!(run(&mut c, 0, 10_000, report(12, 0, 300)).is_empty());
        assert_eq!(c.current_kbps(), 20_000);
        // 1 % loss is below the threshold
        assert!(run(&mut c, 10_000, 20_000, report(99, 1, 0)).is_empty());
    }

    #[test]
    fn loss_backs_off_after_a_second_down_to_the_floor() {
        let mut c = RateCtl::new(20_000, false);
        let changes = run(&mut c, 0, 10_000, report(57, 3, 0)); // 5 % frame loss
        // first step once a full second of reports is in, then one step per second (the window restarts)
        assert_eq!(changes[0], (800, 16_000));
        assert_eq!(changes[1], (1_800, 12_800));
        assert_eq!(changes[2], (2_800, 10_200));
        assert_eq!(changes[3], (3_800, 10_000)); // floor = 50 %
        assert_eq!(changes.len(), 4);
        assert_eq!(c.current_kbps(), 10_000);
        // changes are at least 500 ms apart
        assert!(changes.windows(2).all(|w| w[1].0 - w[0].0 >= MIN_CHANGE_MS));
    }

    #[test]
    fn rising_delay_backs_off_and_recovery_climbs_back() {
        let mut c = RateCtl::new(30_000, false);
        // trend above 2 ms/s: back-off once it lasted a second
        let changes = run(&mut c, 0, 1_200, report(12, 0, 5_000));
        assert_eq!(changes, vec![(1_000, 24_000)]);
        // a short spike does not count
        assert!(run(&mut c, 1_200, 1_800, report(12, 0, 5_000)).is_empty());
        // clean again: no recovery for a second after the back-off, then +5 % of the target per second in steps
        // of at least 500 ms
        let changes = run(&mut c, 1_800, 10_000, report(12, 0, 0));
        assert_eq!(changes[0].0, 2_000);
        assert!(changes.windows(2).all(|w| w[1].0 - w[0].0 >= MIN_CHANGE_MS));
        assert_eq!(c.current_kbps(), 30_000);
        assert_eq!(changes.last().unwrap().1, 30_000);
        // ≈ 6000 kbit/s at 1500 kbit/s per second: about 4 s
        assert!((5_000..=7_000).contains(&changes.last().unwrap().0), "{changes:?}");
        // tick() recovers without reports too
        let mut c = RateCtl::new(10_000, false);
        run(&mut c, 0, 1_000, report(10, 5, 0));
        assert!(c.current_kbps() < 10_000);
        let mut t = 1_000;
        while c.current_kbps() < 10_000 && t < 60_000 {
            c.tick(t * MS);
            t += 100;
        }
        assert_eq!(c.current_kbps(), 10_000);
    }

    #[test]
    fn a_fixed_rate_never_moves() {
        let mut c = RateCtl::new(50_000, true);
        assert!(run(&mut c, 0, 10_000, report(10, 10, 50_000)).is_empty());
        assert_eq!(c.tick(20_000 * MS), None);
        assert_eq!(c.current_kbps(), 50_000);
        // switching to Auto (fixed = false) resets to the new target and adapts again
        c.set_target(20_000, false);
        assert_eq!(c.current_kbps(), 20_000);
        assert!(!run(&mut c, 20_000, 22_000, report(10, 10, 0)).is_empty());
        // and back to a fixed value: the user's number, at once and for good
        c.set_target(8_000, true);
        assert_eq!(c.current_kbps(), 8_000);
        assert!(run(&mut c, 22_000, 30_000, report(10, 10, 0)).is_empty());
    }
}

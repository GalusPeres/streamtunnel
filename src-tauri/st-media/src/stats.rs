//! Stats snapshots (serialized to JSON by the Tauri glue, camelCase field names, see docs/NATIVE-PATH.md §8).
//! Counters are totals since the link/sender/receiver started; rates are over the last second.

use serde::Serialize;

/// One link (both roles).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStats {
    /// "lan" (both ends on the same private subnet) | "p2p" (any other direct pair) | "" (not up)
    pub kind: String,
    /// the peer's address of the selected pair ("ip:port"), "" before up
    pub remote: String,
    /// latest RTT in ms (ping/pong), 0 = unknown
    pub rtt_ms: f32,
    /// payload sent / received over the last second (kbit/s, headers + FEC included)
    pub tx_kbps: u32,
    pub rx_kbps: u32,
    /// pacing rate of this link (kbit/s)
    pub pace_kbps: u32,
    /// packets the peer reported missing over the last second, in % of the packets it expected
    pub loss_pct: f32,
    /// packets dropped because they failed authentication / replay checks (total)
    pub rejected: u64,
}

/// Viewer side of one link ([`crate::recv::Receiver`]).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecvStats {
    /// complete access units handed to the page (total)
    pub frames: u64,
    /// of those, completed with FEC (total)
    pub frames_recovered: u64,
    /// frames declared lost (total)
    pub frames_lost: u64,
    /// complete frames dropped because the page did not take them in time (its queue overflowed; total)
    pub frames_dropped: u64,
    /// key frames received (total)
    pub keyframes: u64,
    /// key frame requests sent (total)
    pub keyframe_requests: u64,
    /// frames per second delivered over the last second
    pub fps: f32,
    /// video payload received over the last second (kbit/s)
    pub video_kbps: u32,
    /// median capture → handed-to-page over the last second (ms), 0 before the clock is synced
    pub age_ms: f32,
    /// audio packets concealed with silence (total)
    pub audio_lost: u64,
}

/// Sharer side of one encoder ([`crate::send::Sender`]).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderStats {
    /// "h264" | "hevc"
    pub codec: String,
    /// current CBR target (kbit/s)
    pub target_kbps: u32,
    /// video actually sent per link over the last second (kbit/s, before FEC)
    pub video_kbps: u32,
    /// frames sent (total)
    pub frames: u64,
    /// key frames requested from the encoder (total)
    pub keyframes: u64,
    /// reference invalidations requested (total)
    pub invalidations: u64,
    /// links currently fed
    pub links: u32,
}

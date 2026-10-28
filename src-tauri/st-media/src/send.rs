//! Sharer side of one encoder (docs/NATIVE-PATH.md §6): fans every encoded frame out to the links that watch this
//! codec, sends the share sound, and turns the viewers' feedback into encoder requests.
//!
//! * a frame is sharded + FEC-coded once ([`crate::net::frame::shard_frame`], 10 % parity when every link is
//!   "lan", else 20 %) and queued on every link that is up and has seen a key frame;
//! * a link added with [`Sender::add_link`] gets nothing until the next key frame; joins request one, coalesced
//!   over 250 ms;
//! * FrameLost → `InvalidateRefs` when every link of this encoder has the RFI capability, else `Keyframe`
//!   (WebCodecs viewers: no RFI in this milestone); Keyframe requests are executed at most once per 200 ms
//!   (requests during the hold merge into one at its end);
//! * receiver reports drive [`crate::net::rate::RateCtl`] (the minimum over the links); a change becomes
//!   `EncoderRequest::Bitrate`. A bitrate set by hand never changes.
//!
//! No thread of its own: everything runs in `push_frame` / `push_audio` (capture thread, glue) and in the
//! links' `on_ctrl` (network thread).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use std::sync::Arc;

use crate::net::link::Link;
use crate::stats::SenderStats;
use crate::{AudioChunk, Codec, EncodedFrame, EncoderRequest};

/// Joins within this window share one key frame (ms).
pub const JOIN_COALESCE_MS: u64 = 250;
/// Minimum gap between two key frame requests (ms).
pub const KEYFRAME_HOLD_MS: u64 = 200;

/// What one viewer's decoder can do (from its `nv` join caps).
#[derive(Clone, Copy, Debug, Default)]
pub struct ViewerCaps {
    /// recovers from reference-frame invalidation (false for every WebCodecs viewer in this milestone)
    pub rfi: bool,
}

/// Encoder requests go here (the glue forwards them to `win::capture::CaptureSession::request`).
pub type RequestSink = Arc<dyn Fn(EncoderRequest) + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub struct SenderConfig {
    pub codec: Codec,
    /// CBR target (kbit/s): the user's value, or `rate::lan_bitrate_kbps` for Auto
    pub target_kbps: u32,
    /// the user set the bitrate by hand: never adapt
    pub fixed: bool,
}

pub struct Sender {
    // filled by NET
}

impl Sender {
    pub fn new(cfg: SenderConfig, requests: RequestSink) -> Arc<Sender> {
        todo!("NET")
    }

    pub fn codec(&self) -> Codec {
        todo!("NET")
    }

    /// Feeds `link` from the next key frame on (requests one) and becomes its packet handler.
    pub fn add_link(self: &Arc<Self>, link: &Arc<Link>, caps: ViewerCaps) {
        todo!("NET")
    }

    /// Stops feeding a link (it is not closed here).
    pub fn remove_link(&self, link_id: u32) {
        todo!("NET")
    }

    /// Links currently fed.
    pub fn link_count(&self) -> usize {
        todo!("NET")
    }

    /// One encoded frame from the capture session.
    pub fn push_frame(&self, frame: &EncodedFrame) {
        todo!("NET")
    }

    /// 5 ms of share sound (sent to every link of this sender, ahead of queued video).
    pub fn push_audio(&self, chunk: &AudioChunk) {
        todo!("NET")
    }

    /// The user changed the bitrate (or Auto got a new value): resets the rate controller.
    pub fn set_target(&self, kbps: u32, fixed: bool) {
        todo!("NET")
    }

    pub fn stats(&self) -> SenderStats {
        todo!("NET")
    }
}

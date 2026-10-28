//! Viewer side of one link (docs/NATIVE-PATH.md §6): reassembly without a jitter buffer, loss feedback, audio
//! blocks, delivery to the glue.
//!
//! * video shards → [`crate::net::frame::Reassembler`]; every complete access unit is delivered IN ORDER (a
//!   decoder needs every delta frame — "newest wins" happens when the page draws);
//! * `Lost` → FrameLost to the sharer at once, repeated every max(2 × RTT, 10 ms) until a key / after-RFI frame
//!   newer than the loss arrives (at most 3 times, then a Keyframe request);
//! * [`Receiver::request_keyframe`] (page decoder error / decoder (re)configured) → Keyframe, same repetition;
//! * a receiver report every 200 ms;
//! * audio: packets are put in order, a missing 5 ms packet becomes silence; every 4 packets (20 ms, or after
//!   25 ms) one [`AudioBlock`] goes out;
//! * delivery runs on the receiver's own thread `st-recv` through a queue of at most [`MAX_QUEUED_AUS`] access
//!   units: if the sink falls behind, the queue is dropped, video waits for the next key frame and one is
//!   requested. The network thread never waits on IPC.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use std::sync::Arc;

use crate::net::link::Link;
use crate::stats::RecvStats;
use crate::Codec;

/// Access units queued for the sink before the queue is dropped (see module docs).
pub const MAX_QUEUED_AUS: usize = 8;

/// One complete access unit for the page.
#[derive(Clone, Debug)]
pub struct VideoAu {
    pub frame_id: u32,
    pub codec: Codec,
    pub key: bool,
    /// completed with FEC
    pub recovered: bool,
    /// first frame after a loss (the page may show a short hint / count it)
    pub after_loss: bool,
    /// sender capture time (sender clock, µs) — the WebCodecs timestamp
    pub pts_us: u64,
    /// capture → handed to the sink on OUR clock (µs), 0 while the clock offset is unknown
    pub age_us: u32,
    /// capture → encoded on the sender (µs)
    pub sender_latency_us: u32,
    /// Annex B
    pub data: Vec<u8>,
}

/// 20 ms of sound for the page.
#[derive(Clone, Debug)]
pub struct AudioBlock {
    /// seq of the first 5 ms packet in the block
    pub seq: u32,
    /// sender capture time of the first sample (sender clock, µs)
    pub capture_us: u64,
    /// s16 interleaved stereo, [`crate::AUDIO_BLOCK_FRAMES`] frames
    pub pcm: Vec<i16>,
    /// 5 ms packets replaced with silence in this block
    pub concealed: u8,
}

#[derive(Clone, Debug)]
pub enum RecvEvent {
    Video(VideoAu),
    Audio(AudioBlock),
}

/// Gets the receiver's output on its `st-recv` thread.
pub type RecvSink = Arc<dyn Fn(RecvEvent) + Send + Sync>;

pub struct Receiver {
    // filled by NET
}

impl Receiver {
    /// Becomes `link`'s packet handler and starts the delivery thread. Requests a key frame once the link is up.
    pub fn attach(link: &Arc<Link>, sink: RecvSink) -> Arc<Receiver> {
        todo!("NET")
    }

    /// The page's decoder needs a key frame (error, reconfigure).
    pub fn request_keyframe(&self) {
        todo!("NET")
    }

    pub fn stats(&self) -> RecvStats {
        todo!("NET")
    }

    /// Stops the delivery thread (the link is not closed here). Idempotent.
    pub fn close(&self) {
        todo!("NET")
    }
}

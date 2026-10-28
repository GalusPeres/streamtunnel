//! Frames ↔ shards (docs/NATIVE-PATH.md §6).
//!
//! Sender: an access unit of n bytes becomes k = ⌈n / MAX_SHARD⌉ data shards of [`shard_len`] bytes each (the last
//! zero-padded) plus m parity shards ([`crate::net::fec::parity_count`]); every shard is one video datagram.
//!
//! Receiver ([`Reassembler`]), Moonlight's rules — no jitter buffer:
//! * a frame is delivered the moment its k data shards are in, or as soon as any k shards allow an RS decode;
//! * when a shard of a newer frame arrives while an older frame is still incomplete and cannot be recovered with
//!   what arrived, the older frame is lost: `Lost { first, last }` covers every frame id from the oldest missing
//!   one up to newest − 1;
//! * after a loss, delta frames are not delivered until a key frame or an after-RFI frame newer than the loss
//!   arrives (the decoder would only show garbage).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use crate::net::wire::VideoShard;
use crate::{Codec, EncodedFrame};

/// Incomplete frames kept at once; older ones are declared lost.
pub const MAX_FRAMES_IN_FLIGHT: usize = 4;

/// Bytes per shard for an access unit of `au_len` bytes split into `data_shards` shards: ⌈au_len / k⌉ rounded up
/// to even (Reed-Solomon needs even shards), at least 2.
pub fn shard_len(au_len: usize, data_shards: usize) -> usize {
    let k = data_shards.max(1);
    let n = au_len.div_ceil(k).max(2);
    n + (n & 1)
}

/// Data shards for an access unit: ⌈au_len / MAX_SHARD⌉, at least 1.
pub fn data_shard_count(au_len: usize) -> usize {
    au_len.div_ceil(crate::net::wire::MAX_SHARD).max(1)
}

/// Splits one encoded frame into video plaintexts (data shards first, then parity), ready for
/// [`crate::net::link::Link::send_video`]. Computed once per frame and shared by every link of a sender.
pub fn shard_frame(frame: &EncodedFrame, fec_pct: u8) -> Vec<Vec<u8>> {
    todo!("NET")
}

/// A complete access unit on the viewer side.
#[derive(Clone, Debug)]
pub struct CompleteFrame {
    pub frame_id: u32,
    pub codec: Codec,
    /// `crate::net::wire::vflags`
    pub flags: u8,
    /// sender clock
    pub capture_us: u64,
    /// capture → encoded on the sender (µs)
    pub sender_latency_us: u32,
    /// needed parity shards
    pub recovered: bool,
    /// first frame delivered after a loss
    pub after_loss: bool,
    pub data: Vec<u8>,
}

/// What [`Reassembler::push`] produced.
#[derive(Clone, Debug)]
pub enum Reassembled {
    Frame(CompleteFrame),
    /// frames `first..=last` will never be delivered
    Lost { first: u32, last: u32 },
}

/// Viewer-side reassembly of one link's video.
#[derive(Default)]
pub struct Reassembler {
    // filled by NET
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one shard (already authenticated). Returns frames to deliver and losses to report, in order.
    pub fn push(&mut self, shard: VideoShard<'_>, now_us: u64) -> Vec<Reassembled> {
        todo!("NET")
    }

    /// Packets expected / received since the last call (for the receiver report).
    pub fn take_packet_counts(&mut self) -> (u32, u32) {
        todo!("NET")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shard_sizes() {
        assert_eq!(data_shard_count(1), 1);
        assert_eq!(data_shard_count(1144), 1);
        assert_eq!(data_shard_count(1145), 2);
        assert_eq!(shard_len(1145, 2), 574);
        assert_eq!(shard_len(3, 1), 4);
        assert_eq!(shard_len(1, 1), 2);
    }
}

//! `stm/1` packet layouts (docs/NATIVE-PATH.md §4). All multi-byte fields are big-endian.
//!
//! ```text
//! datagram  = header (14 B, plaintext, = AEAD associated data) ‖ AES-256-GCM(plaintext) ‖ tag (16 B)
//! header    [0] u8 version(2 bits, =1) << 6 | kind(6 bits)   [1] u8 key epoch (= pn >> 24, wrapping)
//!           [2..6] u32 link id of the RECEIVER                [6..14] u64 packet number (per direction, from 1)
//! ```
//! A datagram whose first byte has the top two bits 00 is STUN (RFC 8489), never `stm`.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

/// Wire version in the top two bits of byte 0.
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 14;
pub const TAG_LEN: usize = 16;
/// Largest UDP payload we ever send (fits every path's MTU, IPv6 included).
pub const MAX_DATAGRAM: usize = 1200;
/// Largest plaintext of one datagram.
pub const MAX_PLAINTEXT: usize = MAX_DATAGRAM - HEADER_LEN - TAG_LEN;
pub const VIDEO_HEADER_LEN: usize = 26;
pub const AUDIO_HEADER_LEN: usize = 16;
pub const PROBE_LEN: usize = 13;
/// Largest shard of a video frame (even, as Reed-Solomon needs): 1200 − 14 − 16 − 26 = 1144.
pub const MAX_SHARD: usize = MAX_PLAINTEXT - VIDEO_HEADER_LEN;

/// Packet kinds (low six bits of byte 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// ICE-lite connectivity check and its reply ([`Probe`])
    Probe = 1,
    /// control message ([`crate::net::ctrl::Ctrl`])
    Ctrl = 2,
    /// one shard of a video frame ([`VideoShard`])
    Video = 3,
    /// 5 ms of PCM ([`AudioPacket`])
    Audio = 4,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        match v {
            1 => Some(Kind::Probe),
            2 => Some(Kind::Ctrl),
            3 => Some(Kind::Video),
            4 => Some(Kind::Audio),
            _ => None,
        }
    }
}

/// The plaintext datagram header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub kind: Kind,
    /// key epoch = (pn >> 24) as u8; must match the packet number
    pub epoch: u8,
    /// link id chosen by the receiver (it told the sender through signaling)
    pub link: u32,
    /// packet number, per link and direction, starting at 1; doubles as the AES-GCM nonce
    pub pn: u64,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[0] = (VERSION << 6) | (self.kind as u8 & 0x3f);
        b[1] = self.epoch;
        b[2..6].copy_from_slice(&self.link.to_be_bytes());
        b[6..14].copy_from_slice(&self.pn.to_be_bytes());
        b
    }

    /// None for STUN, another version, an unknown kind or a short datagram.
    pub fn decode(b: &[u8]) -> Option<Header> {
        if b.len() < HEADER_LEN + TAG_LEN || b[0] >> 6 != VERSION {
            return None;
        }
        Some(Header {
            kind: Kind::from_u8(b[0] & 0x3f)?,
            epoch: b[1],
            link: u32::from_be_bytes(b[2..6].try_into().ok()?),
            pn: u64::from_be_bytes(b[6..14].try_into().ok()?),
        })
    }
}

/// True for a STUN message (top two bits 00 and the magic cookie 0x2112A442 at bytes 4..8).
pub fn is_stun(b: &[u8]) -> bool {
    b.len() >= 20 && b[0] >> 6 == 0 && b[4..8] == [0x21, 0x12, 0xA4, 0x42]
}

/// Flags of a video shard (byte 10).
pub mod vflags {
    /// the frame is an IDR / IRAP
    pub const KEY: u8 = 1;
    /// first frame after a reference invalidation
    pub const AFTER_RFI: u8 = 2;
    /// unchanged content encoded again (static screen)
    pub const REPEAT: u8 = 4;
}

/// Video plaintext: one shard of one frame. Every shard repeats the frame fields, so any shard describes the frame.
///
/// ```text
/// [0..4] u32 frame id   [4..6] u16 shard index (data shards first, then parity)   [6..8] u16 data shards k
/// [8..10] u16 parity shards m   [10] u8 flags (vflags)   [11] u8 codec (crate::Codec)   [12..16] u32 AU bytes
/// [16..24] u64 capture µs (sender clock)   [24..26] u16 sender latency (0.1 ms, capture → encoded, saturating)
/// [26..] shard (crate::net::frame::shard_len(AU bytes, k) bytes; the last data shard is zero-padded)
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoShard<'a> {
    pub frame_id: u32,
    pub index: u16,
    pub data_shards: u16,
    pub parity_shards: u16,
    pub flags: u8,
    pub codec: u8,
    pub au_len: u32,
    pub capture_us: u64,
    pub sender_latency: u16,
    pub shard: &'a [u8],
}

impl<'a> VideoShard<'a> {
    /// Appends header + shard to `out` (the plaintext of one video datagram).
    pub fn encode(&self, out: &mut Vec<u8>) {
        todo!("NET")
    }

    /// None if too short or inconsistent (index ≥ k + m, k = 0, shard length ≠ shard_len(au_len, k)).
    pub fn parse(b: &'a [u8]) -> Option<VideoShard<'a>> {
        todo!("NET")
    }
}

/// Audio plaintext: 5 ms of s16le interleaved PCM.
///
/// ```text
/// [0..4] u32 seq   [4..12] u64 capture µs (sender clock)   [12..14] u16 frames   [14] u8 channels   [15] u8 flags (0)
/// [16..] frames × channels × 2 bytes PCM (little-endian s16, like the page wants it)
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioPacket<'a> {
    pub seq: u32,
    pub capture_us: u64,
    pub frames: u16,
    pub channels: u8,
    pub pcm: &'a [u8],
}

impl<'a> AudioPacket<'a> {
    pub fn encode(&self, out: &mut Vec<u8>) {
        todo!("NET")
    }

    pub fn parse(b: &'a [u8]) -> Option<AudioPacket<'a>> {
        todo!("NET")
    }
}

/// Probe plaintext (ICE-lite check, also the keepalive before the link is up).
///
/// ```text
/// [0..8] u64 sender time µs (echoed back in the reply)   [8..12] u32 probe seq   [12] u8 flags (bit0 = reply)
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Probe {
    pub t_us: u64,
    pub seq: u32,
    pub reply: bool,
}

impl Probe {
    pub fn encode(&self) -> [u8; PROBE_LEN] {
        todo!("NET")
    }

    pub fn parse(b: &[u8]) -> Option<Probe> {
        todo!("NET")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let h = Header { kind: Kind::Video, epoch: 3, link: 0xdead_beef, pn: (3 << 24) + 7 };
        let mut d = h.encode().to_vec();
        d.extend_from_slice(&[0u8; TAG_LEN]);
        assert_eq!(Header::decode(&d), Some(h));
        assert!(!is_stun(&d));
        assert_eq!(MAX_SHARD, 1144);
    }
}

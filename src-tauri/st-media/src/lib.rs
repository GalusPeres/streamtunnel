//! StreamTunnel native media path (docs/NATIVE-PATH.md, plan in docs/MEDIA-PLAN.md).
//!
//! A Parsec/Moonlight-style path between two StreamTunnel apps, next to the WebRTC path in the web view:
//! * Windows sharer: Windows.Graphics.Capture → D3D11 (frames stay on the GPU) → NVENC ([`win`]);
//! * transport: our own small UDP protocol `stm/1` — AES-256-GCM per packet, per-frame Reed-Solomon FEC, paced
//!   sending, ICE-lite probing over one socket per app ([`net`]);
//! * viewer (every OS): reassembly without a jitter buffer ([`recv`]); the Tauri glue hands each complete access
//!   unit to the page, which decodes it with WebCodecs.
//!
//! The crate knows nothing about Tauri or the signaling protocol: `src-tauri/src/native_media.rs` drives it, the
//! key halves and candidates travel inside the E2E-encrypted signaling room (TypeScript, `src/rtc/nativelink.ts`).
//!
//! This file holds the types shared by every module. It is frozen: owners change only their own modules.

pub mod clock;
pub mod net;
pub mod recv;
pub mod send;
pub mod stats;
#[cfg(windows)]
pub mod win;

pub use net::ice::{Candidate, CandidateKind};
pub use net::link::{Endpoint, EndpointConfig, Link, LinkEvent, LinkSink, PathInfo};

/// `stm` protocol version this build speaks (wire version bits, caps `v`).
pub const STM_VERSION: u8 = 1;
/// Oldest `stm` version this build still talks to (caps `min`).
pub const STM_MIN_VERSION: u8 = 1;

/// Video codecs of the native path. The value is the codec byte on the wire and in the page messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Codec {
    /// H.264 High (WebKit viewers, viewers without hardware HEVC)
    H264 = 1,
    /// HEVC Main 8-bit (default where the viewer decodes it in hardware and is not WebKit)
    Hevc = 2,
}

impl Codec {
    pub fn from_u8(v: u8) -> Option<Codec> {
        match v {
            1 => Some(Codec::H264),
            2 => Some(Codec::Hevc),
            _ => None,
        }
    }

    /// Name used in signaling and commands: "h264" | "hevc".
    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
        }
    }

    pub fn from_name(s: &str) -> Option<Codec> {
        match s {
            "h264" => Some(Codec::H264),
            "hevc" => Some(Codec::Hevc),
            _ => None,
        }
    }
}

/// Which end of a link we are. The sharer sends media, the viewer receives it; key derivation depends on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Share,
    Watch,
}

/// One encoded access unit from the encoder (WIN → NET).
#[derive(Clone, Debug)]
pub struct EncodedFrame {
    /// encoder-assigned, +1 per encoded frame (wraps); also NVENC's input timestamp, so `InvalidateRefs` maps 1:1
    pub frame_id: u32,
    pub codec: Codec,
    /// IDR (H.264) / IRAP (HEVC); parameter sets (VPS/SPS/PPS) precede every key frame
    pub key: bool,
    /// first frame encoded after a reference invalidation (references only frames before the invalidated range)
    pub after_invalidation: bool,
    /// the capture delivered nothing new: the last texture was encoded again (static content)
    pub repeat: bool,
    /// Annex B byte stream (start codes), exactly one access unit
    pub data: Vec<u8>,
    /// [`clock::now_us`] when the captured frame arrived
    pub capture_us: u64,
    /// [`clock::now_us`] when the bitstream was locked (capture → encoded = sender latency)
    pub encoded_us: u64,
    pub width: u32,
    pub height: u32,
}

/// What the network side asks of the encoder (NET → WIN, through the glue).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderRequest {
    /// next frame is an IDR (viewer joined, loss without RFI, decoder error)
    Keyframe,
    /// frames `first..=last` (frame ids) were lost: invalidate them (NvEncInvalidateRefFrames); the encoder falls
    /// back to an IDR when that is impossible (range ≥ DPB, call failed)
    InvalidateRefs { first: u32, last: u32 },
    /// new CBR target (NvEncReconfigureEncoder without IDR). Resolution and fps never change for rate reasons.
    Bitrate { kbps: u32 },
}

/// Audio sample rate of the native path (Hz).
pub const AUDIO_RATE: u32 = 48_000;
/// Interleaved channels.
pub const AUDIO_CHANNELS: usize = 2;
/// Frames per audio packet on the wire (5 ms at 48 kHz → 960 bytes of s16 stereo).
pub const AUDIO_PACKET_FRAMES: usize = 240;
/// Frames per audio block handed to the page (20 ms = 4 packets, one IPC message).
pub const AUDIO_BLOCK_FRAMES: usize = 960;

/// 5 ms of share sound (glue → NET): s16 interleaved stereo at 48 kHz, exactly [`AUDIO_PACKET_FRAMES`] frames.
#[derive(Clone, Debug)]
pub struct AudioChunk {
    /// +1 per chunk (wraps); gaps = lost on the sender side (never happens) or on the wire
    pub seq: u32,
    /// [`clock::now_us`] of the first sample
    pub capture_us: u64,
    pub pcm: Vec<i16>,
}

/// Lowercase hex (key halves in signaling).
pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// 64 hex digits → 32 bytes (a key half from signaling); None for anything else.
pub fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let digit = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (digit(b[2 * i])? << 4) | digit(b[2 * i + 1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let k: [u8; 32] = std::array::from_fn(|i| (i * 37) as u8);
        assert_eq!(parse_hex32(&to_hex(&k)), Some(k));
        assert_eq!(parse_hex32("00"), None);
        assert_eq!(parse_hex32(&"g".repeat(64)), None);
    }

    #[test]
    fn codec_names() {
        for c in [Codec::H264, Codec::Hevc] {
            assert_eq!(Codec::from_name(c.name()), Some(c));
            assert_eq!(Codec::from_u8(c as u8), Some(c));
        }
    }
}

//! `stm/1` packet layouts (docs/NATIVE-PATH.md §4). All multi-byte fields are big-endian.
//!
//! ```text
//! datagram  = header (14 B, plaintext, = AEAD associated data) ‖ AES-256-GCM(plaintext) ‖ tag (16 B)
//! header    [0] u8 version(2 bits, =1) << 6 | kind(6 bits)   [1] u8 key epoch (= pn >> 24, wrapping)
//!           [2..6] u32 link id of the RECEIVER                [6..14] u64 packet number (per direction, from 1)
//! ```
//! A datagram whose first byte has the top two bits 00 is STUN (RFC 8489), never `stm`.

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
        out.reserve(VIDEO_HEADER_LEN + self.shard.len());
        out.extend_from_slice(&self.frame_id.to_be_bytes());
        out.extend_from_slice(&self.index.to_be_bytes());
        out.extend_from_slice(&self.data_shards.to_be_bytes());
        out.extend_from_slice(&self.parity_shards.to_be_bytes());
        out.push(self.flags);
        out.push(self.codec);
        out.extend_from_slice(&self.au_len.to_be_bytes());
        out.extend_from_slice(&self.capture_us.to_be_bytes());
        out.extend_from_slice(&self.sender_latency.to_be_bytes());
        out.extend_from_slice(self.shard);
    }

    /// None if too short or inconsistent (index ≥ k + m, k = 0, shard length ≠ shard_len(au_len, k)).
    pub fn parse(b: &'a [u8]) -> Option<VideoShard<'a>> {
        if b.len() < VIDEO_HEADER_LEN {
            return None;
        }
        let v = VideoShard {
            frame_id: be32(b, 0),
            index: be16(b, 4),
            data_shards: be16(b, 6),
            parity_shards: be16(b, 8),
            flags: b[10],
            codec: b[11],
            au_len: be32(b, 12),
            capture_us: be64(b, 16),
            sender_latency: be16(b, 24),
            shard: &b[VIDEO_HEADER_LEN..],
        };
        let k = v.data_shards as usize;
        if k == 0 || v.index as usize >= k + v.parity_shards as usize {
            return None;
        }
        if v.shard.len() != crate::net::frame::shard_len(v.au_len as usize, k) || v.shard.len() > MAX_SHARD {
            return None;
        }
        Some(v)
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
        out.reserve(AUDIO_HEADER_LEN + self.pcm.len());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.capture_us.to_be_bytes());
        out.extend_from_slice(&self.frames.to_be_bytes());
        out.push(self.channels);
        out.push(0);
        out.extend_from_slice(self.pcm);
    }

    /// None if too short, without channels or when the PCM length does not match frames × channels.
    pub fn parse(b: &'a [u8]) -> Option<AudioPacket<'a>> {
        if b.len() < AUDIO_HEADER_LEN {
            return None;
        }
        let p = AudioPacket { seq: be32(b, 0), capture_us: be64(b, 4), frames: be16(b, 12), channels: b[14], pcm: &b[AUDIO_HEADER_LEN..] };
        if p.channels == 0 || p.pcm.len() != p.frames as usize * p.channels as usize * 2 {
            return None;
        }
        Some(p)
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
        let mut b = [0u8; PROBE_LEN];
        b[0..8].copy_from_slice(&self.t_us.to_be_bytes());
        b[8..12].copy_from_slice(&self.seq.to_be_bytes());
        b[12] = u8::from(self.reply);
        b
    }

    pub fn parse(b: &[u8]) -> Option<Probe> {
        if b.len() < PROBE_LEN {
            return None;
        }
        Some(Probe { t_us: be64(b, 0), seq: be32(b, 8), reply: b[12] & 1 != 0 })
    }
}

// Big-endian readers for slices whose length was checked by the caller.
pub(crate) fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

pub(crate) fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

pub(crate) fn be64(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_be_bytes(a)
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
        // every kind round-trips, unknown kinds / other versions / short datagrams do not decode
        for kind in [Kind::Probe, Kind::Ctrl, Kind::Video, Kind::Audio] {
            let mut d = Header { kind, ..h }.encode().to_vec();
            d.extend_from_slice(&[0u8; TAG_LEN]);
            assert_eq!(Header::decode(&d).map(|h| h.kind), Some(kind));
        }
        let mut bad = d.clone();
        bad[0] = (VERSION << 6) | 9;
        assert_eq!(Header::decode(&bad), None);
        bad[0] = (2 << 6) | Kind::Video as u8;
        assert_eq!(Header::decode(&bad), None);
        assert_eq!(Header::decode(&d[..HEADER_LEN + TAG_LEN - 1]), None);
    }

    #[test]
    fn stun_detection() {
        let mut req = [0u8; 20];
        req[1] = 1;
        req[4..8].copy_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
        assert!(is_stun(&req));
        assert!(!is_stun(&req[..19]));
        let mut no_cookie = req;
        no_cookie[5] = 0;
        assert!(!is_stun(&no_cookie));
        // an stm/1 header never looks like STUN (version bits 01)
        let mut d = Header { kind: Kind::Probe, epoch: 0, link: 0x2112_A442, pn: 1 }.encode().to_vec();
        d.extend_from_slice(&[0u8; TAG_LEN]);
        assert!(!is_stun(&d));
    }

    #[test]
    fn video_shard_round_trip() {
        let au_len = 3000usize;
        let k = crate::net::frame::data_shard_count(au_len);
        let len = crate::net::frame::shard_len(au_len, k);
        let shard: Vec<u8> = (0..len).map(|i| i as u8).collect();
        let v = VideoShard {
            frame_id: 0xfedc_ba98,
            index: 4,
            data_shards: k as u16,
            parity_shards: 2,
            flags: vflags::KEY | vflags::REPEAT,
            codec: 2,
            au_len: au_len as u32,
            capture_us: 0x0102_0304_0506_0708,
            sender_latency: 65_000,
            shard: &shard,
        };
        let mut out = Vec::new();
        v.encode(&mut out);
        assert_eq!(out.len(), VIDEO_HEADER_LEN + len);
        assert_eq!(&out[..4], &[0xfe, 0xdc, 0xba, 0x98]);
        assert_eq!(VideoShard::parse(&out), Some(v));

        // inconsistent: index ≥ k + m, k = 0, wrong shard length, short
        let mut bad = out.clone();
        bad[4..6].copy_from_slice(&(k as u16 + 2).to_be_bytes());
        assert_eq!(VideoShard::parse(&bad), None);
        let mut bad = out.clone();
        bad[6..8].copy_from_slice(&0u16.to_be_bytes());
        assert_eq!(VideoShard::parse(&bad), None);
        assert_eq!(VideoShard::parse(&out[..out.len() - 2]), None);
        let mut bad = out.clone();
        bad[12..16].copy_from_slice(&(au_len as u32 + 10).to_be_bytes());
        assert_eq!(VideoShard::parse(&bad), None);
        assert_eq!(VideoShard::parse(&out[..VIDEO_HEADER_LEN - 1]), None);
    }

    #[test]
    fn audio_and_probe_round_trip() {
        let pcm: Vec<u8> = (0..960).map(|i| (i * 7) as u8).collect();
        let a = AudioPacket { seq: 77, capture_us: 123_456_789, frames: 240, channels: 2, pcm: &pcm };
        let mut out = Vec::new();
        a.encode(&mut out);
        assert_eq!(out.len(), AUDIO_HEADER_LEN + 960);
        assert_eq!(AudioPacket::parse(&out), Some(a));
        assert_eq!(AudioPacket::parse(&out[..out.len() - 1]), None);
        let mut bad = out.clone();
        bad[14] = 0;
        assert_eq!(AudioPacket::parse(&bad), None);
        assert_eq!(AudioPacket::parse(&out[..10]), None);

        let p = Probe { t_us: u64::MAX - 3, seq: 9, reply: true };
        let b = p.encode();
        assert_eq!(b.len(), PROBE_LEN);
        assert_eq!(Probe::parse(&b), Some(p));
        assert_eq!(Probe::parse(&b[..PROBE_LEN - 1]), None);
        assert!(!Probe::parse(&Probe { reply: false, ..p }.encode()).unwrap().reply);
    }

    /// Random bytes of random length never panic any parser (the network is hostile).
    #[test]
    fn fuzz_parsers_never_panic() {
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let txid = [7u8; 12];
        for round in 0..20_000 {
            let len = (next() % 1300) as usize;
            let mut b: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            // sometimes make the prefixes plausible so the deeper checks run
            if round % 4 == 1 && b.len() >= VIDEO_HEADER_LEN {
                b[6..8].copy_from_slice(&1u16.to_be_bytes());
                b[12..16].copy_from_slice(&((len - VIDEO_HEADER_LEN) as u32).to_be_bytes());
            }
            if round % 4 == 2 && b.len() >= 20 {
                b[0] = 1;
                b[1] = 1;
                b[2..4].copy_from_slice(&(((len - 20) & !3) as u16).to_be_bytes());
                b[4..8].copy_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
                b[8..20].copy_from_slice(&txid);
            }
            let _ = Header::decode(&b);
            let _ = is_stun(&b);
            let _ = VideoShard::parse(&b);
            let _ = AudioPacket::parse(&b);
            let _ = Probe::parse(&b);
            let _ = crate::net::ctrl::decode(&b);
            let _ = crate::net::ice::parse_stun_response(&b, &txid);
        }
    }
}

//! Packet protection (docs/NATIVE-PATH.md §5).
//!
//! * Each side of a link draws a random 32-byte key half; both halves travel in the E2E-encrypted signaling
//!   (`nv` join / offer). Being a room member is the authentication, exactly as for the signaling itself.
//! * okm = HKDF-SHA256(salt = "stm/1 salt", ikm = sharer half ‖ viewer half,
//!   info = "stm/1 keys" ‖ sharer link id (u32 BE) ‖ viewer link id (u32 BE), 64 bytes);
//!   sharer → viewer key = okm[0..32], viewer → sharer key = okm[32..64].
//! * AES-256-GCM, nonce = 0u32 ‖ packet number (u64 BE), AAD = the 14-byte header. Directional keys, so one packet
//!   number space per direction never repeats a nonce.
//! * Rekey every 2^24 packets: key(e + 1) = HKDF-Expand(PRK = key(e), info = "stm/1 rekey", 32); the epoch byte is
//!   (pn >> 24) as u8. The receiver keeps the previous, current and next epoch key.
//! * Replay: 2048-packet sliding window per direction, updated only after the tag verified.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use crate::net::wire::Header;
use crate::Role;

pub const KEY_HALF_LEN: usize = 32;
/// Packets per key epoch.
pub const REKEY_INTERVAL: u64 = 1 << 24;
/// Replay window size in packets.
pub const REPLAY_WINDOW: u64 = 2048;

/// 32 bytes from the OS RNG (a key half). Panics only if the OS has no RNG at all.
pub fn random_key_half() -> [u8; KEY_HALF_LEN] {
    let mut k = [0u8; KEY_HALF_LEN];
    getrandom::fill(&mut k).expect("OS random generator");
    k
}

/// Random non-zero u32 (link ids, probe seq starts).
pub fn random_u32() -> u32 {
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).expect("OS random generator");
        let v = u32::from_be_bytes(b);
        if v != 0 {
            return v;
        }
    }
}

/// The two directional keys of one link, from our point of view.
#[derive(Clone)]
pub struct LinkKeys {
    /// key for packets we send
    pub tx: [u8; 32],
    /// key for packets we receive
    pub rx: [u8; 32],
}

/// Derives the link keys (see module docs). `role` picks which half of the okm is tx.
pub fn derive_link_keys(role: Role, sharer_half: &[u8; 32], viewer_half: &[u8; 32], sharer_link: u32, viewer_link: u32) -> LinkKeys {
    todo!("NET: hkdf::Hkdf::<sha2::Sha256>")
}

/// Why a datagram was dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// not an stm/1 datagram (header did not decode)
    Malformed,
    /// epoch byte does not match the packet number, or the epoch is out of range
    Epoch,
    /// already seen or older than the replay window
    Replay,
    /// tag did not verify (wrong key, tampered header or payload)
    Auth,
}

/// Seals outgoing datagrams of one link (owns the tx packet number).
pub struct Sealer {
    // filled by NET
}

impl Sealer {
    pub fn new(key: [u8; 32]) -> Self {
        todo!("NET")
    }

    /// Writes header ‖ ciphertext ‖ tag into `out` (cleared first); returns the packet number used.
    /// `link` = the receiver's link id.
    pub fn seal(&mut self, kind: crate::net::wire::Kind, link: u32, plaintext: &[u8], out: &mut Vec<u8>) -> u64 {
        todo!("NET")
    }
}

/// Opens incoming datagrams of one link (owns the rx keys and the replay window).
pub struct Opener {
    // filled by NET
}

impl Opener {
    pub fn new(key: [u8; 32]) -> Self {
        todo!("NET")
    }

    /// Verifies and decrypts `datagram` into `out` (cleared first). The replay window advances only on success.
    pub fn open(&mut self, datagram: &[u8], out: &mut Vec<u8>) -> Result<Header, OpenError> {
        todo!("NET")
    }
}

/// 2048-packet sliding window (bitmap) of packet numbers already accepted.
#[derive(Clone, Debug, Default)]
pub struct ReplayWindow {
    // filled by NET
}

impl ReplayWindow {
    /// true if `pn` is new and inside the window (does not change the window)
    pub fn check(&self, pn: u64) -> bool {
        todo!("NET")
    }

    /// marks `pn` as seen (call only after the tag verified)
    pub fn accept(&mut self, pn: u64) {
        todo!("NET")
    }
}

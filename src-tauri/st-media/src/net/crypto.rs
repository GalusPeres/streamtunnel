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

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::net::wire::{Header, Kind, HEADER_LEN, TAG_LEN};
use crate::Role;

pub const KEY_HALF_LEN: usize = 32;
/// Packets per key epoch.
pub const REKEY_INTERVAL: u64 = 1 << 24;
/// Replay window size in packets.
pub const REPLAY_WINDOW: u64 = 2048;

const SALT: &[u8] = b"stm/1 salt";
const INFO_KEYS: &[u8] = b"stm/1 keys";
const INFO_REKEY: &[u8] = b"stm/1 rekey";

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
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(sharer_half);
    ikm[32..].copy_from_slice(viewer_half);
    let mut info = [0u8; 18];
    info[..10].copy_from_slice(INFO_KEYS);
    info[10..14].copy_from_slice(&sharer_link.to_be_bytes());
    info[14..18].copy_from_slice(&viewer_link.to_be_bytes());
    let mut okm = [0u8; 64];
    Hkdf::<Sha256>::new(Some(SALT), &ikm).expand(&info, &mut okm).expect("64 bytes is a valid HKDF-SHA256 length");
    let mut s2v = [0u8; 32];
    let mut v2s = [0u8; 32];
    s2v.copy_from_slice(&okm[..32]);
    v2s.copy_from_slice(&okm[32..]);
    match role {
        Role::Share => LinkKeys { tx: s2v, rx: v2s },
        Role::Watch => LinkKeys { tx: v2s, rx: s2v },
    }
}

/// key(e + 1) from key(e).
pub fn next_epoch_key(key: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::from_prk(key)
        .expect("a 32-byte PRK is valid for SHA-256")
        .expand(INFO_REKEY, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

fn nonce(pn: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&pn.to_be_bytes());
    n
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

/// One epoch's key, ready to use.
struct EpochKey {
    epoch: u64,
    raw: [u8; 32],
    aead: Aes256Gcm,
}

impl EpochKey {
    fn new(epoch: u64, raw: [u8; 32]) -> EpochKey {
        EpochKey { epoch, raw, aead: Aes256Gcm::new(&raw.into()) }
    }

    fn next(&self) -> EpochKey {
        EpochKey::new(self.epoch + 1, next_epoch_key(&self.raw))
    }
}

/// Seals outgoing datagrams of one link (owns the tx packet number).
pub struct Sealer {
    key: EpochKey,
    /// next packet number (starts at 1)
    pn: u64,
}

impl Sealer {
    pub fn new(key: [u8; 32]) -> Self {
        Sealer { key: EpochKey::new(0, key), pn: 1 }
    }

    /// Tests: continue at packet number `pn` (the epoch keys are derived up to there). Never moves backwards, so
    /// a nonce is never used twice.
    #[doc(hidden)]
    pub fn skip_to(&mut self, pn: u64) {
        self.pn = self.pn.max(pn);
        while self.key.epoch < self.pn >> 24 {
            self.key = self.key.next();
        }
    }

    /// Writes header ‖ ciphertext ‖ tag into `out` (cleared first); returns the packet number used.
    /// `link` = the receiver's link id.
    pub fn seal(&mut self, kind: Kind, link: u32, plaintext: &[u8], out: &mut Vec<u8>) -> u64 {
        let pn = self.pn;
        self.pn += 1;
        while self.key.epoch < pn >> 24 {
            self.key = self.key.next();
        }
        let header = Header { kind, epoch: (pn >> 24) as u8, link, pn }.encode();
        out.clear();
        out.reserve(HEADER_LEN + plaintext.len() + TAG_LEN);
        out.extend_from_slice(&header);
        out.extend_from_slice(plaintext);
        let tag = self
            .key
            .aead
            .encrypt_in_place_detached(Nonce::from_slice(&nonce(pn)), &header, &mut out[HEADER_LEN..])
            .expect("AES-GCM seals any datagram-sized buffer");
        out.extend_from_slice(&tag);
        pn
    }
}

/// Opens incoming datagrams of one link (owns the rx keys and the replay window).
pub struct Opener {
    prev: Option<EpochKey>,
    cur: EpochKey,
    next: EpochKey,
    replay: ReplayWindow,
}

impl Opener {
    pub fn new(key: [u8; 32]) -> Self {
        let cur = EpochKey::new(0, key);
        let next = cur.next();
        Opener { prev: None, cur, next, replay: ReplayWindow::default() }
    }

    /// Verifies and decrypts `datagram` into `out` (cleared first). The replay window advances only on success.
    pub fn open(&mut self, datagram: &[u8], out: &mut Vec<u8>) -> Result<Header, OpenError> {
        let h = Header::decode(datagram).ok_or(OpenError::Malformed)?;
        let epoch = h.pn >> 24;
        if h.epoch != epoch as u8 {
            return Err(OpenError::Epoch);
        }
        if !self.replay.check(h.pn) {
            return Err(OpenError::Replay);
        }
        let key = if epoch == self.cur.epoch {
            &self.cur
        } else if epoch == self.next.epoch {
            &self.next
        } else {
            match &self.prev {
                Some(p) if p.epoch == epoch => p,
                _ => return Err(OpenError::Epoch),
            }
        };
        let body = &datagram[HEADER_LEN..datagram.len() - TAG_LEN];
        let tag = Tag::from_slice(&datagram[datagram.len() - TAG_LEN..]);
        out.clear();
        out.extend_from_slice(body);
        if key.aead.decrypt_in_place_detached(Nonce::from_slice(&nonce(h.pn)), &datagram[..HEADER_LEN], out, tag).is_err() {
            out.clear();
            return Err(OpenError::Auth);
        }
        self.replay.accept(h.pn);
        if epoch == self.next.epoch {
            // the peer moved to the next epoch: keep one epoch behind for reordered packets
            let after = self.next.next();
            let cur = std::mem::replace(&mut self.next, after);
            self.prev = Some(std::mem::replace(&mut self.cur, cur));
        }
        Ok(h)
    }
}

const WINDOW_WORDS: usize = (REPLAY_WINDOW / 64) as usize;

/// 2048-packet sliding window (bitmap) of packet numbers already accepted.
#[derive(Clone, Debug, Default)]
pub struct ReplayWindow {
    /// highest accepted packet number (0 = none yet)
    top: u64,
    /// bit (pn % 2048) set = pn accepted, for pn in (top − 2048, top]
    bits: [u64; WINDOW_WORDS],
}

impl ReplayWindow {
    fn bit(&self, pn: u64) -> bool {
        let i = (pn % REPLAY_WINDOW) as usize;
        self.bits[i / 64] & (1 << (i % 64)) != 0
    }

    fn set(&mut self, pn: u64, on: bool) {
        let i = (pn % REPLAY_WINDOW) as usize;
        if on {
            self.bits[i / 64] |= 1 << (i % 64);
        } else {
            self.bits[i / 64] &= !(1 << (i % 64));
        }
    }

    /// true if `pn` is new and inside the window (does not change the window)
    pub fn check(&self, pn: u64) -> bool {
        if pn == 0 {
            return false;
        }
        if pn > self.top {
            return true;
        }
        self.top - pn < REPLAY_WINDOW && !self.bit(pn)
    }

    /// marks `pn` as seen (call only after the tag verified)
    pub fn accept(&mut self, pn: u64) {
        if pn > self.top {
            if pn - self.top >= REPLAY_WINDOW {
                self.bits = [0; WINDOW_WORDS];
            } else {
                for p in self.top + 1..pn {
                    self.set(p, false);
                }
            }
            self.top = pn;
        }
        self.set(pn, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> [u8; 32] {
        crate::parse_hex32(s).unwrap()
    }

    /// Fixed halves and link ids → fixed keys. The expected values were computed independently (Python's hmac
    /// HKDF), so a change of salt, info layout or okm split shows up here.
    #[test]
    fn known_answer_keys() {
        let sharer_half: [u8; 32] = std::array::from_fn(|i| i as u8);
        let viewer_half: [u8; 32] = std::array::from_fn(|i| 32 + i as u8);
        let s2v = hex("f878d6eab335b3f464ac77d91a43e7618a86ff0d818621a6e15f0f089d544ad4");
        let v2s = hex("79d5ee7d08b565c2706ace80dbab10957d56c2bf9d30437ec6854a7d295e5a5d");
        let share = derive_link_keys(Role::Share, &sharer_half, &viewer_half, 0x0102_0304, 0xa0b0_c0d0);
        assert_eq!((share.tx, share.rx), (s2v, v2s));
        // the two roles derive mirrored keys
        let watch = derive_link_keys(Role::Watch, &sharer_half, &viewer_half, 0x0102_0304, 0xa0b0_c0d0);
        assert_eq!((watch.tx, watch.rx), (v2s, s2v));
        assert_eq!(next_epoch_key(&s2v), hex("4f86da49114859d3ecf739a60bf8b2efdb83081bbe29c39803c4ac6c9e571d45"));
        // swapped link ids give other keys
        let other = derive_link_keys(Role::Share, &sharer_half, &viewer_half, 0xa0b0_c0d0, 0x0102_0304);
        assert_ne!(other.tx, s2v);
    }

    fn pair() -> (Sealer, Opener) {
        let s = random_key_half();
        let v = random_key_half();
        let share = derive_link_keys(Role::Share, &s, &v, 1, 2);
        let watch = derive_link_keys(Role::Watch, &s, &v, 1, 2);
        (Sealer::new(share.tx), Opener::new(watch.rx))
    }

    #[test]
    fn seal_open_round_trip() {
        let (mut tx, mut rx) = pair();
        let mut d = Vec::new();
        let mut p = Vec::new();
        for i in 0..100u32 {
            let msg: Vec<u8> = (0..(i as usize * 11)).map(|j| j as u8).collect();
            let pn = tx.seal(Kind::Video, 0xabcd, &msg, &mut d);
            assert_eq!(pn, i as u64 + 1);
            assert!(d.len() <= crate::net::wire::MAX_DATAGRAM || msg.len() > crate::net::wire::MAX_PLAINTEXT);
            let h = rx.open(&d, &mut p).unwrap();
            assert_eq!((h.kind, h.link, h.pn), (Kind::Video, 0xabcd, pn));
            assert_eq!(p, msg);
        }
    }

    #[test]
    fn tampering_is_rejected() {
        let (mut tx, mut rx) = pair();
        let mut d = Vec::new();
        let mut p = Vec::new();
        tx.seal(Kind::Ctrl, 7, b"hello world", &mut d);
        // a flipped bit anywhere: header (AAD), ciphertext or tag
        for i in 0..d.len() {
            let mut bad = d.clone();
            bad[i] ^= 0x10;
            let r = rx.open(&bad, &mut p);
            assert!(matches!(r, Err(OpenError::Auth) | Err(OpenError::Epoch) | Err(OpenError::Malformed)), "byte {i}: {r:?}");
        }
        // the untouched datagram still opens: failures did not move the replay window
        assert!(rx.open(&d, &mut p).is_ok());
        // a datagram of another link's keys fails authentication
        let (mut other, _) = pair();
        other.seal(Kind::Ctrl, 7, b"hello world", &mut d);
        assert_eq!(rx.open(&d, &mut p).unwrap_err(), OpenError::Replay); // pn 1 was seen
        other.seal(Kind::Ctrl, 7, b"hello world", &mut d);
        assert_eq!(rx.open(&d, &mut p).unwrap_err(), OpenError::Auth);
        assert_eq!(rx.open(&d[..20], &mut p).unwrap_err(), OpenError::Malformed);
    }

    #[test]
    fn replays_and_too_old_are_rejected() {
        let (mut tx, mut rx) = pair();
        let mut p = Vec::new();
        let sealed: Vec<Vec<u8>> = (0..3000)
            .map(|i| {
                let mut d = Vec::new();
                tx.seal(Kind::Audio, 1, &[i as u8; 8], &mut d);
                d
            })
            .collect();
        // out of order inside the window is fine, each exactly once
        assert!(rx.open(&sealed[10], &mut p).is_ok());
        assert!(rx.open(&sealed[3], &mut p).is_ok());
        assert_eq!(rx.open(&sealed[3], &mut p).unwrap_err(), OpenError::Replay);
        assert_eq!(rx.open(&sealed[10], &mut p).unwrap_err(), OpenError::Replay);
        assert!(rx.open(&sealed[2999], &mut p).is_ok()); // pn 3000
        // pn 952 is exactly 2048 behind: too old; pn 953 is the oldest still inside
        assert_eq!(rx.open(&sealed[951], &mut p).unwrap_err(), OpenError::Replay);
        assert!(rx.open(&sealed[952], &mut p).is_ok());
        assert_eq!(rx.open(&sealed[952], &mut p).unwrap_err(), OpenError::Replay);
    }

    #[test]
    fn replay_window_bits() {
        let mut w = ReplayWindow::default();
        assert!(!w.check(0));
        assert!(w.check(1));
        w.accept(5);
        assert!(!w.check(5));
        assert!(w.check(4));
        w.accept(5 + REPLAY_WINDOW + 10); // jump beyond the window clears it
        assert!(!w.check(5));
        assert!(w.check(20));
        w.accept(20);
        assert!(!w.check(20));
        w.accept(5 + REPLAY_WINDOW + 11);
        assert!(!w.check(20));
        assert!(w.check(21));
    }

    /// The epoch boundary at 2^24: the sealer and the opener both derive key(1) and the opener keeps key(0) for
    /// packets reordered across the boundary.
    #[test]
    fn epoch_boundary() {
        let (mut tx, mut rx) = pair();
        let mut p = Vec::new();
        tx.skip_to(REKEY_INTERVAL - 2);
        let mut old = Vec::new();
        tx.seal(Kind::Video, 3, b"last of epoch 0", &mut old); // pn 2^24 - 2
        let mut d = Vec::new();
        tx.seal(Kind::Video, 3, b"also epoch 0", &mut d); // pn 2^24 - 1
        assert_eq!(d[1], 0);
        assert!(rx.open(&d, &mut p).is_ok());
        let pn = tx.seal(Kind::Video, 3, b"first of epoch 1", &mut d);
        assert_eq!(pn, REKEY_INTERVAL);
        assert_eq!(d[1], 1);
        assert!(rx.open(&d, &mut p).is_ok());
        assert_eq!(p, b"first of epoch 1");
        // a packet of epoch 0 that arrives late still opens with the kept previous key
        assert!(rx.open(&old, &mut p).is_ok());
        // a wrong epoch byte is rejected before any decryption
        tx.seal(Kind::Video, 3, b"x", &mut d);
        d[1] = 0;
        assert_eq!(rx.open(&d, &mut p).unwrap_err(), OpenError::Epoch);
        // an epoch two ahead is out of range
        tx.skip_to(3 * REKEY_INTERVAL);
        tx.seal(Kind::Video, 3, b"far ahead", &mut d);
        assert_eq!(rx.open(&d, &mut p).unwrap_err(), OpenError::Epoch);
        // a sealer that started at 0 and one that skipped derive the same epoch-1 key
        let k = random_key_half();
        let (mut a, mut b) = (Sealer::new(k), Sealer::new(k));
        a.skip_to(REKEY_INTERVAL);
        b.skip_to(REKEY_INTERVAL - 1);
        let mut x = Vec::new();
        b.seal(Kind::Ctrl, 1, b"", &mut x);
        let (mut da, mut db) = (Vec::new(), Vec::new());
        a.seal(Kind::Ctrl, 1, b"same", &mut da);
        b.seal(Kind::Ctrl, 1, b"same", &mut db);
        assert_eq!(da, db);
    }
}

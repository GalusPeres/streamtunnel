//! Packet protection (docs/NATIVE-PATH.md §5).
//!
//! * Each side of a link draws an ephemeral X25519 key pair ([`KeyShare`]); the public keys travel in the
//!   E2E-encrypted signaling (`nv` join / offer). Being a room member is the authentication, exactly as for the
//!   signaling itself. The Diffie-Hellman keeps the media from everyone who can only read the signaling (every holder
//!   of the room code can): recorded packets stay sealed, also later, because the secrets are wiped once the keys are
//!   derived. Someone who forges signaling can still sit in the middle, as with WebRTC's DTLS.
//! * shared = X25519(our secret, peer public), refused if it is all zeros (a low-order peer key);
//!   okm = HKDF-SHA256(salt = "stm/1 salt", ikm = shared ‖ sharer public ‖ viewer public,
//!   info = "stm/1 keys" ‖ sharer link id (u32 BE) ‖ viewer link id (u32 BE), 64 bytes);
//!   sharer → viewer key = okm[0..32], viewer → sharer key = okm[32..64].
//! * AES-256-GCM, nonce = 0u32 ‖ packet number (u64 BE), AAD = the 14-byte header. Directional keys, so one packet
//!   number space per direction never repeats a nonce.
//! * Rekey every 2^24 packets: key(e + 1) = HKDF-Expand(PRK = key(e), info = "stm/1 rekey", 32); the epoch byte is
//!   (pn >> 24) as u8. The receiver keeps the previous, current and next epoch key.
//! * Replay: 2048-packet sliding window per direction, updated only after the tag verified.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use hkdf::{Hkdf, HkdfExtract};
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey};

use crate::net::wire::{Header, Kind, HEADER_LEN, TAG_LEN};
use crate::Role;

pub const PUBLIC_KEY_LEN: usize = 32;
/// Packets per key epoch.
pub const REKEY_INTERVAL: u64 = 1 << 24;
/// Replay window size in packets.
pub const REPLAY_WINDOW: u64 = 2048;

const SALT: &[u8] = b"stm/1 salt";
const INFO_KEYS: &[u8] = b"stm/1 keys";
const INFO_REKEY: &[u8] = b"stm/1 rekey";

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

/// One side's ephemeral X25519 key pair of a link. The secret is used once ([`KeyShare::agree`]) and wiped then
/// (or when the link drops it unused).
pub struct KeyShare {
    secret: EphemeralSecret,
    public: [u8; PUBLIC_KEY_LEN],
}

impl KeyShare {
    /// A fresh key pair from the OS RNG. Panics only if the OS has no RNG at all.
    pub fn new() -> KeyShare {
        let secret = EphemeralSecret::random();
        let public = PublicKey::from(&secret).to_bytes();
        KeyShare { secret, public }
    }

    /// Our public key (goes into the `nv` join / offer as 64 hex digits).
    pub fn public(&self) -> [u8; PUBLIC_KEY_LEN] {
        self.public
    }

    /// The link keys from our secret and the peer's public key; consumes the secret. None if the peer's key is a
    /// low-order point: the shared secret would be all zeros, known to everyone.
    pub fn agree(self, role: Role, peer_public: &[u8; PUBLIC_KEY_LEN], own_link: u32, peer_link: u32) -> Option<LinkKeys> {
        let KeyShare { secret, public } = self;
        let shared = secret.diffie_hellman(&PublicKey::from(*peer_public));
        if !shared.was_contributory() {
            return None;
        }
        Some(match role {
            Role::Share => derive_link_keys(role, shared.as_bytes(), &public, peer_public, own_link, peer_link),
            Role::Watch => derive_link_keys(role, shared.as_bytes(), peer_public, &public, peer_link, own_link),
        })
    }
}

impl Default for KeyShare {
    fn default() -> Self {
        KeyShare::new()
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

/// Derives the link keys from the X25519 shared secret (see module docs). `role` picks which half of the okm is tx.
pub fn derive_link_keys(role: Role, shared: &[u8; 32], sharer_public: &[u8; 32], viewer_public: &[u8; 32], sharer_link: u32, viewer_link: u32) -> LinkKeys {
    // ikm = shared ‖ sharer public ‖ viewer public, fed in parts (the secret is not copied into a buffer)
    let mut extract = HkdfExtract::<Sha256>::new(Some(SALT));
    extract.input_ikm(shared);
    extract.input_ikm(sharer_public);
    extract.input_ikm(viewer_public);
    let (_, hkdf): (_, Hkdf<Sha256>) = extract.finalize();
    let mut info = [0u8; 18];
    info[..10].copy_from_slice(INFO_KEYS);
    info[10..14].copy_from_slice(&sharer_link.to_be_bytes());
    info[14..18].copy_from_slice(&viewer_link.to_be_bytes());
    let mut okm = [0u8; 64];
    hkdf.expand(&info, &mut okm).expect("64 bytes is a valid HKDF-SHA256 length");
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

    /// Tests: the key of the current epoch.
    #[doc(hidden)]
    pub fn current_key(&self) -> [u8; 32] {
        self.key.raw
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

    /// Tests: the key of the current epoch.
    #[doc(hidden)]
    pub fn current_key(&self) -> [u8; 32] {
        self.cur.raw
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

    /// RFC 7748 §6.1 key pairs as sharer (Alice) and viewer (Bob), fixed link ids → fixed keys. The expected values
    /// were computed independently (Python's `cryptography` X25519 and an hmac HKDF), so a change of salt, ikm or
    /// info layout or okm split shows up here.
    #[test]
    fn known_answer_keys() {
        let alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let bob = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
        let alice_public = x25519_dalek::x25519(alice, x25519_dalek::X25519_BASEPOINT_BYTES);
        let bob_public = x25519_dalek::x25519(bob, x25519_dalek::X25519_BASEPOINT_BYTES);
        assert_eq!(alice_public, hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"));
        assert_eq!(bob_public, hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"));
        let shared = x25519_dalek::x25519(alice, bob_public);
        assert_eq!(shared, x25519_dalek::x25519(bob, alice_public));
        assert_eq!(shared, hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"));

        let s2v = hex("a863adffbb920ba7374a1c20b178281ce7d34c6a876486290817696b518c1ac5");
        let v2s = hex("049484e673524d863d83e827e6426d77cb64cbdc33cf2b39aedb41bde737c895");
        let share = derive_link_keys(Role::Share, &shared, &alice_public, &bob_public, 0x0102_0304, 0xa0b0_c0d0);
        assert_eq!((share.tx, share.rx), (s2v, v2s));
        // the two roles derive mirrored keys
        let watch = derive_link_keys(Role::Watch, &shared, &alice_public, &bob_public, 0x0102_0304, 0xa0b0_c0d0);
        assert_eq!((watch.tx, watch.rx), (v2s, s2v));
        assert_eq!(next_epoch_key(&s2v), hex("4106c194f6e6f42155f61d572cc854d78f99b28c3af2e69b331e3e2fa55187f9"));
        // swapped link ids or public keys give other keys
        let other = derive_link_keys(Role::Share, &shared, &alice_public, &bob_public, 0xa0b0_c0d0, 0x0102_0304);
        assert_ne!(other.tx, s2v);
        let other = derive_link_keys(Role::Share, &shared, &bob_public, &alice_public, 0x0102_0304, 0xa0b0_c0d0);
        assert_ne!(other.tx, s2v);
    }

    /// Two fresh key shares agree on mirrored keys; another peer key gives other keys.
    #[test]
    fn key_shares_agree() {
        let (s, v) = (KeyShare::new(), KeyShare::new());
        let (s_public, v_public) = (s.public(), v.public());
        assert_ne!(s_public, v_public);
        let share = s.agree(Role::Share, &v_public, 7, 9).unwrap();
        let watch = v.agree(Role::Watch, &s_public, 9, 7).unwrap();
        assert_eq!((share.tx, share.rx), (watch.rx, watch.tx));
        assert_ne!(share.tx, share.rx);
        // someone who swaps in their own public key (forged signaling) shares keys with that side only
        let mallory = KeyShare::new();
        let fake = mallory.agree(Role::Watch, &s_public, 9, 7).unwrap();
        assert_ne!(fake.rx, share.tx);
    }

    /// Low-order peer keys (the shared secret would be zero for any secret) are refused.
    #[test]
    fn low_order_keys_are_refused() {
        let mut one = [0u8; 32];
        one[0] = 1;
        // order 8: 0x5f9c95bc… (RFC 7748 §7 / libsodium's blocklist), plus p − 1 and p and p + 1
        let order8 = hex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157");
        let p_minus_1 = hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
        let p = hex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
        for bad in [[0u8; 32], one, order8, p_minus_1, p] {
            assert!(KeyShare::new().agree(Role::Share, &bad, 1, 2).is_none(), "{}", crate::to_hex(&bad));
        }
    }

    fn random_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        getrandom::fill(&mut k).unwrap();
        k
    }

    fn pair() -> (Sealer, Opener) {
        let (s, v) = (KeyShare::new(), KeyShare::new());
        let (s_public, v_public) = (s.public(), v.public());
        let share = s.agree(Role::Share, &v_public, 1, 2).unwrap();
        let watch = v.agree(Role::Watch, &s_public, 2, 1).unwrap();
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
        let k = random_key();
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

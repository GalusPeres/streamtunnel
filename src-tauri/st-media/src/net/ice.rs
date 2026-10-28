//! ICE-lite (docs/NATIVE-PATH.md §7): candidates, STUN on the app's one socket, simultaneous probing.
//!
//! * candidates = our host addresses (IPv4 private + public, IPv6 global; no loopback / link-local) with the
//!   socket's port, plus server-reflexive addresses from STUN binding requests sent from the SAME socket;
//! * both ends probe every remote candidate every [`PROBE_INTERVAL_MS`] from the moment they know the peer's key
//!   half; a valid probe is answered at once (reply to the source address, which may be a new peer-reflexive one);
//! * the first remote address whose reply arrives wins on each side independently (both are valid paths);
//! * no reply within [`DEADLINE_MS`] of `set_remote` → the link fails and the app falls back to WebRTC.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use std::net::{IpAddr, SocketAddr};

pub const PROBE_INTERVAL_MS: u64 = 20;
/// Link setup deadline from `set_remote` (ms).
pub const DEADLINE_MS: u64 = 2500;
/// STUN: per-server retransmits at 0 / 250 / 750 ms, give up after this (ms).
pub const STUN_TIMEOUT_MS: u64 = 1500;
/// Server-reflexive results are reused for new links for this long (ms).
pub const SRFLX_CACHE_MS: u64 = 30_000;
/// Most remote candidates accepted per link (signaling is untrusted input).
pub const MAX_REMOTE_CANDIDATES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CandidateKind {
    /// an address of one of our interfaces
    Host,
    /// our public address as a STUN server saw it
    Srflx,
    /// learned from an authenticated probe's source address (never signaled)
    Prflx,
}

impl CandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateKind::Host => "host",
            CandidateKind::Srflx => "srflx",
            CandidateKind::Prflx => "prflx",
        }
    }
}

/// One transport address. On the signaling wire: `{ a: "ip:port" | "[v6]:port", k: "host" | "srflx" }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Candidate {
    pub addr: SocketAddr,
    pub kind: CandidateKind,
}

impl Candidate {
    /// From the signaling fields; None for anything malformed, port 0, unspecified / multicast addresses or a kind
    /// other than host / srflx.
    pub fn parse(a: &str, k: &str) -> Option<Candidate> {
        let kind = match k {
            "host" => CandidateKind::Host,
            "srflx" => CandidateKind::Srflx,
            _ => return None,
        };
        let addr: SocketAddr = a.parse().ok()?;
        if addr.port() == 0 || addr.ip().is_unspecified() || addr.ip().is_multicast() {
            return None;
        }
        Some(Candidate { addr, kind })
    }

    /// "ip:port" / "[v6]:port" (std's SocketAddr format, which `parse` reads back).
    pub fn addr_string(&self) -> String {
        self.addr.to_string()
    }
}

/// Usable local interface addresses (see module docs); `loopback` (in-process tests) → only 127.0.0.1.
pub fn host_addresses(loopback: bool) -> Vec<IpAddr> {
    todo!("NET: GetAdaptersAddresses on Windows, getifaddrs on unix")
}

/// "stun:host:port" / "stun:host" (port 3478) → (host, port); None for turn:, stuns: or garbage.
pub fn parse_stun_url(url: &str) -> Option<(String, u16)> {
    todo!("NET")
}

/// RFC 8489 Binding Request with the given 96-bit transaction id (20 bytes, no attributes).
pub fn stun_request(txid: &[u8; 12]) -> [u8; 20] {
    todo!("NET")
}

/// XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of a Binding Success Response with this transaction id.
pub fn parse_stun_response(b: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    todo!("NET")
}

/// "lan" when the remote address is on one of our private subnets: same /24 for RFC 1918 IPv4, same /64 for IPv6
/// unique-local or global — the same heuristic the WebRTC path uses.
pub fn is_lan(local: &[IpAddr], remote: SocketAddr) -> bool {
    todo!("NET")
}

/// Probe schedule and pair selection of one link (sans-IO).
pub struct Checklist {
    // filled by NET
}

impl Checklist {
    /// Starts the deadline at `now_us`.
    pub fn new(now_us: u64) -> Self {
        todo!("NET")
    }

    /// Adds remote candidates (deduplicated, capped at [`MAX_REMOTE_CANDIDATES`]).
    pub fn add_remote(&mut self, cands: &[Candidate]) {
        todo!("NET")
    }

    /// Remote addresses to probe now.
    pub fn due(&mut self, now_us: u64) -> Vec<SocketAddr> {
        todo!("NET")
    }

    /// An authenticated probe arrived from `from` (adds it as peer-reflexive if new).
    pub fn on_probe(&mut self, from: SocketAddr) {
        todo!("NET")
    }

    /// An authenticated probe reply from `from`; returns the selected address the first time.
    pub fn on_reply(&mut self, from: SocketAddr, rtt_us: u64) -> Option<SocketAddr> {
        todo!("NET")
    }

    pub fn selected(&self) -> Option<SocketAddr> {
        todo!("NET")
    }

    /// true once the deadline passed without a selected address
    pub fn failed(&self, now_us: u64) -> bool {
        todo!("NET")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_wire_format() {
        let c = Candidate::parse("192.168.1.20:50123", "host").unwrap();
        assert_eq!(c.addr_string(), "192.168.1.20:50123");
        let v6 = Candidate::parse("[2001:db8::1]:4000", "srflx").unwrap();
        assert_eq!(v6.addr_string(), "[2001:db8::1]:4000");
        assert_eq!(v6.kind, CandidateKind::Srflx);
        assert!(Candidate::parse("192.168.1.20:0", "host").is_none());
        assert!(Candidate::parse("0.0.0.0:5", "host").is_none());
        assert!(Candidate::parse("1.2.3.4:5", "prflx").is_none());
        assert!(Candidate::parse("example.org:5", "host").is_none());
    }
}

//! ICE-lite (docs/NATIVE-PATH.md §7): candidates, STUN on the app's one socket, simultaneous probing.
//!
//! * candidates = our host addresses (IPv4 private + public, IPv6 global; no loopback / link-local) with the
//!   socket's port, plus server-reflexive addresses from STUN binding requests sent from the SAME socket;
//! * both ends probe every remote candidate every [`PROBE_INTERVAL_MS`] from the moment they know the peer's key
//!   half; a valid probe is answered at once (reply to the source address, which may be a new peer-reflexive one);
//! * the first remote address whose reply arrives wins on each side independently (both are valid paths);
//! * no reply within [`DEADLINE_MS`] of `set_remote` → the link fails and the app falls back to WebRTC.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const PROBE_INTERVAL_MS: u64 = 20;
/// Link setup deadline from `set_remote` (ms).
pub const DEADLINE_MS: u64 = 2500;
/// STUN: per-server retransmits at 0 / 250 / 750 ms, give up after this (ms).
pub const STUN_TIMEOUT_MS: u64 = 1500;
/// Server-reflexive results are reused for new links for this long (ms).
pub const SRFLX_CACHE_MS: u64 = 30_000;
/// Most remote candidates accepted per link (signaling is untrusted input).
pub const MAX_REMOTE_CANDIDATES: usize = 16;
/// Peer-reflexive addresses learned from probes, at most (on top of the signaled ones).
pub const MAX_PRFLX: usize = 4;
/// Host candidates we offer, at most.
pub const MAX_HOST_CANDIDATES: usize = 8;
/// STUN magic cookie (RFC 8489).
pub const STUN_COOKIE: u32 = 0x2112_A442;

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

/// The address as an IPv4 one when it is an IPv4-mapped IPv6 address (what a dual-stack socket reports).
pub fn canonical(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

fn ipv6_unique_local(ip: &Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

fn ipv6_global_unicast(ip: &Ipv6Addr) -> bool {
    ip.segments()[0] & 0xe000 == 0x2000
}

/// An interface address worth offering: IPv4 except loopback / link-local / unspecified / broadcast / multicast,
/// IPv6 global or unique-local only.
pub fn usable_host_address(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => !(v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast()),
        IpAddr::V6(v6) => ipv6_global_unicast(&v6) || ipv6_unique_local(&v6),
    }
}

/// Usable local interface addresses (see module docs); `loopback` (in-process tests) → only 127.0.0.1.
pub fn host_addresses(loopback: bool) -> Vec<IpAddr> {
    if loopback {
        return vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    }
    let mut ips: Vec<IpAddr> = interface_addresses().into_iter().map(|ip| ip.to_canonical()).filter(|ip| usable_host_address(*ip)).collect();
    // private IPv4 first (the LAN case), then public IPv4, then IPv6
    ips.sort_by_key(|ip| match ip {
        IpAddr::V4(v4) if v4.is_private() => 0,
        IpAddr::V4(_) => 1,
        IpAddr::V6(v6) if ipv6_unique_local(v6) => 2,
        IpAddr::V6(_) => 3,
    });
    let mut out: Vec<IpAddr> = Vec::new();
    for ip in ips {
        if !out.contains(&ip) && out.len() < MAX_HOST_CANDIDATES {
            out.push(ip);
        }
    }
    out
}

/// Addresses of the interfaces that are up (unfiltered).
#[cfg(windows)]
fn interface_addresses() -> Vec<IpAddr> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_FRIENDLY_NAME, GAA_FLAG_SKIP_MULTICAST,
        GET_ADAPTERS_ADDRESSES_FLAGS, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::Networking::WinSock::{IpDadStatePreferred, AF_UNSPEC};
    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    const IF_OPER_STATUS_UP: i32 = 1;

    let flags = GET_ADAPTERS_ADDRESSES_FLAGS(
        GAA_FLAG_SKIP_ANYCAST.0 | GAA_FLAG_SKIP_MULTICAST.0 | GAA_FLAG_SKIP_DNS_SERVER.0 | GAA_FLAG_SKIP_FRIENDLY_NAME.0,
    );
    let mut size: u32 = 16 * 1024;
    for _ in 0..4 {
        // u64 storage: the adapter list needs 8-byte alignment
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let first = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let r = unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(first), &mut size) };
        if r == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if r != 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut adapter = first as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            // SAFETY: a linked list inside `buf`, written by GetAdaptersAddresses
            let a = unsafe { &*adapter };
            if a.OperStatus.0 == IF_OPER_STATUS_UP && a.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                let mut unicast = a.FirstUnicastAddress as *const windows::Win32::NetworkManagement::IpHelper::IP_ADAPTER_UNICAST_ADDRESS_LH;
                while !unicast.is_null() {
                    let u = unsafe { &*unicast };
                    if u.DadState == IpDadStatePreferred {
                        if let Some(ip) = unsafe { sockaddr_ip(u.Address.lpSockaddr as *const u8, u.Address.iSockaddrLength) } {
                            out.push(ip);
                        }
                    }
                    unicast = u.Next;
                }
            }
            adapter = a.Next;
        }
        return out;
    }
    Vec::new()
}

/// The IP of a raw Windows SOCKADDR (AF_INET = 2: address at 4..8; AF_INET6 = 23: address at 8..24).
#[cfg(windows)]
unsafe fn sockaddr_ip(p: *const u8, len: i32) -> Option<IpAddr> {
    if p.is_null() || len < 16 {
        return None;
    }
    let b = unsafe { std::slice::from_raw_parts(p, len as usize) };
    match u16::from_ne_bytes([b[0], b[1]]) {
        2 => Some(IpAddr::V4(Ipv4Addr::new(b[4], b[5], b[6], b[7]))),
        23 if b.len() >= 24 => {
            let mut a = [0u8; 16];
            a.copy_from_slice(&b[8..24]);
            Some(IpAddr::V6(Ipv6Addr::from(a)))
        }
        _ => None,
    }
}

/// Addresses of the interfaces that are up and not loopback (unfiltered).
#[cfg(unix)]
fn interface_addresses() -> Vec<IpAddr> {
    let mut out = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates the list, freeifaddrs releases it; every pointer is checked before use
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut cur = list;
        while !cur.is_null() {
            let ifa = &*cur;
            let flags = ifa.ifa_flags as libc::c_int;
            if !ifa.ifa_addr.is_null() && flags & libc::IFF_UP != 0 && flags & libc::IFF_LOOPBACK == 0 {
                match (*ifa.ifa_addr).sa_family as libc::c_int {
                    libc::AF_INET => {
                        let sa = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                        out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sa.sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let sa = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                        out.push(IpAddr::V6(Ipv6Addr::from(sa.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    out
}

#[cfg(not(any(windows, unix)))]
fn interface_addresses() -> Vec<IpAddr> {
    Vec::new()
}

/// "stun:host:port" / "stun:host" (port 3478) → (host, port); None for turn:, stuns: or garbage.
pub fn parse_stun_url(url: &str) -> Option<(String, u16)> {
    let rest = url.trim().strip_prefix("stun:")?;
    let rest = rest.split('?').next().unwrap_or_default(); // "?transport=udp"
    if rest.is_empty() || rest.contains(|c: char| c.is_whitespace() || matches!(c, '/' | '@' | '#')) {
        return None;
    }
    let port = |p: &str| -> Option<u16> { p.parse::<u16>().ok().filter(|p| *p != 0) };
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (host, after) = v6.split_once(']')?;
        host.parse::<Ipv6Addr>().ok()?;
        match after {
            "" => (host, 3478),
            _ => (host, port(after.strip_prefix(':')?)?),
        }
    } else {
        match rest.rsplit_once(':') {
            Some((h, _)) if h.contains(':') => return None, // a bare IPv6 address needs brackets
            Some((h, p)) => (h, port(p)?),
            None => (rest, 3478),
        }
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

/// RFC 8489 Binding Request with the given 96-bit transaction id (20 bytes, no attributes).
pub fn stun_request(txid: &[u8; 12]) -> [u8; 20] {
    let mut b = [0u8; 20];
    b[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    // [2..4] message length 0
    b[4..8].copy_from_slice(&STUN_COOKIE.to_be_bytes());
    b[8..20].copy_from_slice(txid);
    b
}

/// One address attribute value (family at [1], port at [2..4], address from [4]); `xor` = XOR-MAPPED-ADDRESS.
fn stun_address(v: &[u8], txid: &[u8; 12], xor: bool) -> Option<SocketAddr> {
    if v.len() < 8 {
        return None;
    }
    let cookie = STUN_COOKIE.to_be_bytes();
    let mut port = u16::from_be_bytes([v[2], v[3]]);
    if xor {
        port ^= (STUN_COOKIE >> 16) as u16;
    }
    let ip = match v[1] {
        1 => {
            let mut a = [v[4], v[5], v[6], v[7]];
            if xor {
                for (x, c) in a.iter_mut().zip(cookie) {
                    *x ^= c;
                }
            }
            IpAddr::V4(Ipv4Addr::from(a))
        }
        2 if v.len() >= 20 => {
            let mut a = [0u8; 16];
            a.copy_from_slice(&v[4..20]);
            if xor {
                for (i, x) in a.iter_mut().enumerate() {
                    *x ^= if i < 4 { cookie[i] } else { txid[i - 4] };
                }
            }
            IpAddr::V6(Ipv6Addr::from(a))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of a Binding Success Response with this transaction id.
pub fn parse_stun_response(b: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    if b.len() < 20 || b[0..2] != [0x01, 0x01] || b[4..8] != STUN_COOKIE.to_be_bytes() || b[8..20] != txid[..] {
        return None;
    }
    let len = u16::from_be_bytes([b[2], b[3]]) as usize;
    if !len.is_multiple_of(4) || 20 + len > b.len() {
        return None;
    }
    let attrs = &b[20..20 + len];
    let (mut xor_mapped, mut mapped) = (None, None);
    let mut at = 0;
    while at + 4 <= attrs.len() {
        let t = u16::from_be_bytes([attrs[at], attrs[at + 1]]);
        let l = u16::from_be_bytes([attrs[at + 2], attrs[at + 3]]) as usize;
        let Some(v) = attrs.get(at + 4..at + 4 + l) else { break };
        match t {
            0x0020 => xor_mapped = xor_mapped.or(stun_address(v, txid, true)),
            0x0001 => mapped = mapped.or(stun_address(v, txid, false)),
            _ => {}
        }
        at += 4 + l.div_ceil(4) * 4;
    }
    xor_mapped.or(mapped).map(canonical)
}

/// "lan" when the remote address is on one of our private subnets: same /24 for RFC 1918 IPv4, same /64 for IPv6
/// unique-local or global — the same heuristic the WebRTC path uses. The own machine (loopback) counts as LAN.
pub fn is_lan(local: &[IpAddr], remote: SocketAddr) -> bool {
    match remote.ip().to_canonical() {
        ip if ip.is_loopback() => true,
        IpAddr::V4(r) if r.is_private() => {
            local.iter().any(|l| matches!(l.to_canonical(), IpAddr::V4(l) if l.is_private() && l.octets()[..3] == r.octets()[..3]))
        }
        IpAddr::V6(r) if ipv6_unique_local(&r) || ipv6_global_unicast(&r) => {
            local.iter().any(|l| matches!(l, IpAddr::V6(l) if l.octets()[..8] == r.octets()[..8]))
        }
        _ => false,
    }
}

struct Remote {
    addr: SocketAddr,
    kind: CandidateKind,
    next_us: u64,
}

/// Probe schedule and pair selection of one link (sans-IO).
pub struct Checklist {
    deadline_us: u64,
    remotes: Vec<Remote>,
    selected: Option<SocketAddr>,
}

impl Checklist {
    /// Starts the deadline at `now_us`.
    pub fn new(now_us: u64) -> Self {
        Checklist { deadline_us: now_us + DEADLINE_MS * 1000, remotes: Vec::new(), selected: None }
    }

    fn count(&self, prflx: bool) -> usize {
        self.remotes.iter().filter(|r| (r.kind == CandidateKind::Prflx) == prflx).count()
    }

    /// Adds remote candidates (deduplicated, capped at [`MAX_REMOTE_CANDIDATES`]).
    pub fn add_remote(&mut self, cands: &[Candidate]) {
        for c in cands {
            let addr = canonical(c.addr);
            if c.kind == CandidateKind::Prflx || self.remotes.iter().any(|r| r.addr == addr) {
                continue;
            }
            if self.count(false) >= MAX_REMOTE_CANDIDATES {
                break;
            }
            self.remotes.push(Remote { addr, kind: c.kind, next_us: 0 });
        }
    }

    /// Remote addresses to probe now.
    pub fn due(&mut self, now_us: u64) -> Vec<SocketAddr> {
        if self.selected.is_some() || self.failed(now_us) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for r in self.remotes.iter_mut().filter(|r| r.next_us <= now_us) {
            r.next_us = now_us + PROBE_INTERVAL_MS * 1000;
            out.push(r.addr);
        }
        out
    }

    /// An authenticated probe arrived from `from` (adds it as peer-reflexive if new).
    pub fn on_probe(&mut self, from: SocketAddr) {
        let from = canonical(from);
        if self.selected.is_none() && !self.remotes.iter().any(|r| r.addr == from) && self.count(true) < MAX_PRFLX {
            self.remotes.push(Remote { addr: from, kind: CandidateKind::Prflx, next_us: 0 });
        }
    }

    /// An authenticated probe reply from `from`; returns the selected address the first time.
    pub fn on_reply(&mut self, from: SocketAddr, rtt_us: u64) -> Option<SocketAddr> {
        let _ = rtt_us; // the first answer wins, whatever its RTT
        if self.selected.is_some() {
            return None;
        }
        self.selected = Some(canonical(from));
        self.selected
    }

    pub fn selected(&self) -> Option<SocketAddr> {
        self.selected
    }

    /// true once the deadline passed without a selected address
    pub fn failed(&self, now_us: u64) -> bool {
        self.selected.is_none() && now_us >= self.deadline_us
    }

    /// Remote addresses known so far (signaled and peer-reflexive).
    pub fn remotes(&self) -> Vec<SocketAddr> {
        self.remotes.iter().map(|r| r.addr).collect()
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

    #[test]
    fn stun_urls() {
        let p = |s: &str| parse_stun_url(s);
        assert_eq!(p("stun:stun.l.google.com:19302"), Some(("stun.l.google.com".into(), 19302)));
        assert_eq!(p("stun:stun.cloudflare.com"), Some(("stun.cloudflare.com".into(), 3478)));
        assert_eq!(p(" stun:1.2.3.4:3478?transport=udp "), Some(("1.2.3.4".into(), 3478)));
        assert_eq!(p("stun:[2001:db8::1]:5000"), Some(("2001:db8::1".into(), 5000)));
        assert_eq!(p("stun:[2001:db8::1]"), Some(("2001:db8::1".into(), 3478)));
        for bad in ["turn:x.org", "stuns:x.org", "stun:", "stun:x.org:0", "stun:x.org:99999", "stun:2001:db8::1", "stun:a b", "stun:[x]:1", "stun::5", "http://x"] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    #[test]
    fn stun_request_bytes() {
        let txid: [u8; 12] = std::array::from_fn(|i| i as u8 + 1);
        let r = stun_request(&txid);
        assert_eq!(&r[..8], &[0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(&r[8..], &txid);
        assert!(crate::net::wire::is_stun(&r));
    }

    const RFC5769_TXID: [u8; 12] = [0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae];

    /// RFC 5769 §2.2: sample IPv4 response (SOFTWARE, XOR-MAPPED-ADDRESS, MESSAGE-INTEGRITY, FINGERPRINT).
    const RFC5769_V4: [u8; 80] = [
        0x01, 0x01, 0x00, 0x3c, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x00, 0x20, 0x00, 0x08,
        0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43, 0x00, 0x08, 0x00, 0x14, 0x2b, 0x91, 0xf5, 0x99, 0xfd, 0x9e, 0x90, 0xc3,
        0x8c, 0x74, 0x89, 0xf9, 0x2a, 0xf9, 0xba, 0x53, 0xf0, 0x6b, 0xe7, 0xd7, 0x80, 0x28, 0x00, 0x04, 0xc0, 0x7d, 0x4c, 0x96,
    ];

    /// RFC 5769 §2.3: sample IPv6 response.
    const RFC5769_V6: [u8; 92] = [
        0x01, 0x01, 0x00, 0x48, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x00, 0x20, 0x00, 0x14,
        0x00, 0x02, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3, 0xf1, 0x79, 0xbc, 0x25, 0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9,
        0x00, 0x08, 0x00, 0x14, 0xa3, 0x82, 0x95, 0x4e, 0x4b, 0xe6, 0x7b, 0xf1, 0x17, 0x84, 0xc9, 0x7c, 0x82, 0x92, 0xc2, 0x75,
        0xbf, 0xe3, 0xed, 0x41, 0x80, 0x28, 0x00, 0x04, 0xc8, 0xfb, 0x0b, 0x4c,
    ];

    #[test]
    fn stun_responses_rfc5769() {
        assert!(crate::net::wire::is_stun(&RFC5769_V4));
        assert_eq!(parse_stun_response(&RFC5769_V4, &RFC5769_TXID), Some("192.0.2.1:32853".parse().unwrap()));
        assert_eq!(
            parse_stun_response(&RFC5769_V6, &RFC5769_TXID),
            Some("[2001:db8:1234:5678:11:2233:4455:6677]:32853".parse().unwrap())
        );
        // another transaction id, a request type, a broken length: rejected
        let mut other = RFC5769_TXID;
        other[11] ^= 1;
        assert_eq!(parse_stun_response(&RFC5769_V4, &other), None);
        let mut req = RFC5769_V4;
        req[1] = 0x11; // error response
        assert_eq!(parse_stun_response(&req, &RFC5769_TXID), None);
        let mut bad_len = RFC5769_V4;
        bad_len[3] = 0x40;
        assert_eq!(parse_stun_response(&bad_len, &RFC5769_TXID), None);
        assert_eq!(parse_stun_response(&RFC5769_V4[..60], &RFC5769_TXID), None);
        // plain MAPPED-ADDRESS (old servers) is the fallback; an IPv4-mapped answer becomes plain IPv4
        let mut m = stun_request(&RFC5769_TXID).to_vec();
        m[0..2].copy_from_slice(&[0x01, 0x01]);
        m[2..4].copy_from_slice(&12u16.to_be_bytes());
        m.extend_from_slice(&[0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x0d, 0x96, 203, 0, 113, 7]);
        assert_eq!(parse_stun_response(&m, &RFC5769_TXID), Some("203.0.113.7:3478".parse().unwrap()));
    }

    #[test]
    fn lan_heuristic() {
        let local: Vec<IpAddr> = vec!["192.168.1.20".parse().unwrap(), "10.0.0.5".parse().unwrap(), "2001:db8:aa:bb:1::5".parse().unwrap()];
        let lan = |a: &str| is_lan(&local, a.parse().unwrap());
        assert!(lan("192.168.1.77:5000"));
        assert!(lan("[::ffff:192.168.1.77]:5000")); // as a dual-stack socket reports it
        assert!(!lan("192.168.2.77:5000"));
        assert!(lan("10.0.0.99:1"));
        assert!(!lan("10.0.1.99:1"));
        assert!(!lan("8.8.8.8:53")); // public, even if it were "close"
        assert!(lan("[2001:db8:aa:bb:ffff::1]:9"));
        assert!(!lan("[2001:db8:aa:bc::1]:9"));
        assert!(lan("127.0.0.1:4000"));
        assert!(!is_lan(&[], "192.168.1.77:5000".parse().unwrap()));
    }

    #[test]
    fn host_address_filter() {
        for ok in ["192.168.1.2", "10.1.2.3", "84.12.3.4", "2001:db8::1", "fd00::1"] {
            assert!(usable_host_address(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["127.0.0.1", "169.254.1.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "::1", "fe80::1", "ff02::1", "::"] {
            assert!(!usable_host_address(bad.parse().unwrap()), "{bad}");
        }
        assert_eq!(host_addresses(true), vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        // the real interfaces: whatever they are, only usable ones, private IPv4 first, no duplicates
        let real = host_addresses(false);
        assert!(real.len() <= MAX_HOST_CANDIDATES);
        assert!(real.iter().all(|ip| usable_host_address(*ip)));
    }

    fn cand(a: &str) -> Candidate {
        Candidate::parse(a, "host").unwrap()
    }

    #[test]
    fn checklist_probes_every_candidate_until_the_first_reply() {
        let mut c = Checklist::new(1_000_000);
        c.add_remote(&[cand("192.168.1.2:4000"), cand("[2001:db8::2]:4000"), cand("192.168.1.2:4000")]);
        assert_eq!(c.due(1_000_000).len(), 2); // deduplicated
        assert!(c.due(1_010_000).is_empty());
        assert_eq!(c.due(1_020_000).len(), 2); // every 20 ms
        // a probe from an unknown address (a NAT's mapping) is probed as well
        c.on_probe("203.0.113.9:6000".parse().unwrap());
        assert_eq!(c.due(1_021_000), vec!["203.0.113.9:6000".parse::<SocketAddr>().unwrap()]);
        // the first reply wins, later ones change nothing, probing stops
        let won = "[::ffff:192.168.1.2]:4000".parse().unwrap();
        assert_eq!(c.on_reply(won, 900), Some("192.168.1.2:4000".parse().unwrap()));
        assert_eq!(c.on_reply("203.0.113.9:6000".parse().unwrap(), 100), None);
        assert_eq!(c.selected(), Some("192.168.1.2:4000".parse().unwrap()));
        assert!(c.due(1_100_000).is_empty());
        assert!(!c.failed(9_000_000));
    }

    #[test]
    fn checklist_deadline_and_caps() {
        let mut c = Checklist::new(0);
        let many: Vec<Candidate> = (1..=40).map(|i| cand(&format!("10.0.0.{i}:5000"))).collect();
        c.add_remote(&many);
        assert_eq!(c.due(0).len(), MAX_REMOTE_CANDIDATES);
        for i in 0..10 {
            c.on_probe(format!("198.51.100.{i}:7").parse().unwrap());
        }
        assert_eq!(c.remotes().len(), MAX_REMOTE_CANDIDATES + MAX_PRFLX);
        assert!(!c.failed(DEADLINE_MS * 1000 - 1));
        assert!(c.failed(DEADLINE_MS * 1000));
        assert!(c.due(DEADLINE_MS * 1000).is_empty());
        // a late candidate before the deadline is probed at once
        let mut c = Checklist::new(0);
        c.add_remote(&[cand("10.0.0.1:1")]);
        c.due(0);
        c.add_remote(&[cand("10.0.0.2:1")]);
        assert_eq!(c.due(5_000), vec!["10.0.0.2:1".parse::<SocketAddr>().unwrap()]);
    }
}

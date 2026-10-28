//! The socket driver (docs/NATIVE-PATH.md §4, §7): one [`Endpoint`] per app = one dual-stack UDP socket
//! (`[::]:0`, IPV6_V6ONLY off; plain `0.0.0.0:0` if IPv6 is unavailable) shared by every [`Link`].
//!
//! Incoming datagrams are demultiplexed by the header's link id (STUN responses by transaction id), opened with
//! the link's keys and dispatched: probes and ctrl (Ping/Pong/Ack/App/Bye) are handled here, video / audio /
//! media ctrl (FrameLost, Keyframe, Report) go to the link's [`PacketHandler`] — the [`crate::send::Sender`] or
//! [`crate::recv::Receiver`] attached to it.
//!
//! Threads (all owned by the endpoint): `st-net-rx` (blocking receive, 5 ms timeout, timers: probes, pings,
//! retransmits, keepalive, deadlines, stats) and `st-net-tx` (paced sending from per-link queues). The
//! [`LinkSink`] is called on these threads: it must not block (the Tauri glue only forwards to a `Channel`).
//! In fact every [`LinkEvent`] is emitted on `st-net-rx`, so the events of a link always arrive in order and
//! nothing follows the final `Failed` / `Closed`. The sink may call back into the link.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, Weak};
use std::time::Duration;

use socket2::{Domain, Protocol, SockRef, Socket, Type};

use crate::clock::{now_us, ClockSync};
use crate::net::crypto::{self, OpenError, Opener, Sealer};
use crate::net::ctrl::{self, ByeReason, Ctrl, Reliable, MAX_APP_TEXT, MAX_UNACKED, PING_MS};
use crate::net::ice::{self, Candidate, CandidateKind, Checklist, SRFLX_CACHE_MS, STUN_TIMEOUT_MS};
use crate::net::pace::{pace_bps, Pacer};
use crate::net::wire::{self, vflags, AudioPacket, Header, Kind, Probe, VideoShard, HEADER_LEN, TAG_LEN};
use crate::stats::LinkStats;
use crate::Role;

/// A link that was up and hears nothing (not even a pong) for this long is closed (ms).
pub const LINK_TIMEOUT_MS: u64 = 5000;
/// Whole frames waiting per link: beyond this, waiting frames that have not started are dropped (their ids count as
/// lost on that link and the sender asks for a key frame for it). A frame that started is never cut.
pub const MAX_QUEUED_FRAMES: usize = 2;
/// Links per endpoint (signaling is untrusted: a flood of joins must not exhaust us).
pub const MAX_LINKS: usize = 16;
/// Receive timeout of `st-net-rx` = resolution of every link timer (µs).
pub const TICK_US: u64 = 5_000;
/// Bye goes out this many times, [`BYE_GAP_MS`] apart (no ack).
pub const BYE_REPEATS: u8 = 3;
pub const BYE_GAP_MS: u64 = 20;
/// Datagrams that fail authentication, per source address and second, before its datagrams are dropped untried.
pub const AUTH_FAILURES_PER_S: f32 = 50.0;
/// Kernel buffers of the socket (a 4K key frame is ≈ 1–2 MB; Windows' default is 64 KB).
const SOCKET_BUFFER: usize = 4 << 20;
const STATS_US: u64 = 1_000_000;
/// Datagrams one link sends per turn of `st-net-tx` (keeps the links fair).
const TX_BATCH: usize = 64;
/// STUN retransmits after the first request (ms, RFC 8489 style: 0, 250, 750).
const STUN_RETRANSMIT_MS: [u64; 2] = [250, 750];

/// Endpoint settings.
#[derive(Clone, Debug, Default)]
pub struct EndpointConfig {
    /// STUN servers as "stun:host:port" (NetConfig.stun); empty = host candidates only
    pub stun: Vec<String>,
    /// tests only: bind 127.0.0.1:0 (never a firewall prompt) and offer only 127.0.0.1 as host candidate
    pub loopback: bool,
}

/// The selected path of a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathInfo {
    /// the peer's address we send to
    pub remote: SocketAddr,
    /// both ends on the same private subnet ([`crate::net::ice::is_lan`]): LAN pacing, 10 % FEC
    pub lan: bool,
    /// RTT of the winning probe (µs)
    pub rtt_us: u64,
}

/// Events of one link, in order. `Failed` and `Closed` are final.
#[derive(Clone, Debug)]
pub enum LinkEvent {
    /// late local candidates (server-reflexive from STUN) → forward to the peer as `nvice`
    Candidates(Vec<Candidate>),
    /// a pair answered: media may flow (sharer: start sending with a key frame)
    Up(PathInfo),
    /// setup failed (no pair before the deadline, bad remote parameters) → fall back to WebRTC
    Failed(String),
    /// the link ended after it was up: "bye" (peer closed), "kicked", "ended", "timeout", "closed" (we closed)
    Closed(String),
    /// an App text from the peer (the existing CtlMessage JSON), reliable and in order
    Message(String),
    /// once per second while up
    Stats(LinkStats),
}

/// Receives a link's events (see the module docs for the threading rule).
pub type LinkSink = Arc<dyn Fn(LinkEvent) + Send + Sync>;

/// Where a link delivers its media datagrams (implemented by [`crate::send::Sender`] / [`crate::recv::Receiver`]).
pub trait PacketHandler: Send + Sync {
    fn on_video(&self, link: &Link, shard: VideoShard<'_>, now_us: u64);
    fn on_audio(&self, link: &Link, packet: AudioPacket<'_>, now_us: u64);
    /// FrameLost, Keyframe and Report only (the link consumes the others)
    fn on_ctrl(&self, link: &Link, msg: Ctrl, now_us: u64);
    /// Every network tick (≈ [`TICK_US`]) while the link is up: the handler's timers (repeats, reports, flushes).
    fn on_tick(&self, link: &Link, now_us: u64) {
        let _ = (link, now_us);
    }
}

// ───────────────────────── socket ─────────────────────────

struct Sock {
    udp: UdpSocket,
    /// a dual-stack IPv6 socket: IPv4 peers are addressed as ::ffff:a.b.c.d
    dual: bool,
}

impl Sock {
    fn reaches(&self, addr: SocketAddr) -> bool {
        self.dual || addr.is_ipv4()
    }

    fn send_to(&self, buf: &[u8], to: SocketAddr) -> bool {
        let to = match (self.dual, to) {
            (true, SocketAddr::V4(v4)) => SocketAddr::V6(SocketAddrV6::new(v4.ip().to_ipv6_mapped(), v4.port(), 0, 0)),
            (false, SocketAddr::V6(_)) => return false,
            (_, to) => to,
        };
        self.udp.send_to(buf, to).is_ok()
    }
}

/// Wakes `st-net-tx` when a link queued video.
#[derive(Default)]
struct Wake {
    pending: Mutex<bool>,
    cv: Condvar,
}

impl Wake {
    fn notify(&self) {
        *lock(&self.pending) = true;
        self.cv.notify_one();
    }

    fn wait(&self, timeout: Duration) {
        let mut g = lock(&self.pending);
        if !*g {
            g = self.cv.wait_timeout(g, timeout).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
        }
        *g = false;
    }
}

/// Locks a mutex even if a panicking thread poisoned it (the state stays usable; a panic is a bug anyway).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows: 1 ms timer resolution while an endpoint is open, so the 5 ms receive timeout and the pacing sleeps
/// are not rounded up to the default 15.6 ms tick (per process since Windows 10 2004).
fn timer_resolution(on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
        if on {
            timeBeginPeriod(1);
        } else {
            timeEndPeriod(1);
        }
    }
    #[cfg(not(windows))]
    let _ = on;
}

// ───────────────────────── STUN ─────────────────────────

struct StunTx {
    server: SocketAddr,
    txid: [u8; 12],
    sent: usize,
    first_us: u64,
    next_us: u64,
}

/// Server-reflexive gathering, shared by every link of the endpoint.
#[derive(Default)]
struct Stun {
    servers: Vec<String>,
    /// bumped by `set_stun`: results of an older gathering are dropped
    generation: u64,
    /// results of the latest gathering, valid for [`SRFLX_CACHE_MS`] from `cache_us`
    cache: Vec<Candidate>,
    cache_us: Option<u64>,
    gathering: bool,
    /// the DNS thread finished (requests may still be in flight)
    resolved: bool,
    started_us: u64,
    txs: Vec<StunTx>,
    /// links that get late results as `LinkEvent::Candidates`
    waiters: Vec<Weak<Link>>,
}

// ───────────────────────── endpoint ─────────────────────────

/// The app's UDP socket.
pub struct Endpoint {
    sock: Arc<Sock>,
    port: u16,
    loopback: bool,
    links: RwLock<HashMap<u32, Arc<Link>>>,
    stun: Mutex<Stun>,
    /// u64::MAX while open; the threads stop at this time (after the last Byes went out)
    stop_at_us: AtomicU64,
    timer: AtomicBool,
    wake: Arc<Wake>,
    me: Weak<Endpoint>,
}

/// State private to `st-net-rx`.
#[derive(Default)]
struct RxState {
    plain: Vec<u8>,
    /// per source address: (tokens, last refill µs) of the authentication-failure bucket
    buckets: HashMap<IpAddr, (f32, u64)>,
    next_tick_us: u64,
}

impl RxState {
    fn refill(b: &mut (f32, u64), now_us: u64) {
        b.0 = (b.0 + now_us.saturating_sub(b.1) as f32 * AUTH_FAILURES_PER_S / 1e6).min(AUTH_FAILURES_PER_S);
        b.1 = now_us;
    }

    fn may_try(&mut self, ip: IpAddr, now_us: u64) -> bool {
        match self.buckets.get_mut(&ip) {
            None => true,
            Some(b) => {
                Self::refill(b, now_us);
                b.0 >= 1.0
            }
        }
    }

    fn failed(&mut self, ip: IpAddr, now_us: u64) {
        if self.buckets.len() >= 1024 {
            self.buckets.retain(|_, b| now_us.saturating_sub(b.1) < 2_000_000);
        }
        let b = self.buckets.entry(ip).or_insert((AUTH_FAILURES_PER_S, now_us));
        Self::refill(b, now_us);
        b.0 -= 1.0;
    }
}

fn bind(loopback: bool) -> std::io::Result<(UdpSocket, bool)> {
    if loopback {
        return Ok((UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?, false));
    }
    let dual = || -> std::io::Result<UdpSocket> {
        let s = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
        s.set_only_v6(false)?;
        s.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
        Ok(s.into())
    };
    match dual() {
        Ok(s) => Ok((s, true)),
        Err(_) => Ok((UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?, false)),
    }
}

impl Endpoint {
    /// Binds the socket and starts the endpoint's threads.
    pub fn open(cfg: EndpointConfig) -> std::io::Result<Arc<Endpoint>> {
        let (udp, dual) = bind(cfg.loopback)?;
        let sref = SockRef::from(&udp);
        let _ = sref.set_recv_buffer_size(SOCKET_BUFFER);
        let _ = sref.set_send_buffer_size(SOCKET_BUFFER);
        udp.set_read_timeout(Some(Duration::from_micros(TICK_US)))?;
        let port = udp.local_addr()?.port();
        let sock = Arc::new(Sock { udp, dual });
        let wake = Arc::new(Wake::default());
        let ep = Arc::new_cyclic(|me| Endpoint {
            sock: sock.clone(),
            port,
            loopback: cfg.loopback,
            links: RwLock::new(HashMap::new()),
            stun: Mutex::new(Stun { servers: cfg.stun, ..Default::default() }),
            stop_at_us: AtomicU64::new(u64::MAX),
            timer: AtomicBool::new(false),
            wake: wake.clone(),
            me: me.clone(),
        });
        let weak = Arc::downgrade(&ep);
        std::thread::Builder::new().name("st-net-rx".into()).spawn(move || rx_loop(weak, sock))?;
        let weak = Arc::downgrade(&ep);
        std::thread::Builder::new().name("st-net-tx".into()).spawn(move || tx_loop(weak, wake))?;
        timer_resolution(true);
        ep.timer.store(true, Ordering::Relaxed);
        Ok(ep)
    }

    /// Local UDP port.
    pub fn port(&self) -> u16 {
        self.port
    }

    fn closed(&self) -> bool {
        self.stop_at_us.load(Ordering::Relaxed) != u64::MAX
    }

    /// Replaces the STUN server list (settings changed); cached server-reflexive results are dropped.
    pub fn set_stun(&self, stun: Vec<String>) {
        let mut st = lock(&self.stun);
        if st.servers == stun {
            return;
        }
        let generation = st.generation + 1;
        *st = Stun { servers: stun, generation, ..Default::default() };
    }

    /// New link with a fresh random link id and key half. Starts STUN gathering for it (results arrive as
    /// `LinkEvent::Candidates` unless cached). At most [`MAX_LINKS`]: beyond that, Err.
    pub fn create_link(self: &Arc<Self>, role: Role, sink: LinkSink) -> Result<Arc<Link>, String> {
        if self.closed() {
            return Err("endpoint closed".into());
        }
        let host: Vec<IpAddr> = ice::host_addresses(self.loopback).into_iter().filter(|ip| self.sock.dual || ip.is_ipv4()).collect();
        let link = {
            let mut links = self.links.write().unwrap_or_else(|e| e.into_inner());
            if links.len() >= MAX_LINKS {
                return Err(format!("too many links (max {MAX_LINKS})"));
            }
            let id = loop {
                let id = crypto::random_u32();
                if !links.contains_key(&id) {
                    break id;
                }
            };
            let link = Arc::new(Link::new(id, role, sink, self, host));
            links.insert(id, link.clone());
            link
        };
        for c in self.start_stun(&link, now_us()) {
            link.add_srflx(c, false);
        }
        Ok(link)
    }

    pub fn link(&self, id: u32) -> Option<Arc<Link>> {
        self.links.read().unwrap_or_else(|e| e.into_inner()).get(&id).cloned()
    }

    fn all_links(&self) -> Vec<Arc<Link>> {
        self.links.read().unwrap_or_else(|e| e.into_inner()).values().cloned().collect()
    }

    /// Closes every link (Bye "closed") and stops the threads. The endpoint is unusable afterwards.
    pub fn close(&self) {
        if self.closed() {
            return;
        }
        for l in self.all_links() {
            l.close(ByeReason::Closed);
        }
        // `st-net-rx` sends the remaining Byes and the final events, then both threads end
        let byes = BYE_REPEATS as u64 * BYE_GAP_MS * 1000;
        self.stop_at_us.store(now_us() + byes + 2 * TICK_US, Ordering::Relaxed);
        self.wake.notify();
    }

    // ── network thread ──

    fn on_datagram(&self, d: &[u8], from: SocketAddr, now: u64, rx: &mut RxState) {
        if wire::is_stun(d) {
            self.on_stun(d, from);
            return;
        }
        let Some(h) = Header::decode(d) else { return };
        let Some(link) = self.link(h.link) else { return };
        if !rx.may_try(from.ip(), now) {
            return; // this source keeps sending garbage: not even an AEAD check
        }
        match link.open(d, &mut rx.plain) {
            Ok(Some(h)) => link.on_packet(h, d.len(), &rx.plain, from, now),
            Ok(None) => {} // no keys yet (the peer knew our parameters before we knew theirs)
            Err(OpenError::Replay) => {
                link.rejected.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                rx.failed(from.ip(), now);
                link.rejected.fetch_add(1, Ordering::Relaxed);
            }
        }
        link.flush_events();
    }

    fn tick(&self, now: u64) {
        self.stun_tick(now);
        let mut done = Vec::new();
        for l in self.all_links() {
            if l.tick(now) {
                done.push(l.id);
            }
            l.flush_events();
        }
        if !done.is_empty() {
            let mut links = self.links.write().unwrap_or_else(|e| e.into_inner());
            for id in done {
                if let Some(l) = links.remove(&id) {
                    *l.handler.write().unwrap_or_else(|e| e.into_inner()) = None; // breaks the Sender/Receiver ↔ Link cycle
                }
            }
        }
    }

    // ── STUN ──

    /// Registers `link` for server-reflexive candidates; returns those already known (cached or found so far).
    fn start_stun(&self, link: &Arc<Link>, now: u64) -> Vec<Candidate> {
        let mut st = lock(&self.stun);
        if st.servers.is_empty() {
            return Vec::new();
        }
        let fresh = st.cache_us.is_some_and(|t| now.saturating_sub(t) < SRFLX_CACHE_MS * 1000);
        if fresh && !st.gathering {
            return st.cache.clone();
        }
        st.waiters.push(Arc::downgrade(link));
        if !st.gathering {
            st.gathering = true;
            st.resolved = false;
            st.started_us = now;
            st.cache.clear();
            st.cache_us = None;
            st.txs.clear();
            let (generation, servers, me, v6) = (st.generation, st.servers.clone(), self.me.clone(), self.sock.dual);
            let spawned = std::thread::Builder::new().name("st-stun-dns".into()).spawn(move || {
                let mut addrs = Vec::new();
                for (host, port) in servers.iter().filter_map(|s| ice::parse_stun_url(s)) {
                    let Ok(found) = (host.as_str(), port).to_socket_addrs() else { continue };
                    let found: Vec<SocketAddr> = found.map(ice::canonical).collect();
                    addrs.extend(found.iter().find(|a| a.is_ipv4()));
                    if v6 {
                        addrs.extend(found.iter().find(|a| a.is_ipv6()));
                    }
                }
                let Some(ep) = me.upgrade() else { return };
                let mut st = lock(&ep.stun);
                if st.generation != generation {
                    return;
                }
                let now = now_us();
                for server in addrs {
                    let mut txid = [0u8; 12];
                    getrandom::fill(&mut txid).expect("OS random generator");
                    st.txs.push(StunTx { server, txid, sent: 0, first_us: now, next_us: now });
                }
                st.resolved = true;
            });
            if spawned.is_err() {
                st.resolved = true;
            }
        }
        st.cache.clone()
    }

    fn stun_tick(&self, now: u64) {
        let mut send = Vec::new();
        {
            let mut st = lock(&self.stun);
            if !st.gathering {
                return;
            }
            st.txs.retain_mut(|t| {
                if now.saturating_sub(t.first_us) >= STUN_TIMEOUT_MS * 1000 {
                    return false;
                }
                if t.sent <= STUN_RETRANSMIT_MS.len() && now >= t.next_us {
                    send.push((t.server, t.txid));
                    t.next_us = STUN_RETRANSMIT_MS.get(t.sent).map_or(u64::MAX, |ms| t.first_us + ms * 1000);
                    t.sent += 1;
                }
                true
            });
            if st.resolved && st.txs.is_empty() {
                st.gathering = false;
                st.waiters.clear();
                if !st.cache.is_empty() {
                    st.cache_us = Some(st.started_us);
                }
            }
        }
        for (server, txid) in send {
            self.sock.send_to(&ice::stun_request(&txid), server);
        }
    }

    /// A STUN datagram: only a Binding Success Response from a server we asked, with our transaction id.
    fn on_stun(&self, d: &[u8], from: SocketAddr) {
        let (c, waiters) = {
            let mut st = lock(&self.stun);
            let Some((i, mapped)) =
                st.txs.iter().enumerate().find_map(|(i, t)| (t.server == from).then(|| ice::parse_stun_response(d, &t.txid)).flatten().map(|m| (i, m)))
            else {
                return;
            };
            st.txs.remove(i);
            let c = Candidate { addr: mapped, kind: CandidateKind::Srflx };
            if st.cache.contains(&c) {
                return;
            }
            st.cache.push(c);
            (c, st.waiters.iter().filter_map(Weak::upgrade).collect::<Vec<_>>())
        };
        for l in waiters {
            l.add_srflx(c, true);
            l.flush_events();
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop_at_us.store(0, Ordering::Relaxed);
        self.wake.notify();
        if self.timer.swap(false, Ordering::Relaxed) {
            timer_resolution(false);
        }
    }
}

fn rx_loop(ep: Weak<Endpoint>, sock: Arc<Sock>) {
    let mut buf = vec![0u8; 2048];
    let mut rx = RxState::default();
    loop {
        let r = sock.udp.recv_from(&mut buf);
        let Some(ep) = ep.upgrade() else { break };
        let now = now_us();
        if now >= ep.stop_at_us.load(Ordering::Relaxed) {
            break;
        }
        match r {
            Ok((n, from)) => ep.on_datagram(&buf[..n], ice::canonical(from), now, &mut rx),
            // timeout; Windows reports an ICMP port-unreachable for an earlier send as ConnectionReset
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::ConnectionReset | ErrorKind::Interrupted) => {}
            // e.g. an oversized datagram (Windows): never spin on an error
            Err(_) => std::thread::sleep(Duration::from_millis(1)),
        }
        if now >= rx.next_tick_us {
            rx.next_tick_us = now + TICK_US;
            ep.tick(now);
        }
    }
}

enum Pump {
    /// nothing queued
    Idle,
    /// sent a batch, more may go at once
    Ready,
    /// out of tokens for this many µs
    Wait(u64),
}

fn tx_loop(ep: Weak<Endpoint>, wake: Arc<Wake>) {
    let mut buf = Vec::with_capacity(wire::MAX_DATAGRAM);
    let mut batch = Vec::with_capacity(TX_BATCH);
    loop {
        let next = {
            let Some(ep) = ep.upgrade() else { break };
            let now = now_us();
            if now >= ep.stop_at_us.load(Ordering::Relaxed) {
                break;
            }
            let (mut busy, mut wait) = (false, u64::MAX);
            for l in ep.all_links() {
                match l.pump(now, &mut batch, &mut buf) {
                    Pump::Idle => {}
                    Pump::Ready => busy = true,
                    Pump::Wait(us) => wait = wait.min(us),
                }
            }
            if busy {
                Some(0)
            } else if wait != u64::MAX {
                Some(wait)
            } else {
                None
            }
        };
        match next {
            None => wake.wait(Duration::from_millis(100)),
            Some(0) => {}
            Some(us) => std::thread::sleep(Duration::from_micros(us.min(1_000))),
        }
    }
}

// ───────────────────────── link ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// created, waiting for the peer's parameters
    New,
    /// probing
    Checking,
    Up,
    /// we closed it: the remaining Byes go out
    Closing,
    Done,
}

struct ByeState {
    reason: ByeReason,
    left: u8,
    next_us: u64,
}

struct LinkState {
    phase: Phase,
    checklist: Option<Checklist>,
    reliable: Reliable,
    clock: ClockSync,
    probe_seq: u32,
    next_ping_us: u64,
    next_stats_us: u64,
    bye: Option<ByeState>,
    /// emitted by `st-net-rx` only (see module docs)
    events: Vec<LinkEvent>,
    /// last per-second snapshot
    stats: LinkStats,
    /// counters at the last snapshot: tx bytes, rx bytes, rx packets, highest rx pn, time
    prev: (u64, u64, u64, u64, u64),
    /// the peer's receiver reports of the last second: (time, packets expected, packets received)
    reports: VecDeque<(u64, u32, u32)>,
}

struct QueuedFrame {
    shards: Arc<Vec<Vec<u8>>>,
    /// next shard to send (0 = not started)
    next: usize,
}

struct TxQueue {
    frames: VecDeque<QueuedFrame>,
    pacer: Pacer,
    /// video target of the sender feeding this link (non-LAN pacing follows it)
    pace_target_kbps: u32,
    lan: bool,
}

/// One sharer–viewer link.
pub struct Link {
    id: u32,
    role: Role,
    key_half: [u8; 32],
    sink: LinkSink,
    sock: Arc<Sock>,
    wake: Arc<Wake>,
    loopback: bool,
    host_ips: Vec<IpAddr>,
    port: u16,
    srflx: Mutex<Vec<Candidate>>,
    peer_link: AtomicU32,
    sealer: Mutex<Option<Sealer>>,
    opener: Mutex<Option<Opener>>,
    path: Mutex<Option<PathInfo>>,
    /// Closing or Done: no more media, messages or events except the final one
    ended: AtomicBool,
    st: Mutex<LinkState>,
    tx: Mutex<TxQueue>,
    handler: RwLock<Option<Arc<dyn PacketHandler>>>,
    tx_bytes: AtomicU64,
    rx_bytes: AtomicU64,
    rx_packets: AtomicU64,
    rx_max_pn: AtomicU64,
    rejected: AtomicU64,
    last_heard_us: AtomicU64,
}

thread_local! {
    /// sealing buffer of the calling thread (no allocation per datagram)
    static SEAL_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(wire::MAX_DATAGRAM));
}

impl Link {
    fn new(id: u32, role: Role, sink: LinkSink, ep: &Endpoint, host_ips: Vec<IpAddr>) -> Link {
        Link {
            id,
            role,
            key_half: crypto::random_key_half(),
            sink,
            sock: ep.sock.clone(),
            wake: ep.wake.clone(),
            loopback: ep.loopback,
            host_ips,
            port: ep.port,
            srflx: Mutex::new(Vec::new()),
            peer_link: AtomicU32::new(0),
            sealer: Mutex::new(None),
            opener: Mutex::new(None),
            path: Mutex::new(None),
            ended: AtomicBool::new(false),
            st: Mutex::new(LinkState {
                phase: Phase::New,
                checklist: None,
                reliable: Reliable::new(),
                clock: ClockSync::new(),
                probe_seq: crypto::random_u32(),
                next_ping_us: 0,
                next_stats_us: 0,
                bye: None,
                events: Vec::new(),
                stats: LinkStats::default(),
                prev: (0, 0, 0, 0, 0),
                reports: VecDeque::new(),
            }),
            tx: Mutex::new(TxQueue { frames: VecDeque::new(), pacer: Pacer::new(pace_bps(false, 0)), pace_target_kbps: 0, lan: false }),
            handler: RwLock::new(None),
            tx_bytes: AtomicU64::new(0),
            rx_bytes: AtomicU64::new(0),
            rx_packets: AtomicU64::new(0),
            rx_max_pn: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            last_heard_us: AtomicU64::new(0),
        }
    }

    /// Our link id (non-zero, random, unique on this endpoint). The peer puts it in every header it sends us.
    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// Our key half (goes into the `nv` join / offer as 64 hex digits).
    pub fn key_half(&self) -> [u8; 32] {
        self.key_half
    }

    /// Host candidates (+ cached server-reflexive ones) with the endpoint's port; known at once.
    pub fn local_candidates(&self) -> Vec<Candidate> {
        let mut out: Vec<Candidate> =
            self.host_ips.iter().map(|ip| Candidate { addr: SocketAddr::new(*ip, self.port), kind: CandidateKind::Host }).collect();
        out.extend(lock(&self.srflx).iter().copied());
        out
    }

    /// A server-reflexive result; `announce` = tell the peer (late result → `LinkEvent::Candidates`).
    fn add_srflx(&self, c: Candidate, announce: bool) {
        if self.host_ips.iter().any(|ip| SocketAddr::new(*ip, self.port) == c.addr) {
            return; // no NAT: the STUN server saw our host address
        }
        let mut srflx = lock(&self.srflx);
        if srflx.contains(&c) {
            return;
        }
        srflx.push(c);
        drop(srflx);
        if announce {
            let mut st = lock(&self.st);
            if st.phase != Phase::Done && st.phase != Phase::Closing {
                st.events.push(LinkEvent::Candidates(vec![c]));
            }
        }
    }

    /// Remote candidates this socket can use (signaling is untrusted input).
    fn usable(&self, candidates: &[Candidate]) -> Vec<Candidate> {
        candidates
            .iter()
            .map(|c| Candidate { addr: ice::canonical(c.addr), kind: c.kind })
            .filter(|c| self.sock.reaches(c.addr))
            .filter(|c| self.loopback || !c.addr.ip().is_loopback())
            .filter(|c| !matches!(c.addr.ip(), IpAddr::V4(v4) if v4.is_broadcast()))
            .collect()
    }

    /// The peer's link id, key half and candidates: derives the keys and starts probing; the deadline
    /// ([`crate::net::ice::DEADLINE_MS`]) runs from here. Err if called twice or the peer link id is 0.
    pub fn set_remote(&self, peer_link: u32, peer_key_half: [u8; 32], candidates: &[Candidate]) -> Result<(), String> {
        if peer_link == 0 {
            return Err("peer link id 0".into());
        }
        let now = now_us();
        let probes = {
            let mut st = lock(&self.st);
            if st.phase != Phase::New {
                return Err("remote parameters already set".into());
            }
            let keys = match self.role {
                Role::Share => crypto::derive_link_keys(Role::Share, &self.key_half, &peer_key_half, self.id, peer_link),
                Role::Watch => crypto::derive_link_keys(Role::Watch, &peer_key_half, &self.key_half, peer_link, self.id),
            };
            *lock(&self.sealer) = Some(Sealer::new(keys.tx));
            *lock(&self.opener) = Some(Opener::new(keys.rx));
            self.peer_link.store(peer_link, Ordering::Relaxed);
            let mut checklist = Checklist::new(now);
            checklist.add_remote(&self.usable(candidates));
            let due = checklist.due(now);
            st.checklist = Some(checklist);
            st.phase = Phase::Checking;
            Self::probes(&mut st, due, now)
        };
        self.send_probes(probes);
        Ok(())
    }

    /// Late remote candidates (`nvice`).
    pub fn add_remote_candidates(&self, candidates: &[Candidate]) {
        let usable = self.usable(candidates);
        let mut st = lock(&self.st);
        if let Some(c) = st.checklist.as_mut() {
            c.add_remote(&usable);
        }
    }

    /// Reliable, ordered App text to the peer (≤ [`crate::net::ctrl::MAX_APP_TEXT`] bytes). Queued until up.
    pub fn send_message(&self, text: &str) -> Result<(), String> {
        if text.len() > MAX_APP_TEXT {
            return Err(format!("message longer than {MAX_APP_TEXT} bytes"));
        }
        let now = now_us();
        let (due, remote) = {
            let mut st = lock(&self.st);
            if matches!(st.phase, Phase::Closing | Phase::Done) {
                return Err("link closed".into());
            }
            if st.reliable.pending() >= MAX_UNACKED {
                return Err("too many unacknowledged messages".into());
            }
            st.reliable.send(text.to_string(), now);
            let remote = self.remote();
            match (st.phase, remote) {
                (Phase::Up, Some(r)) => {
                    let rtt = self.rtt_estimate(&st);
                    (st.reliable.due(now, rtt), r)
                }
                _ => return Ok(()), // goes out when the link is up
            }
        };
        for (seq, msg) in due {
            self.send_ctrl_to(&msg, seq, remote);
        }
        Ok(())
    }

    /// The selected path, None before up.
    pub fn path(&self) -> Option<PathInfo> {
        *lock(&self.path)
    }

    fn remote(&self) -> Option<SocketAddr> {
        self.path().map(|p| p.remote)
    }

    /// Up and not ended: media may be sent.
    pub fn is_up(&self) -> bool {
        !self.ended.load(Ordering::Relaxed) && self.path().is_some()
    }

    pub fn stats(&self) -> LinkStats {
        let st = lock(&self.st);
        let mut s = st.stats.clone();
        self.fill_stats(&mut s, &st.clock);
        s
    }

    /// The fields of a snapshot that are not per-second rates.
    fn fill_stats(&self, s: &mut LinkStats, clock: &ClockSync) {
        if let Some(p) = self.path() {
            s.kind = if p.lan { "lan" } else { "p2p" }.into();
            s.remote = p.remote.to_string();
        }
        s.rtt_ms = clock.rtt_us().map_or(0.0, |r| r as f32 / 1000.0);
        s.pace_kbps = (lock(&self.tx).pacer.rate_bps() / 1000) as u32;
        s.rejected = self.rejected.load(Ordering::Relaxed);
    }

    /// Latest RTT (µs), None before the first pong.
    pub fn rtt_us(&self) -> Option<u64> {
        lock(&self.st).clock.rtt_us()
    }

    /// A time on the peer's clock mapped to ours (ping/pong offset), None before the first pong.
    pub fn peer_to_local_us(&self, peer_us: u64) -> Option<u64> {
        lock(&self.st).clock.to_local(peer_us)
    }

    /// Sends Bye (3×) and ends the link; the sink gets `Closed("closed")` (or `Failed` before up). Idempotent.
    pub fn close(&self, reason: ByeReason) {
        let now = now_us();
        {
            let mut st = lock(&self.st);
            match st.phase {
                Phase::Closing | Phase::Done => return,
                Phase::Up => {
                    st.phase = Phase::Closing;
                    st.bye = Some(ByeState { reason, left: BYE_REPEATS - 1, next_us: now + BYE_GAP_MS * 1000 });
                    st.events.push(LinkEvent::Closed("closed".into()));
                    self.ended.store(true, Ordering::Relaxed);
                    lock(&self.tx).frames.clear();
                }
                Phase::New | Phase::Checking => {
                    self.finish(&mut st, LinkEvent::Failed("closed".into()));
                    return;
                }
            }
        }
        if let Some(r) = self.remote() {
            self.send_ctrl_to(&Ctrl::Bye(reason), 0, r);
        }
    }

    // ── used by send.rs / recv.rs ──

    /// Attaches the media handler (one per link).
    pub fn set_handler(&self, handler: Arc<dyn PacketHandler>) {
        *self.handler.write().unwrap_or_else(|e| e.into_inner()) = Some(handler);
    }

    /// Detaches `handler` if it is the one attached (a newer handler stays).
    pub fn clear_handler(&self, handler: &dyn PacketHandler) {
        let mut h = self.handler.write().unwrap_or_else(|e| e.into_inner());
        if h.as_ref().is_some_and(|cur| std::ptr::addr_eq(Arc::as_ptr(cur), handler as *const dyn PacketHandler)) {
            *h = None;
        }
    }

    fn handler(&self) -> Option<Arc<dyn PacketHandler>> {
        if self.ended.load(Ordering::Relaxed) {
            return None;
        }
        self.handler.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Queues the plaintexts of one frame (from [`crate::net::frame::shard_frame`]) for paced sending.
    pub fn send_video(&self, plaintexts: &[Vec<u8>]) {
        self.send_frame(Arc::new(plaintexts.to_vec()));
    }

    /// [`Self::send_video`] without a copy: the sender shares one set of plaintexts between its links. Returns how
    /// many frames this link dropped because more than [`MAX_QUEUED_FRAMES`] whole frames waited (the viewer can
    /// only recover from that with a key frame); 0 when the new frame is a key frame itself.
    pub fn send_frame(&self, shards: Arc<Vec<Vec<u8>>>) -> u32 {
        if shards.is_empty() || !self.is_up() {
            return 0;
        }
        let key = shards[0].get(10).is_some_and(|f| f & vflags::KEY != 0);
        let dropped = {
            let mut tx = lock(&self.tx);
            let waiting = tx.frames.iter().filter(|f| f.next == 0).count();
            let mut dropped = 0;
            if waiting >= MAX_QUEUED_FRAMES {
                // the link is slower than the encoder: drop what has not started, a started frame is never cut
                let before = tx.frames.len();
                tx.frames.retain(|f| f.next > 0);
                dropped = (before - tx.frames.len()) as u32;
            }
            if dropped == 0 || key {
                tx.frames.push_back(QueuedFrame { shards, next: 0 });
                if key {
                    dropped = 0; // the key frame makes the dropped ones unnecessary
                }
            } else {
                dropped += 1; // this delta is useless without the dropped ones
            }
            dropped
        };
        self.wake.notify();
        dropped
    }

    /// Video target of the sender feeding this link: non-LAN links pace at 3 × this ([`pace_bps`]).
    pub fn set_pace_target(&self, kbps: u32) {
        let mut tx = lock(&self.tx);
        tx.pace_target_kbps = kbps;
        let rate = pace_bps(tx.lan, kbps);
        tx.pacer.set_rate(rate);
    }

    /// Sends one audio plaintext (ahead of queued video).
    pub fn send_audio(&self, plaintext: &[u8]) {
        if let (true, Some(r)) = (!self.ended.load(Ordering::Relaxed), self.remote()) {
            self.seal_send(Kind::Audio, plaintext, r);
        }
    }

    /// Sends an unreliable media ctrl message (FrameLost, Keyframe, Report) at once.
    pub fn send_ctrl(&self, msg: &Ctrl) {
        if let (true, Some(r)) = (!self.ended.load(Ordering::Relaxed), self.remote()) {
            self.send_ctrl_to(msg, 0, r);
        }
    }

    // ── internals ──

    fn seal_send(&self, kind: Kind, plaintext: &[u8], to: SocketAddr) -> bool {
        SEAL_BUF.with(|b| self.seal_send_buf(kind, plaintext, to, &mut b.borrow_mut()))
    }

    fn seal_send_buf(&self, kind: Kind, plaintext: &[u8], to: SocketAddr, buf: &mut Vec<u8>) -> bool {
        {
            let mut sealer = lock(&self.sealer);
            let Some(s) = sealer.as_mut() else { return false };
            s.seal(kind, self.peer_link.load(Ordering::Relaxed), plaintext, buf);
        }
        let ok = self.sock.send_to(buf, to);
        if ok {
            self.tx_bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
        }
        ok
    }

    fn send_ctrl_to(&self, msg: &Ctrl, seq: u32, to: SocketAddr) {
        let mut b = Vec::with_capacity(64);
        ctrl::encode(msg, seq, &mut b);
        self.seal_send(Kind::Ctrl, &b, to);
    }

    fn probes(st: &mut LinkState, due: Vec<SocketAddr>, now: u64) -> Vec<(SocketAddr, [u8; wire::PROBE_LEN])> {
        due.into_iter()
            .map(|addr| {
                st.probe_seq = st.probe_seq.wrapping_add(1);
                (addr, Probe { t_us: now, seq: st.probe_seq, reply: false }.encode())
            })
            .collect()
    }

    fn send_probes(&self, probes: Vec<(SocketAddr, [u8; wire::PROBE_LEN])>) {
        for (addr, p) in probes {
            self.seal_send(Kind::Probe, &p, addr);
        }
    }

    fn rtt_estimate(&self, st: &LinkState) -> u64 {
        st.clock.rtt_us().or(self.path().map(|p| p.rtt_us)).unwrap_or(0)
    }

    /// Final event; the endpoint forgets the link on its next tick.
    fn finish(&self, st: &mut LinkState, ev: LinkEvent) {
        st.phase = Phase::Done;
        st.events.push(ev);
        self.ended.store(true, Ordering::Relaxed);
        lock(&self.tx).frames.clear();
    }

    /// Emits queued events (only ever called on `st-net-rx`, never with a lock held).
    fn flush_events(&self) {
        let events = std::mem::take(&mut lock(&self.st).events);
        for e in events {
            (self.sink)(e);
        }
    }

    fn open(&self, d: &[u8], out: &mut Vec<u8>) -> Result<Option<Header>, OpenError> {
        match lock(&self.opener).as_mut() {
            None => Ok(None),
            Some(o) => o.open(d, out).map(Some),
        }
    }

    fn on_packet(&self, h: Header, len: usize, plain: &[u8], from: SocketAddr, now: u64) {
        self.rx_bytes.fetch_add(len as u64, Ordering::Relaxed);
        self.rx_packets.fetch_add(1, Ordering::Relaxed);
        self.rx_max_pn.fetch_max(h.pn, Ordering::Relaxed);
        self.last_heard_us.store(now, Ordering::Relaxed);
        if self.ended.load(Ordering::Relaxed) {
            return;
        }
        match h.kind {
            Kind::Probe => self.on_probe(plain, from, now),
            Kind::Ctrl => self.on_ctrl(plain, from, now),
            Kind::Video => {
                if let (Some(s), Some(handler)) = (VideoShard::parse(plain), self.handler()) {
                    handler.on_video(self, s, now);
                }
            }
            Kind::Audio => {
                if let (Some(a), Some(handler)) = (AudioPacket::parse(plain), self.handler()) {
                    handler.on_audio(self, a, now);
                }
            }
        }
    }

    fn on_probe(&self, plain: &[u8], from: SocketAddr, now: u64) {
        let Some(p) = Probe::parse(plain) else { return };
        if !p.reply {
            // answer at once, to wherever it came from (maybe a NAT mapping we did not know)
            self.seal_send(Kind::Probe, &Probe { reply: true, ..p }.encode(), from);
            if let Some(c) = lock(&self.st).checklist.as_mut() {
                c.on_probe(from);
            }
            return;
        }
        let rtt = now.saturating_sub(p.t_us);
        let (due, remote) = {
            let mut st = lock(&self.st);
            if st.phase != Phase::Checking {
                return;
            }
            let Some(remote) = st.checklist.as_mut().and_then(|c| c.on_reply(from, rtt)) else { return };
            let path = PathInfo { remote, lan: ice::is_lan(&self.host_ips, remote), rtt_us: rtt };
            *lock(&self.path) = Some(path);
            {
                let mut tx = lock(&self.tx);
                tx.lan = path.lan;
                let rate = pace_bps(path.lan, tx.pace_target_kbps);
                tx.pacer.set_rate(rate);
            }
            st.phase = Phase::Up;
            st.next_ping_us = now;
            st.next_stats_us = now + STATS_US;
            st.prev = self.counters(now);
            st.events.push(LinkEvent::Up(path));
            (st.reliable.due(now, rtt), remote) // App messages queued before up
        };
        for (seq, msg) in due {
            self.send_ctrl_to(&msg, seq, remote);
        }
    }

    fn on_ctrl(&self, plain: &[u8], from: SocketAddr, now: u64) {
        let Some((msg, seq)) = ctrl::decode(plain) else { return };
        let reply_to = self.remote().unwrap_or(from);
        match msg {
            Ctrl::Ping { t1 } => self.send_ctrl_to(&Ctrl::Pong { t1, t2: now, t3: now_us() }, 0, reply_to),
            Ctrl::Pong { t1, t2, t3 } => lock(&self.st).clock.on_pong(t1, t2, t3, now),
            Ctrl::Ack { seq } => lock(&self.st).reliable.on_ack(seq),
            Ctrl::App(_) => {
                if seq == 0 {
                    return;
                }
                self.send_ctrl_to(&Ctrl::Ack { seq }, 0, reply_to);
                let mut st = lock(&self.st);
                for text in st.reliable.on_receive(seq, msg) {
                    st.events.push(LinkEvent::Message(text));
                }
            }
            Ctrl::Bye(reason) => {
                let reason = match reason {
                    ByeReason::Closed => "bye",
                    ByeReason::Kicked => "kicked",
                    ByeReason::Ended => "ended",
                };
                let mut st = lock(&self.st);
                if !matches!(st.phase, Phase::Closing | Phase::Done) {
                    self.finish(&mut st, LinkEvent::Closed(reason.into()));
                }
            }
            Ctrl::Report(r) => {
                lock(&self.st).reports.push_back((now, r.packets_expected, r.packets_received));
                if let Some(h) = self.handler() {
                    h.on_ctrl(self, msg, now);
                }
            }
            Ctrl::FrameLost { .. } | Ctrl::Keyframe => {
                if let Some(h) = self.handler() {
                    h.on_ctrl(self, msg, now);
                }
            }
        }
    }

    fn counters(&self, now: u64) -> (u64, u64, u64, u64, u64) {
        (
            self.tx_bytes.load(Ordering::Relaxed),
            self.rx_bytes.load(Ordering::Relaxed),
            self.rx_packets.load(Ordering::Relaxed),
            self.rx_max_pn.load(Ordering::Relaxed),
            now,
        )
    }

    /// The per-second snapshot (rates over the last second).
    fn update_stats(&self, st: &mut LinkState, now: u64) -> LinkStats {
        let cur = self.counters(now);
        let (tx, rx, packets, max_pn, at) = st.prev;
        let secs = now.saturating_sub(at).max(1) as f64 / 1e6;
        let kbps = |bytes: u64| (bytes as f64 * 8.0 / 1000.0 / secs) as u32;
        while st.reports.front().is_some_and(|r| now.saturating_sub(r.0) > STATS_US) {
            st.reports.pop_front();
        }
        let (expected, received) = st.reports.iter().fold((0u64, 0u64), |a, r| (a.0 + r.1 as u64, a.1 + r.2 as u64));
        // the sharer has the viewer's reports; the viewer judges by gaps in our packet numbers
        let (expected, received) = if expected > 0 { (expected, received) } else { (cur.3.saturating_sub(max_pn), cur.2.saturating_sub(packets)) };
        let loss_pct = if expected == 0 { 0.0 } else { expected.saturating_sub(received) as f32 * 100.0 / expected as f32 };
        st.prev = cur;
        let mut s = LinkStats { tx_kbps: kbps(cur.0.saturating_sub(tx)), rx_kbps: kbps(cur.1.saturating_sub(rx)), loss_pct, ..Default::default() };
        self.fill_stats(&mut s, &st.clock);
        st.stats = s.clone();
        s
    }

    /// Timers; returns true once the link is done (the endpoint then forgets it).
    fn tick(&self, now: u64) -> bool {
        let mut probes = Vec::new();
        let mut ctrl_out: Vec<(u32, Ctrl)> = Vec::new();
        let (mut ping, mut bye, mut up) = (false, None, false);
        let remote = self.remote();
        let done = {
            let mut st = lock(&self.st);
            match st.phase {
                Phase::New | Phase::Done => {}
                Phase::Checking => {
                    let checklist = st.checklist.as_mut().expect("set with Checking");
                    if checklist.failed(now) {
                        self.finish(&mut st, LinkEvent::Failed(format!("no answer within {} ms", ice::DEADLINE_MS)));
                    } else {
                        let due = checklist.due(now);
                        probes = Self::probes(&mut st, due, now);
                    }
                }
                Phase::Up => {
                    let silent = now.saturating_sub(self.last_heard_us.load(Ordering::Relaxed)) >= LINK_TIMEOUT_MS * 1000;
                    if silent || st.reliable.dead(now) {
                        self.finish(&mut st, LinkEvent::Closed("timeout".into()));
                    } else {
                        up = true;
                        if now >= st.next_ping_us {
                            ping = true;
                            st.next_ping_us = now + PING_MS * 1000;
                        }
                        let rtt = self.rtt_estimate(&st);
                        ctrl_out = st.reliable.due(now, rtt);
                        if now >= st.next_stats_us {
                            st.next_stats_us = now + STATS_US;
                            let s = self.update_stats(&mut st, now);
                            st.events.push(LinkEvent::Stats(s));
                        }
                    }
                }
                Phase::Closing => {
                    if let Some(b) = st.bye.as_mut() {
                        if b.left > 0 && now >= b.next_us {
                            bye = Some(b.reason);
                            b.left -= 1;
                            b.next_us = now + BYE_GAP_MS * 1000;
                        }
                        if b.left == 0 {
                            st.phase = Phase::Done;
                        }
                    }
                }
            }
            st.phase == Phase::Done
        };
        self.send_probes(probes);
        if let Some(r) = remote {
            if ping {
                self.send_ctrl_to(&Ctrl::Ping { t1: now_us() }, 0, r);
            }
            for (seq, msg) in ctrl_out {
                self.send_ctrl_to(&msg, seq, r);
            }
            if let Some(reason) = bye {
                self.send_ctrl_to(&Ctrl::Bye(reason), 0, r);
            }
        }
        if up {
            if let Some(h) = self.handler() {
                h.on_tick(self, now);
            }
        }
        done
    }

    /// One turn of `st-net-tx`: sends what the pacer allows (up to [`TX_BATCH`] datagrams).
    fn pump(&self, now: u64, batch: &mut Vec<(Arc<Vec<Vec<u8>>>, usize)>, buf: &mut Vec<u8>) -> Pump {
        let Some(to) = self.remote() else { return Pump::Idle };
        let state = {
            let mut guard = lock(&self.tx);
            let q = &mut *guard;
            let mut wait = 0;
            while batch.len() < TX_BATCH {
                let Some(f) = q.frames.front_mut() else { break };
                let w = q.pacer.take(now, f.shards[f.next].len() + HEADER_LEN + TAG_LEN);
                if w > 0 {
                    wait = w;
                    break;
                }
                batch.push((f.shards.clone(), f.next));
                f.next += 1;
                if f.next == f.shards.len() {
                    q.frames.pop_front();
                }
            }
            if q.frames.is_empty() {
                Pump::Idle
            } else if wait > 0 {
                Pump::Wait(wait)
            } else {
                Pump::Ready
            }
        };
        for (shards, i) in batch.drain(..) {
            self.seal_send_buf(Kind::Video, &shards[i], to, buf);
        }
        state
    }
}

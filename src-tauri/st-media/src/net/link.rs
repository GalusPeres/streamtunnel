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
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use std::net::SocketAddr;
use std::sync::Arc;

use crate::net::ctrl::{ByeReason, Ctrl};
use crate::net::ice::Candidate;
use crate::net::wire::{AudioPacket, VideoShard};
use crate::stats::LinkStats;
use crate::Role;

/// A link that was up and hears nothing (not even a pong) for this long is closed (ms).
pub const LINK_TIMEOUT_MS: u64 = 5000;
/// Whole frames waiting per link: beyond this, waiting frames that have not started are dropped (their ids count as
/// lost on that link and the sender asks for a key frame for it). A frame that started is never cut.
pub const MAX_QUEUED_FRAMES: usize = 2;
/// Links per endpoint (signaling is untrusted: a flood of joins must not exhaust us).
pub const MAX_LINKS: usize = 16;

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
}

/// The app's UDP socket.
pub struct Endpoint {
    // filled by NET
}

impl Endpoint {
    /// Binds the socket and starts the endpoint's threads.
    pub fn open(cfg: EndpointConfig) -> std::io::Result<Arc<Endpoint>> {
        todo!("NET")
    }

    /// Local UDP port.
    pub fn port(&self) -> u16 {
        todo!("NET")
    }

    /// Replaces the STUN server list (settings changed); cached server-reflexive results are dropped.
    pub fn set_stun(&self, stun: Vec<String>) {
        todo!("NET")
    }

    /// New link with a fresh random link id and key half. Starts STUN gathering for it (results arrive as
    /// `LinkEvent::Candidates` unless cached). At most [`MAX_LINKS`]: beyond that, Err.
    pub fn create_link(self: &Arc<Self>, role: Role, sink: LinkSink) -> Result<Arc<Link>, String> {
        todo!("NET")
    }

    pub fn link(&self, id: u32) -> Option<Arc<Link>> {
        todo!("NET")
    }

    /// Closes every link (Bye "closed") and stops the threads. The endpoint is unusable afterwards.
    pub fn close(&self) {
        todo!("NET")
    }
}

/// One sharer–viewer link.
pub struct Link {
    // filled by NET
}

impl Link {
    /// Our link id (non-zero, random, unique on this endpoint). The peer puts it in every header it sends us.
    pub fn id(&self) -> u32 {
        todo!("NET")
    }

    pub fn role(&self) -> Role {
        todo!("NET")
    }

    /// Our key half (goes into the `nv` join / offer as 64 hex digits).
    pub fn key_half(&self) -> [u8; 32] {
        todo!("NET")
    }

    /// Host candidates (+ cached server-reflexive ones) with the endpoint's port; known at once.
    pub fn local_candidates(&self) -> Vec<Candidate> {
        todo!("NET")
    }

    /// The peer's link id, key half and candidates: derives the keys and starts probing; the deadline
    /// ([`crate::net::ice::DEADLINE_MS`]) runs from here. Err if called twice or the peer link id is 0.
    pub fn set_remote(&self, peer_link: u32, peer_key_half: [u8; 32], candidates: &[Candidate]) -> Result<(), String> {
        todo!("NET")
    }

    /// Late remote candidates (`nvice`).
    pub fn add_remote_candidates(&self, candidates: &[Candidate]) {
        todo!("NET")
    }

    /// Reliable, ordered App text to the peer (≤ [`crate::net::ctrl::MAX_APP_TEXT`] bytes). Queued until up.
    pub fn send_message(&self, text: &str) -> Result<(), String> {
        todo!("NET")
    }

    /// The selected path, None before up.
    pub fn path(&self) -> Option<PathInfo> {
        todo!("NET")
    }

    pub fn stats(&self) -> LinkStats {
        todo!("NET")
    }

    /// Latest RTT (µs), None before the first pong.
    pub fn rtt_us(&self) -> Option<u64> {
        todo!("NET")
    }

    /// A time on the peer's clock mapped to ours (ping/pong offset), None before the first pong.
    pub fn peer_to_local_us(&self, peer_us: u64) -> Option<u64> {
        todo!("NET")
    }

    /// Sends Bye (3×) and ends the link; the sink gets `Closed("closed")` (or `Failed` before up). Idempotent.
    pub fn close(&self, reason: ByeReason) {
        todo!("NET")
    }

    // ── used by send.rs / recv.rs ──

    /// Attaches the media handler (one per link).
    pub fn set_handler(&self, handler: Arc<dyn PacketHandler>) {
        todo!("NET")
    }

    /// Queues the plaintexts of one frame (from [`crate::net::frame::shard_frame`]) for paced sending.
    pub fn send_video(&self, plaintexts: &[Vec<u8>]) {
        todo!("NET")
    }

    /// Sends one audio plaintext (ahead of queued video).
    pub fn send_audio(&self, plaintext: &[u8]) {
        todo!("NET")
    }

    /// Sends an unreliable media ctrl message (FrameLost, Keyframe, Report) at once.
    pub fn send_ctrl(&self, msg: &Ctrl) {
        todo!("NET")
    }
}

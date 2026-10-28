//! Endpoint behaviour over 127.0.0.1 (docs/NATIVE-PATH.md §5, §7): server-reflexive candidates from a fake STUN
//! server, link limits, unauthenticated traffic, App messages queued before a link is up, closing an endpoint.

use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver as Rx};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use st_media::net::ice::{CandidateKind, DEADLINE_MS};
use st_media::net::link::{Endpoint, EndpointConfig, Link, LinkEvent, LinkSink, MAX_LINKS};
use st_media::net::wire::{Header, Kind, TAG_LEN};
use st_media::{Candidate, Role};

fn sink() -> (LinkSink, Rx<LinkEvent>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |e| drop(tx.lock().unwrap().send(e))), rx)
}

fn wait_for(rx: &Rx<LinkEvent>, within: Duration, pred: impl Fn(&LinkEvent) -> bool) -> Option<LinkEvent> {
    let end = Instant::now() + within;
    loop {
        match rx.recv_timeout(end.saturating_duration_since(Instant::now())) {
            Ok(e) if pred(&e) => return Some(e),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

fn endpoint(stun: Vec<String>) -> Arc<Endpoint> {
    Endpoint::open(EndpointConfig { stun, loopback: true }).unwrap()
}

/// A fake STUN server on 127.0.0.1: answers Binding Requests with XOR-MAPPED-ADDRESS `mapped` (from another
/// socket when `stranger`), or not at all when `mute`. Counts the requests.
struct FakeStun {
    url: String,
    requests: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
}

impl FakeStun {
    fn start(mapped: SocketAddr, mute: bool, stranger: bool) -> FakeStun {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let other = UdpSocket::bind("127.0.0.1:0").unwrap();
        let s = FakeStun {
            url: format!("stun:127.0.0.1:{}", sock.local_addr().unwrap().port()),
            requests: Arc::new(AtomicU32::new(0)),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let (requests, stop) = (s.requests.clone(), s.stop.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            while !stop.load(Ordering::Relaxed) {
                let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
                if n < 20 || buf[0..2] != [0, 1] || buf[4..8] != [0x21, 0x12, 0xa4, 0x42] {
                    continue;
                }
                requests.fetch_add(1, Ordering::Relaxed);
                if mute {
                    continue;
                }
                let SocketAddr::V4(m) = mapped else { unreachable!() };
                let mut r = vec![0x01, 0x01, 0x00, 0x0c, 0x21, 0x12, 0xa4, 0x42];
                r.extend_from_slice(&buf[8..20]);
                r.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
                r.extend_from_slice(&(m.port() ^ 0x2112).to_be_bytes());
                for (b, c) in m.ip().octets().iter().zip([0x21, 0x12, 0xa4, 0x42]) {
                    r.push(b ^ c);
                }
                let _ = if stranger { other.send_to(&r, from) } else { sock.send_to(&r, from) };
            }
        });
        s
    }
}

impl Drop for FakeStun {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[test]
fn stun_gives_a_server_reflexive_candidate_and_caches_it() {
    let mapped: SocketAddr = "203.0.113.7:4242".parse().unwrap();
    let stun = FakeStun::start(mapped, false, false);
    let ep = endpoint(vec![stun.url.clone()]);
    let (s1, rx1) = sink();
    let l1 = ep.create_link(Role::Share, s1).unwrap();
    // the first link learns it late, as an event (→ 'nvice' in the app)
    let ev = wait_for(&rx1, Duration::from_secs(2), |e| matches!(e, LinkEvent::Candidates(_)));
    let want = Candidate { addr: mapped, kind: CandidateKind::Srflx };
    assert!(matches!(&ev, Some(LinkEvent::Candidates(c)) if c == &vec![want]), "{ev:?}");
    assert!(l1.local_candidates().contains(&want));
    assert_eq!(want.addr_string(), "203.0.113.7:4242");
    assert_eq!(stun.requests.load(Ordering::Relaxed), 1);

    // a second link within 30 s has it at once, without asking the server again
    let (s2, rx2) = sink();
    let l2 = ep.create_link(Role::Watch, s2).unwrap();
    assert!(l2.local_candidates().contains(&want));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stun.requests.load(Ordering::Relaxed), 1);
    assert!(wait_for(&rx2, Duration::from_millis(50), |e| matches!(e, LinkEvent::Candidates(_))).is_none());

    // the same list again keeps the cache; another list drops it and the next link asks again
    ep.set_stun(vec![stun.url.clone()]);
    let (s3, _rx3) = sink();
    assert!(ep.create_link(Role::Share, s3).unwrap().local_candidates().contains(&want));
    ep.set_stun(vec![format!("{}?transport=udp", stun.url)]);
    let (s4, rx4) = sink();
    let l4 = ep.create_link(Role::Share, s4).unwrap();
    assert!(!l4.local_candidates().contains(&want));
    assert!(wait_for(&rx4, Duration::from_secs(2), |e| matches!(e, LinkEvent::Candidates(_))).is_some());
    assert_eq!(stun.requests.load(Ordering::Relaxed), 2);
    ep.close();
}

#[test]
fn stun_retransmits_then_gives_up() {
    let stun = FakeStun::start("203.0.113.7:4242".parse().unwrap(), true, false);
    let ep = endpoint(vec![stun.url.clone(), "turn:ignored.example".into(), "stun:".into()]);
    let (s, rx) = sink();
    let l = ep.create_link(Role::Share, s).unwrap();
    std::thread::sleep(Duration::from_millis(2_000));
    // requests at 0, 250 and 750 ms, nothing after the 1.5 s timeout, and no candidate
    assert_eq!(stun.requests.load(Ordering::Relaxed), 3);
    assert!(rx.try_iter().all(|e| !matches!(e, LinkEvent::Candidates(_))));
    assert!(l.local_candidates().iter().all(|c| c.kind == CandidateKind::Host));
}

#[test]
fn stun_answers_from_another_address_are_ignored() {
    let stun = FakeStun::start("203.0.113.7:4242".parse().unwrap(), false, true);
    let ep = endpoint(vec![stun.url.clone()]);
    let (s, rx) = sink();
    let l = ep.create_link(Role::Share, s).unwrap();
    assert!(wait_for(&rx, Duration::from_millis(1_800), |e| matches!(e, LinkEvent::Candidates(_))).is_none());
    assert!(stun.requests.load(Ordering::Relaxed) >= 1);
    assert!(l.local_candidates().iter().all(|c| c.kind == CandidateKind::Host));
}

#[test]
fn at_most_max_links_per_endpoint() {
    let ep = endpoint(Vec::new());
    let mut links: Vec<Arc<Link>> = (0..MAX_LINKS).map(|_| ep.create_link(Role::Share, sink().0).unwrap()).collect();
    assert!(ep.create_link(Role::Share, sink().0).is_err());
    let mut ids: Vec<u32> = links.iter().map(|l| l.id()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), MAX_LINKS);
    assert!(ids.iter().all(|&id| id != 0));
    assert!(ep.link(ids[3]).is_some());
    // a link that failed is forgotten, which frees its slot
    let l = links.pop().unwrap();
    l.close(st_media::net::ctrl::ByeReason::Closed);
    std::thread::sleep(Duration::from_millis(50));
    assert!(ep.link(l.id()).is_none());
    assert!(ep.create_link(Role::Share, sink().0).is_ok());
    // set_remote validates its input
    assert!(links[0].set_remote(0, [1; 32], &[]).is_err());
    ep.close();
    assert!(ep.create_link(Role::Share, sink().0).is_err(), "closed endpoint");
}

/// Forged datagrams for a real link id: never answered, and after 50 failed authentications per second a source
/// is not even tried any more.
#[test]
fn unauthenticated_datagrams_are_rate_limited_and_never_answered() {
    let ep = endpoint(Vec::new());
    let (s, _rx) = sink();
    let l = ep.create_link(Role::Share, s).unwrap();
    let attacker = UdpSocket::bind("127.0.0.1:0").unwrap();
    attacker.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    // keys exist only after set_remote: before, datagrams are dropped without an AEAD check
    let to: SocketAddr = format!("127.0.0.1:{}", ep.port()).parse().unwrap();
    let forged = |pn: u64| {
        let mut d = Header { kind: Kind::Probe, epoch: 0, link: l.id(), pn }.encode().to_vec();
        d.extend_from_slice(&[7u8; 13 + TAG_LEN]);
        d
    };
    attacker.send_to(&forged(1), to).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(l.stats().rejected, 0);
    l.set_remote(99, [5; 32], &[Candidate::parse("127.0.0.1:9", "host").unwrap()]).unwrap();
    for pn in 1..=400 {
        attacker.send_to(&forged(pn), to).unwrap();
    }
    std::thread::sleep(Duration::from_millis(200));
    let rejected = l.stats().rejected;
    assert!((50..=70).contains(&rejected), "tried {rejected} forged datagrams");
    let mut buf = [0u8; 64];
    assert!(attacker.recv_from(&mut buf).is_err(), "a forged probe was answered");
    ep.close();
}

/// Two endpoints connected directly (each told the other's host candidate).
fn direct(s_role_events: LinkSink, v_events: LinkSink) -> (Arc<Endpoint>, Arc<Endpoint>, Arc<Link>, Arc<Link>) {
    let (se, ve) = (endpoint(Vec::new()), endpoint(Vec::new()));
    let sl = se.create_link(Role::Share, s_role_events).unwrap();
    let vl = ve.create_link(Role::Watch, v_events).unwrap();
    (se, ve, sl, vl)
}

#[test]
fn messages_queued_before_up_arrive_in_order_and_endpoint_close_says_bye() {
    let (ss, srx) = sink();
    let (vs, vrx) = sink();
    let (se, _ve, sl, vl) = direct(ss, vs);
    // queued before the peer is even known
    for i in 0..5 {
        sl.send_message(&format!("early {i}")).unwrap();
    }
    assert!(sl.send_message(&"x".repeat(1001)).is_err());
    sl.set_remote(vl.id(), vl.key_half(), &vl.local_candidates()).unwrap();
    vl.set_remote(sl.id(), sl.key_half(), &sl.local_candidates()).unwrap();
    let up = wait_for(&vrx, Duration::from_millis(DEADLINE_MS), |e| matches!(e, LinkEvent::Up(_)));
    assert!(matches!(up, Some(LinkEvent::Up(p)) if p.lan && p.remote.port() == se.port()));
    let mut got = Vec::new();
    while got.len() < 5 {
        match wait_for(&vrx, Duration::from_secs(1), |e| matches!(e, LinkEvent::Message(_))) {
            Some(LinkEvent::Message(m)) => got.push(m),
            other => panic!("expected a message, got {other:?}"),
        }
    }
    assert_eq!(got, (0..5).map(|i| format!("early {i}")).collect::<Vec<_>>());
    assert!(wait_for(&srx, Duration::from_millis(DEADLINE_MS), |e| matches!(e, LinkEvent::Up(_))).is_some());
    // the sharer's app quits: its endpoint says Bye on every link
    se.close();
    let bye = wait_for(&vrx, Duration::from_secs(1), |e| matches!(e, LinkEvent::Closed(_)));
    assert!(matches!(&bye, Some(LinkEvent::Closed(r)) if r == "bye"), "{bye:?}");
    let ours = wait_for(&srx, Duration::from_secs(1), |e| matches!(e, LinkEvent::Closed(_)));
    assert!(matches!(&ours, Some(LinkEvent::Closed(r)) if r == "closed"), "{ours:?}");
    // nothing follows a final event
    assert!(wait_for(&vrx, Duration::from_millis(200), |_| true).is_none());
}

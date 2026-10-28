//! The sender's decisions (docs/NATIVE-PATH.md §6.6), driven directly with synthetic times: key frame hold and
//! coalescing, repeated FrameLost, RFI only when every viewer can, rate control over the slowest link.
//!
//! The links live on a loopback endpoint. Most rigs never connect them, so no network timer interferes; the
//! FrameLost rigs connect them (a link waiting for its first key frame ignores FrameLost) and then use times ten
//! seconds ahead, which the real network timers never reach during a test.

use std::sync::{Arc, Mutex};

use st_media::clock::now_us;
use st_media::net::ctrl::{Ctrl, ReceiverReport};
use st_media::net::link::{Endpoint, EndpointConfig, Link, PacketHandler};
use st_media::send::{Sender, SenderConfig, ViewerCaps, KEYFRAME_HOLD_MS};
use st_media::{Codec, EncodedFrame, EncoderRequest, Role};

const MS: u64 = 1000;

struct Rig {
    _ep: Arc<Endpoint>,
    _viewers: Option<(Arc<Endpoint>, Vec<Arc<Link>>)>,
    links: Vec<Arc<Link>>,
    sender: Arc<Sender>,
    requests: Arc<Mutex<Vec<EncoderRequest>>>,
}

impl Rig {
    fn new(rfi: &[bool], target_kbps: u32, fixed: bool) -> Rig {
        Self::build(rfi, target_kbps, fixed, false)
    }

    /// Links that are up and got their first key frame (frame id 1); no requests pending.
    fn connected(rfi: &[bool]) -> Rig {
        Self::build(rfi, 20_000, true, true)
    }

    fn build(rfi: &[bool], target_kbps: u32, fixed: bool, connect: bool) -> Rig {
        let ep = Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let r = requests.clone();
        let sender = Sender::new(SenderConfig { codec: Codec::H264, target_kbps, fixed }, Arc::new(move |q| r.lock().unwrap().push(q)));
        let links: Vec<Arc<Link>> = rfi
            .iter()
            .map(|&rfi| {
                let l = ep.create_link(Role::Share, Arc::new(|_| {})).unwrap();
                sender.add_link(&l, ViewerCaps { rfi });
                l
            })
            .collect();
        let mut viewers = None;
        if connect {
            let vep = Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).unwrap();
            let vls: Vec<Arc<Link>> = links
                .iter()
                .map(|l| {
                    let v = vep.create_link(Role::Watch, Arc::new(|_| {})).unwrap();
                    l.set_remote(v.id(), v.public_key(), &v.local_candidates()).unwrap();
                    v.set_remote(l.id(), l.public_key(), &l.local_candidates()).unwrap();
                    v
                })
                .collect();
            let until = now_us() + 2_500 * MS;
            while !links.iter().all(|l| l.is_up()) {
                assert!(now_us() < until, "links did not come up");
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            viewers = Some((vep, vls));
        }
        let rig = Rig { _ep: ep, _viewers: viewers, links, sender, requests };
        if connect {
            rig.key_frame(1);
            std::thread::sleep(std::time::Duration::from_millis(20));
            rig.take();
        }
        rig
    }

    /// Requests since the last call.
    fn take(&self) -> Vec<EncoderRequest> {
        std::mem::take(&mut *self.requests.lock().unwrap())
    }

    fn ctrl(&self, link: usize, msg: Ctrl, at: u64) {
        self.sender.on_ctrl(&self.links[link], msg, at);
    }

    fn key_frame(&self, id: u32) {
        let t = now_us();
        self.sender.push_frame(&EncodedFrame {
            frame_id: id,
            codec: Codec::H264,
            key: true,
            after_invalidation: false,
            repeat: false,
            data: vec![0, 0, 0, 1, 0x65],
            capture_us: t,
            encoded_us: t,
            width: 64,
            height: 64,
        });
    }
}

#[test]
fn key_frame_requests_are_held_and_coalesced() {
    let rig = Rig::new(&[false], 20_000, true);
    assert_eq!(rig.sender.link_count(), 1);
    // links that are not up get nothing and ask for nothing yet
    assert!(rig.take().is_empty());
    let t0 = now_us();
    rig.ctrl(0, Ctrl::Keyframe, t0);
    assert_eq!(rig.take(), vec![EncoderRequest::Keyframe]);
    // the key frame is on its way: a repeat of the request changes nothing
    rig.ctrl(0, Ctrl::Keyframe, t0 + 5 * MS);
    assert!(rig.take().is_empty());
    rig.key_frame(1);
    // a request that crossed that key frame on the way is answered already
    rig.ctrl(0, Ctrl::Keyframe, now_us() + 5 * MS);
    assert!(rig.take().is_empty());
    // a real new request inside the 200 ms hold waits for its end, then goes out once
    rig.ctrl(0, Ctrl::Keyframe, t0 + 50 * MS);
    rig.ctrl(0, Ctrl::FrameLost { first: 4, last: 4 }, t0 + 60 * MS);
    assert!(rig.take().is_empty());
    rig.sender.on_tick(&rig.links[0], t0 + 150 * MS);
    assert!(rig.take().is_empty());
    rig.sender.on_tick(&rig.links[0], t0 + KEYFRAME_HOLD_MS * MS);
    assert_eq!(rig.take(), vec![EncoderRequest::Keyframe]);
    assert_eq!(rig.sender.stats().keyframes, 2);
}

#[test]
fn repeated_and_outdated_frame_lost_is_ignored() {
    let rig = Rig::connected(&[false]);
    let t0 = now_us() + 10_000 * MS;
    rig.ctrl(0, Ctrl::FrameLost { first: 10, last: 12 }, t0);
    assert_eq!(rig.take(), vec![EncoderRequest::Keyframe]);
    rig.key_frame(13);
    // the viewer repeats until the key frame arrives: same range, or an older one
    rig.ctrl(0, Ctrl::FrameLost { first: 10, last: 12 }, t0 + 300 * MS);
    rig.ctrl(0, Ctrl::FrameLost { first: 11, last: 11 }, t0 + 310 * MS);
    assert!(rig.take().is_empty());
    // a loss before the newest key frame needs nothing (that key frame repairs it)
    rig.key_frame(30);
    rig.ctrl(0, Ctrl::FrameLost { first: 20, last: 25 }, t0 + 600 * MS);
    assert!(rig.take().is_empty());
    // a new loss after it does
    rig.ctrl(0, Ctrl::FrameLost { first: 31, last: 31 }, t0 + 900 * MS);
    assert_eq!(rig.take(), vec![EncoderRequest::Keyframe]);
}

#[test]
fn reference_invalidation_only_when_every_viewer_can() {
    let rig = Rig::connected(&[true]);
    rig.ctrl(0, Ctrl::FrameLost { first: 5, last: 7 }, now_us() + 10_000 * MS);
    assert_eq!(rig.take(), vec![EncoderRequest::InvalidateRefs { first: 5, last: 7 }]);
    assert_eq!(rig.sender.stats().invalidations, 1);
    let mixed = Rig::connected(&[true, false]);
    mixed.ctrl(0, Ctrl::FrameLost { first: 5, last: 7 }, now_us() + 10_000 * MS);
    assert_eq!(mixed.take(), vec![EncoderRequest::Keyframe]);
}

fn report(frames: u32, lost: u32) -> Ctrl {
    Ctrl::Report(ReceiverReport { frames, lost, ..Default::default() })
}

#[test]
fn auto_rate_follows_the_slowest_link_and_a_fixed_rate_never_moves() {
    let rig = Rig::new(&[false, false], 20_000, false);
    let t0 = now_us();
    let mut changes = Vec::new();
    for i in 0..10u64 {
        let at = t0 + i * 200 * MS;
        rig.ctrl(0, report(57, 3), at); // 5 % frame loss on link 0
        rig.ctrl(1, report(60, 0), at);
        changes.extend(rig.take());
    }
    // link 0 backs off twice in those 2 s; the encoder follows the minimum
    assert_eq!(changes, vec![EncoderRequest::Bitrate { kbps: 16_000 }, EncoderRequest::Bitrate { kbps: 12_800 }]);
    assert_eq!(rig.sender.stats().target_kbps, 12_800);
    // the user (or Auto with a new size) sets a new target: everything starts over from it
    rig.sender.set_target(30_000, false);
    assert_eq!(rig.sender.stats().target_kbps, 30_000);

    let fixed = Rig::new(&[false], 20_000, true);
    for i in 0..20u64 {
        fixed.ctrl(0, report(10, 10), t0 + i * 200 * MS);
    }
    assert!(fixed.take().is_empty());
    assert_eq!(fixed.sender.stats().target_kbps, 20_000);
}

#[test]
fn links_come_and_go() {
    let rig = Rig::new(&[false, false], 8_000, true);
    assert_eq!(rig.sender.link_count(), 2);
    // adding the same link again only updates its caps
    rig.sender.add_link(&rig.links[0], ViewerCaps { rfi: true });
    assert_eq!(rig.sender.link_count(), 2);
    rig.sender.remove_link(rig.links[0].id());
    assert_eq!(rig.sender.link_count(), 1);
    // feedback of a removed link is ignored
    rig.ctrl(0, Ctrl::Keyframe, now_us());
    assert!(rig.take().is_empty());
    let s = rig.sender.stats();
    assert_eq!((s.codec.as_str(), s.links, s.frames), ("h264", 1, 0));
    // malformed sound is dropped, not sent
    rig.sender.push_audio(&st_media::AudioChunk { seq: 1, capture_us: 0, pcm: vec![0; 3] });
    rig.sender.push_audio(&st_media::AudioChunk { seq: 2, capture_us: 0, pcm: vec![0; 2000] });
}

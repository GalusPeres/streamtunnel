//! The whole sharer → viewer path in one process (docs/NATIVE-PATH.md §12, WIN): TestPattern → NVENC →
//! `send::Sender` → loopback `Link` (127.0.0.1, no firewall prompt) → `recv::Receiver`, wired exactly as §8
//! "Wiring a share codec" says. Access units arrive complete and in decode order, starting with a key frame.
//! Skips without NVENC, and while NET's transport is still a skeleton (its `todo!()`s), so it switches itself on
//! once both halves are merged.
#![cfg(windows)]

mod win_common;

use std::sync::mpsc::{channel, Receiver as Rx};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use st_media::net::ctrl::ByeReason;
use st_media::recv::{RecvEvent, Receiver};
use st_media::send::{Sender, SenderConfig, ViewerCaps};
use st_media::win::{CaptureConfig, CaptureSession, Source};
use st_media::{Codec, Endpoint, EndpointConfig, LinkEvent, Role};
use win_common::{check_au, gpu_lock, nvenc_gpu};

/// Ok(endpoint), or None when NET's endpoint is still `todo!()` in this tree.
fn open_endpoint() -> Option<Arc<Endpoint>> {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = std::panic::catch_unwind(|| Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }));
    std::panic::set_hook(hook);
    match r {
        Ok(ep) => Some(ep.expect("endpoint on 127.0.0.1")),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(msg.contains("not yet implemented"), "Endpoint::open panicked: {msg}");
            eprintln!("skipped: the stm/1 transport is not built yet ({msg})");
            None
        }
    }
}

fn wait_up(events: &Rx<LinkEvent>, who: &str) {
    let deadline = std::time::Instant::now() + Duration::from_millis(st_media::net::ice::DEADLINE_MS + 1000);
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match events.recv_timeout(left) {
            Ok(LinkEvent::Up(path)) => {
                eprintln!("{who}: up via {} (lan {})", path.remote, path.lan);
                return;
            }
            Ok(LinkEvent::Failed(e)) | Ok(LinkEvent::Closed(e)) => panic!("{who}: link failed: {e}"),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    panic!("{who}: no Up within the deadline");
}

#[test]
fn test_pattern_to_receiver_over_loopback() {
    let _gpu_lock = gpu_lock();
    if nvenc_gpu().is_none() {
        return;
    }
    let Some(share_ep) = open_endpoint() else { return };
    let watch_ep = Endpoint::open(EndpointConfig { stun: Vec::new(), loopback: true }).expect("viewer endpoint");

    // links, as nm_link_open / nm_link_remote do it (signaling replaced by direct calls)
    let (share_tx, share_events) = channel();
    let (watch_tx, watch_events) = channel();
    let share_tx = Mutex::new(share_tx);
    let watch_tx = Mutex::new(watch_tx);
    let share_link = share_ep.create_link(Role::Share, Arc::new(move |e| drop(share_tx.lock().unwrap().send(e)))).expect("share link");
    let watch_link = watch_ep.create_link(Role::Watch, Arc::new(move |e| drop(watch_tx.lock().unwrap().send(e)))).expect("watch link");
    watch_link.set_remote(share_link.id(), share_link.key_half(), &share_link.local_candidates()).expect("viewer remote");
    share_link.set_remote(watch_link.id(), watch_link.key_half(), &watch_link.local_candidates()).expect("sharer remote");
    wait_up(&share_events, "sharer");
    wait_up(&watch_events, "viewer");

    // the viewer side
    let aus = Arc::new(Mutex::new(Vec::new()));
    let got = aus.clone();
    let receiver = Receiver::attach(
        &watch_link,
        Arc::new(move |e| {
            if let RecvEvent::Video(au) = e {
                got.lock().unwrap().push(au);
            }
        }),
    );

    // the sharer side: §8 "Wiring a share codec"
    let codec = if st_media::win::probe().hevc { Codec::Hevc } else { Codec::H264 };
    let cell: Arc<OnceLock<Arc<Sender>>> = Arc::new(OnceLock::new());
    let c = cell.clone();
    let cfg = CaptureConfig { codec, fps: 60, max_height: 0, bitrate_kbps: 0, vbv_frames: 2.0, cursor: false };
    let mut capture = CaptureSession::start(
        Source::TestPattern { width: 1280, height: 720 },
        cfg,
        Box::new(move |f| {
            if let Some(s) = c.get() {
                s.push_frame(&f);
            }
        }),
    )
    .expect("capture");
    let sender = Sender::new(SenderConfig { codec, target_kbps: capture.stats().target_kbps, fixed: false }, capture.request_handle());
    let _ = cell.set(sender.clone());
    sender.add_link(&share_link, ViewerCaps { rfi: false });

    std::thread::sleep(Duration::from_millis(2000));
    let got = aus.lock().unwrap().clone();
    let tc = if codec == Codec::Hevc { win_common::Codec::Hevc } else { win_common::Codec::H264 };
    eprintln!("{} access units in 2 s, sender {:?}, receiver {:?}", got.len(), sender.stats(), receiver.stats());
    assert!(got.len() >= 100, "{} access units in 2 s at 60 fps", got.len());
    assert!(got[0].key, "the first access unit a new link gets is a key frame");
    for (i, au) in got.iter().enumerate() {
        assert_eq!(au.codec, codec);
        let (key, _) = check_au(tc, &au.data).unwrap_or_else(|e| panic!("access unit {i}: {e}"));
        assert_eq!(key, au.key);
        if i > 0 {
            // loopback without loss: every frame, in decode order
            assert_eq!(au.frame_id, got[i - 1].frame_id + 1, "access unit {i}: decode order complete");
        }
    }

    receiver.close();
    sender.remove_link(share_link.id());
    share_link.close(ByeReason::Ended);
    watch_link.close(ByeReason::Closed);
    capture.stop();
    share_ep.close();
    watch_ep.close();
}

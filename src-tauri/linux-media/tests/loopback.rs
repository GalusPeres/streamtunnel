//! Loopback test of the media engine without a browser: a second GStreamer webrtcbin plays the sharer (offers
//! H.264 + Opus + the negotiated "ctl" data channel), `Peer` answers. Checks that key-framed H.264 access units
//! arrive, audio is linked, the data channel works in both directions and stats can be read.
//! Needs x264enc (gst-plugins-ugly) for the sender; skipped (passes with a note) when it is missing.
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use st_linux_media::gst::{self, glib, prelude::*};
use st_linux_media::{gst_sdp as gst_sdp_dc, gst_webrtc as gst_webrtc_dc, missing_elements, Config, Event, Peer};

#[test]
fn loopback_h264_opus_datachannel() {
    st_linux_media::init().expect("gst init");
    eprintln!("GStreamer: {}", st_linux_media::gstreamer_version());
    let missing = missing_elements();
    assert!(missing.is_empty(), "missing GStreamer elements: {missing:?}");
    if gst::ElementFactory::find("x264enc").is_none() {
        eprintln!("SKIP: x264enc not installed");
        return;
    }

    let sender = gst::parse_launch(
        "webrtcbin name=send bundle-policy=max-bundle latency=50 \
         videotestsrc is-live=true pattern=ball ! video/x-raw,width=320,height=240,framerate=30/1 \
         ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=30 ! video/x-h264,profile=constrained-baseline \
         ! rtph264pay config-interval=-1 pt=102 aggregate-mode=zero-latency \
         ! application/x-rtp,media=video,encoding-name=H264,payload=102,clock-rate=90000,rtcp-fb-nack-pli=true,rtcp-fb-transport-cc=true, extmap-3=(string)\"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\" ! send. \
         audiotestsrc is-live=true wave=sine ! audioconvert ! audioresample ! opusenc ! rtpopuspay pt=111 \
         ! application/x-rtp,media=audio,encoding-name=OPUS,payload=111,clock-rate=48000 ! send.",
    )
    .expect("sender pipeline")
    .downcast::<gst::Pipeline>()
    .unwrap();
    let send = sender.by_name("send").unwrap();
    sender.set_state(gst::State::Playing).expect("sender playing");

    let opts = gst::Structure::builder("config").field("negotiated", true).field("id", 0i32).field("ordered", true).build();
    let send_dc = send
        .emit_by_name::<Option<gst_webrtc_dc::WebRTCDataChannel>>("create-data-channel", &[&"ctl", &opts])
        .expect("sender data channel");
    let (sender_rx_tx, sender_rx) = mpsc::channel::<String>();
    send_dc.connect_on_message_string(move |_, s| {
        if let Some(s) = s {
            let _ = sender_rx_tx.send(s.to_string());
        }
    });
    let send_dc_open = Arc::new(Mutex::new(false));
    {
        let o = send_dc_open.clone();
        send_dc.connect_on_open(move |_| *o.lock().unwrap() = true);
    }

    // Receiver (the engine under test).
    let (ev_tx, ev_rx) = mpsc::channel::<Event>();
    let ev_tx = Mutex::new(ev_tx);
    let peer = Peer::new(
        &Config { stun: None, turn: vec![], latency_ms: 50, audio_sink: Some("fakesink sync=true".into()) },
        Arc::new(move |e| {
            let _ = ev_tx.lock().unwrap().send(e);
        }),
    )
    .expect("peer");
    let peer = Arc::new(peer);

    // Sender ICE → receiver.
    {
        let peer = peer.clone();
        send.connect("on-ice-candidate", false, move |v| {
            let mline = v[1].get::<u32>().unwrap();
            let c = v[2].get::<String>().unwrap();
            peer.add_ice_candidate(mline, &c);
            None
        });
    }

    // Offer.
    let (otx, orx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |r| {
        let offer = r.unwrap().unwrap().get::<gst_webrtc_dc::WebRTCSessionDescription>("offer").unwrap();
        let _ = otx.send(offer);
    });
    send.emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);
    let offer = orx.recv_timeout(Duration::from_secs(10)).expect("offer");
    send.emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
    let offer_sdp = offer.sdp().as_text().unwrap();
    eprintln!("--- offer ---\n{offer_sdp}");

    peer.set_remote_offer(&offer_sdp).expect("set remote offer");
    let answer_sdp = peer.create_answer().expect("answer");
    eprintln!("--- answer ---\n{answer_sdp}");
    assert!(answer_sdp.contains("H264"), "answer without H264");
    // Informational (the TS side patches the answer if webrtcbin drops it): does the answer echo transport-cc?
    eprintln!(
        "offer transport-cc: {} / answer transport-cc: {}",
        offer_sdp.contains("transport-wide-cc"),
        answer_sdp.contains("transport-wide-cc")
    );
    let answer = gst_webrtc_dc::WebRTCSessionDescription::new(
        gst_webrtc_dc::WebRTCSDPType::Answer,
        gst_sdp_dc::SDPMessage::parse_buffer(answer_sdp.as_bytes()).unwrap(),
    );
    send.emit_by_name::<()>("set-remote-description", &[&answer, &None::<gst::Promise>]);

    // Pump receiver events until everything arrived.
    let deadline = Instant::now() + Duration::from_secs(30);
    let (mut frames, mut keys, mut bytes) = (0u32, 0u32, 0usize);
    let (mut dc_open, mut dc_msg, mut audio, mut connected, mut sent_hello) = (false, false, false, false, false);
    let mut sent_ping = false;
    while Instant::now() < deadline {
        match ev_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::IceCandidate { mline, candidate }) => {
                send.emit_by_name::<()>("add-ice-candidate", &[&mline, &candidate]);
            }
            Ok(Event::Video { key, data, .. }) => {
                frames += 1;
                bytes += data.len();
                if key {
                    keys += 1;
                    // Annex B start code + SPS (type 7) in front of every IDR (h264parse config-interval=-1).
                    assert!(data.starts_with(&[0, 0, 0, 1]) || data.starts_with(&[0, 0, 1]), "not Annex B");
                }
            }
            Ok(Event::Track("audio")) => audio = true,
            Ok(Event::DcOpen) => dc_open = true,
            Ok(Event::DcMessage(m)) => {
                eprintln!("receiver got: {m}");
                dc_msg = m == "ping";
            }
            Ok(Event::State { connection, ice }) => {
                eprintln!("state: {connection} / {ice}");
                if connection == "connected" || ice == "connected" || ice == "completed" {
                    connected = true;
                }
            }
            Ok(Event::Error(e)) => eprintln!("engine: {e}"),
            Ok(other) => eprintln!("event: {other:?}"),
            Err(_) => {}
        }
        if dc_open && !sent_hello && peer.dc_send("hello").is_ok() {
            sent_hello = true;
        }
        if *send_dc_open.lock().unwrap() && !sent_ping {
            send_dc.send_string(Some("ping"));
            sent_ping = true;
        }
        if frames >= 30 && keys >= 1 && dc_open && dc_msg && audio && connected && sent_hello {
            break;
        }
    }
    let got_hello = sender_rx.recv_timeout(Duration::from_secs(3)).ok();
    let stats = peer.stats().expect("stats");
    for (id, fields) in &stats {
        eprintln!("stats {id}: {fields:?}");
    }
    eprintln!("frames={frames} keys={keys} bytes={bytes} dc_open={dc_open} dc_msg={dc_msg} audio={audio} connected={connected} hello={got_hello:?}");
    peer.close();
    let _ = sender.set_state(gst::State::Null);
    let _ = glib::MainContext::default();

    assert!(connected, "never connected");
    assert!(frames >= 30, "only {frames} video access units");
    assert!(keys >= 1, "no key frame");
    assert!(audio, "audio pad never linked");
    assert!(dc_open && dc_msg, "data channel sender → receiver failed");
    assert_eq!(got_hello.as_deref(), Some("hello"), "data channel receiver → sender failed");
    assert!(!stats.is_empty(), "no stats");
}

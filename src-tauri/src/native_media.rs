//! Native media path (docs/NATIVE-PATH.md): the Tauri glue between the page (`src/rtc/nativelink.ts`) and the
//! `st-media` crate. Every OS can watch natively; sharing needs Windows + NVENC.
//!
//! One `st_media::Endpoint` (the app's UDP socket) is opened lazily. Each sharer–viewer pair is a link, created
//! with `nm_link_open` and fed the peer's parameters (from the `nv` signaling) with `nm_link_remote`. A link's
//! events flow back over its Tauri `Channel`:
//! * JSON `{t:'cand'|'up'|'fail'|'closed'|'msg'|'stats', …}` (docs/NATIVE-PATH.md §9.2);
//! * raw bytes (watch links only) = one video access unit or 20 ms of PCM, see [`video_message`] /
//!   [`audio_message`].
//!
//! A share (`nm_share_open`) owns one `win::CaptureSession` + `send::Sender` per codec in use, started when the
//! first link of that codec is added and stopped with its last link. Its own `Channel` gets `{t:'info'|'stats'|
//! 'ended'|'err', …}`. Share sound: while a share with audio is open, the WASAPI capture of `sysaudio.rs` (the one
//! the page already runs for the WebRTC track) is tapped, converted to s16 and pushed to every sender in 5 ms
//! chunks.
#![allow(dead_code, unused_variables)] // skeleton: remove when the bodies are filled

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

const NOT_YET: &str = "native path not available in this build";

/// What this app can do natively (`nm_caps`).
#[derive(Serialize)]
pub struct NmCaps {
    /// stm version and oldest version we talk to
    v: u8,
    min: u8,
    /// sharing: Some when NVENC works (Windows only)
    share: Option<ShareCaps>,
    /// receiving: the Rust side works on this OS (the page still checks WebCodecs)
    watch: bool,
}

#[derive(Serialize)]
pub struct ShareCaps {
    /// "hevc" | "h264", best first
    codecs: Vec<String>,
    /// adapter name, e.g. "NVIDIA GeForce RTX 4080"
    gpu: String,
}

/// A candidate as the signaling carries it.
#[derive(Serialize, Deserialize, Clone)]
pub struct CandidateWire {
    /// "ip:port" | "[v6]:port"
    a: String,
    /// "host" | "srflx"
    k: String,
}

#[derive(Serialize)]
pub struct LinkOpened {
    /// our link id (the peer puts it in every packet header)
    link: u32,
    /// our key half, 64 hex digits
    key: String,
    /// host candidates (+ cached srflx); later ones arrive as {t:'cand'}
    cand: Vec<CandidateWire>,
}

/// `nm_share_open` settings (camelCase from TypeScript).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCfg {
    /// the getDisplayMedia track's deviceId: "window:<hwnd>:0" | "screen:<id>:0"
    source: String,
    /// the track's size (screen matching hint)
    width: u32,
    height: u32,
    fps: u32,
    /// resolution cap in lines, 0 = native
    max_height: u32,
    /// the user's bitrate, 0 = Auto (LAN model)
    kbps: u32,
    /// send share sound
    audio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUpdate {
    fps: u32,
    max_height: u32,
    kbps: u32,
}

#[tauri::command]
pub fn nm_caps() -> NmCaps {
    NmCaps { v: st_media::STM_VERSION, min: st_media::STM_MIN_VERSION, share: None, watch: false }
}

/// New link on the app's endpoint. `role` = "share" | "watch"; `stun` = NetConfig.stun.
#[tauri::command]
pub fn nm_link_open(role: String, stun: Vec<String>, events: Channel<InvokeResponseBody>) -> Result<LinkOpened, String> {
    Err(NOT_YET.into())
}

/// The peer's link id, key half and candidates (from the `nv` join / offer): starts probing.
#[tauri::command]
pub fn nm_link_remote(link: u32, peer_link: u32, key: String, cand: Vec<CandidateWire>) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Late remote candidates (`nvice`).
#[tauri::command]
pub fn nm_link_cand(link: u32, cand: Vec<CandidateWire>) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Reliable App text (a CtlMessage as JSON) to the peer.
#[tauri::command]
pub fn nm_link_send(link: u32, text: String) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Watch link: the page's decoder needs a key frame.
#[tauri::command]
pub fn nm_link_keyframe(link: u32) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Ends a link (Bye with `reason` = "closed" | "kicked" | "ended") and forgets it. Idempotent.
#[tauri::command]
pub fn nm_link_close(link: u32, reason: String) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Opens a native share for the page's current capture. Nothing is captured until the first link is added.
#[tauri::command]
pub fn nm_share_open(cfg: ShareCfg, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    Err(NOT_YET.into())
}

/// Streams `codec` ("hevc" | "h264") of this share to a share link once it is up. `rfi` = the viewer recovers
/// from reference invalidation (false for every WebCodecs viewer in this milestone).
#[tauri::command]
pub fn nm_share_add(share: u32, link: u32, codec: String, rfi: bool) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Stops feeding a link (it stays open, e.g. to send the ctl 'bye').
#[tauri::command]
pub fn nm_share_remove(share: u32, link: u32) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// The user changed fps / resolution cap / bitrate (fps + resolution: reconfigure + IDR; bitrate: no IDR).
#[tauri::command]
pub fn nm_share_update(share: u32, cfg: ShareUpdate) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// The user picked another source ("Quelle wechseln").
#[tauri::command]
pub fn nm_share_source(share: u32, source: String, width: u32, height: u32) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Stops capture + encoders of a share (its links stay open; the page closes them). Idempotent.
#[tauri::command]
pub fn nm_share_close(share: u32) -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Closes every share and link (window closed / page reloaded).
pub fn close_all() {}

// ───────────────────────── page messages (raw Channel bytes, little-endian) ─────────────────────────

/// Kind byte of a video message.
pub const MSG_VIDEO: u8 = 1;
/// Kind byte of an audio message.
pub const MSG_AUDIO: u8 = 2;
pub const VIDEO_MSG_HEADER: usize = 32;
pub const AUDIO_MSG_HEADER: usize = 16;

/// One access unit for the page:
/// ```text
/// [0] u8 1   [1] u8 flags: bit0 key, bit1 recovered by FEC, bit2 first after a loss   [2] u8 codec (1 H.264, 2 HEVC)
/// [3] u8 0   [4..8] u32 frame id   [8..16] u64 pts µs (sender capture clock = WebCodecs timestamp)
/// [16..20] u32 age µs (capture → handed over, 0 = unknown)   [20..24] u32 sender latency µs (capture → encoded)
/// [24..32] u64 wall clock µs at hand-over (page: IPC delay ≈ (timeOrigin + now) × 1000 − this)   [32..] Annex B
/// ```
pub fn video_message(au: &st_media::recv::VideoAu) -> Vec<u8> {
    let mut b = Vec::with_capacity(VIDEO_MSG_HEADER + au.data.len());
    b.push(MSG_VIDEO);
    b.push(u8::from(au.key) | (u8::from(au.recovered) << 1) | (u8::from(au.after_loss) << 2));
    b.push(au.codec as u8);
    b.push(0);
    b.extend_from_slice(&au.frame_id.to_le_bytes());
    b.extend_from_slice(&au.pts_us.to_le_bytes());
    b.extend_from_slice(&au.age_us.to_le_bytes());
    b.extend_from_slice(&au.sender_latency_us.to_le_bytes());
    b.extend_from_slice(&st_media::clock::epoch_us().to_le_bytes());
    b.extend_from_slice(&au.data);
    b
}

/// 20 ms of sound for the page:
/// ```text
/// [0] u8 2   [1] u8 channels (2)   [2] u8 concealed 5 ms packets   [3] u8 0   [4..8] u32 seq
/// [8..16] u64 capture µs (sender clock)   [16..] s16le interleaved PCM (960 frames)
/// ```
pub fn audio_message(block: &st_media::recv::AudioBlock) -> Vec<u8> {
    let mut b = Vec::with_capacity(AUDIO_MSG_HEADER + block.pcm.len() * 2);
    b.push(MSG_AUDIO);
    b.push(st_media::AUDIO_CHANNELS as u8);
    b.push(block.concealed);
    b.push(0);
    b.extend_from_slice(&block.seq.to_le_bytes());
    b.extend_from_slice(&block.capture_us.to_le_bytes());
    for s in &block.pcm {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_message_layout() {
        let au = st_media::recv::VideoAu {
            frame_id: 7,
            codec: st_media::Codec::Hevc,
            key: true,
            recovered: false,
            after_loss: true,
            pts_us: 1_000_000,
            age_us: 12_345,
            sender_latency_us: 3_000,
            data: vec![0, 0, 0, 1, 0x40],
        };
        let m = video_message(&au);
        assert_eq!(m.len(), VIDEO_MSG_HEADER + 5);
        assert_eq!(&m[..4], &[MSG_VIDEO, 0b101, 2, 0]);
        assert_eq!(u32::from_le_bytes(m[4..8].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(m[8..16].try_into().unwrap()), 1_000_000);
        assert_eq!(u32::from_le_bytes(m[16..20].try_into().unwrap()), 12_345);
        assert_eq!(&m[VIDEO_MSG_HEADER..], &[0, 0, 0, 1, 0x40]);
    }

    #[test]
    fn audio_message_layout() {
        let block = st_media::recv::AudioBlock { seq: 9, capture_us: 5, pcm: vec![-1i16; st_media::AUDIO_BLOCK_FRAMES * 2], concealed: 1 };
        let m = audio_message(&block);
        assert_eq!(m.len(), AUDIO_MSG_HEADER + 960 * 2 * 2);
        assert_eq!(&m[..4], &[MSG_AUDIO, 2, 1, 0]);
        assert_eq!(&m[16..18], &[0xff, 0xff]);
    }
}

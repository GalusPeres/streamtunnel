//! The sharer's pipeline for one codec (docs/NATIVE-PATH.md §3): WGC (or the test pattern) → copy into the
//! converter → NV12 slot → NVENC → [`EncodedFrame`] to the sink, on one thread `st-capture` per session.
//!
//! * frames faster than `fps` are skipped (WGC's MinUpdateInterval does most of it); frame ids count encoded
//!   frames from 1;
//! * nothing new for 2 / fps (static content, minimized window) → the last NV12 slot is encoded again with
//!   `repeat = true`, so the encoder runs at ≥ fps / 2 and text sharpens; a minimized window keeps its last
//!   picture;
//! * requests ([`EncoderRequest`]) are applied before the next encode: Keyframe → IDR, InvalidateRefs →
//!   `Encoder::invalidate` (IDR if that fails), Bitrate → `Encoder::set_bitrate`;
//! * resolution and fps stay fixed: only a new source size, [`CaptureSession::set_source`] or
//!   [`CaptureSession::reconfigure`] (user actions) change them, always with an IDR;
//! * the window closed → the sink gets nothing more and `stats().closed` turns true (the glue ends the native
//!   share; the web view's track ends on its own).
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use serde::Serialize;

use crate::{Codec, EncodedFrame, EncoderRequest};

/// What the sharer captures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// HWND from the track's "window:<hwnd>:0"
    Window(isize),
    /// HMONITOR resolved from "screen:<id>:0" (`wgc::resolve_screen`)
    Monitor(isize),
    /// synthetic frames (tests, never the screen)
    TestPattern { width: u32, height: u32 },
}

/// The getDisplayMedia track's `deviceId` → source. `hint_w × hint_h` = the track's size (screen matching).
/// Err for anything else (browser tab, test stream, unknown screen) — that share stays on WebRTC.
pub fn parse_source(device_id: &str, hint_w: u32, hint_h: u32) -> Result<Source, String> {
    let mut parts = device_id.split(':');
    let kind = parts.next().unwrap_or("");
    let id: i64 = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| format!("unknown source '{device_id}'"))?;
    match kind {
        "window" if id != 0 => Ok(Source::Window(id as isize)),
        "screen" => crate::win::wgc::resolve_screen(id, hint_w, hint_h).map(Source::Monitor),
        _ => Err(format!("unknown source '{device_id}'")),
    }
}

/// Session settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureConfig {
    pub codec: Codec,
    pub fps: u32,
    /// max output lines, 0 = native (≤ 2160)
    pub max_height: u32,
    /// the user's CBR target; 0 = Auto: `net::rate::lan_bitrate_kbps(encoder size, fps, codec)`, recomputed at
    /// every size change
    pub bitrate_kbps: u32,
    /// VBV in frames (2.0 by default; see nvenc.rs)
    pub vbv_frames: f32,
    /// draw the mouse pointer
    pub cursor: bool,
}

/// Encoded frames go here, on the `st-capture` thread (the glue hands them to `send::Sender::push_frame`).
pub type FrameSink = Box<dyn FnMut(EncodedFrame) + Send>;

/// Snapshot of a session.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    /// "h264" | "hevc"
    pub codec: String,
    /// always "NVENC" in this milestone
    pub encoder: String,
    /// adapter name, e.g. "NVIDIA GeForce RTX 4080"
    pub gpu: String,
    /// encoder size
    pub width: u32,
    pub height: u32,
    /// target fps (fixed)
    pub fps: u32,
    /// the target from the settings (user value or Auto for the current size); changes only with size / settings.
    /// The glue forwards a change to `send::Sender::set_target`.
    pub target_kbps: u32,
    /// the encoder's current rate (target after back-off requests)
    pub bitrate_kbps: u32,
    /// frames delivered by the capture / encoded, per second over the last second
    pub capture_fps: f32,
    pub encode_fps: f32,
    /// mean capture → encoded over the last second (ms)
    pub encode_ms: f32,
    /// totals
    pub frames: u64,
    pub repeated: u64,
    pub keyframes: u64,
    /// the source window is minimized (last picture repeated)
    pub minimized: bool,
    /// the source is gone (window closed)
    pub closed: bool,
}

/// One running capture + encoder.
pub struct CaptureSession {
    // filled by WIN
}

impl CaptureSession {
    /// Creates the device, the WGC capture (or test pattern), the converter and the encoder, and starts the
    /// `st-capture` thread. Err when any of them fails (the glue answers the viewer "unavailable").
    pub fn start(source: Source, cfg: CaptureConfig, sink: FrameSink) -> Result<CaptureSession, String> {
        todo!("WIN")
    }

    /// Queues a request for the next frame (never blocks).
    pub fn request(&self, r: EncoderRequest) {
        todo!("WIN")
    }

    /// A cloneable handle doing the same as [`CaptureSession::request`] (the `send::Sender`'s request sink; it
    /// does nothing once the session stopped).
    pub fn request_handle(&self) -> crate::send::RequestSink {
        todo!("WIN")
    }

    /// Bitrate / fixed flag changed in the settings (no IDR). 0 = Auto.
    pub fn set_target(&self, kbps: u32) {
        todo!("WIN")
    }

    /// Switches to another window / monitor (the user picked a new source): new capture item, new size, IDR.
    pub fn set_source(&self, source: Source) -> Result<(), String> {
        todo!("WIN")
    }

    /// The user changed fps or the resolution cap: reconfigure + IDR.
    pub fn reconfigure(&self, fps: u32, max_height: u32) -> Result<(), String> {
        todo!("WIN")
    }

    pub fn stats(&self) -> CaptureStats {
        todo!("WIN")
    }

    /// Stops the thread and releases everything. Idempotent; also done on drop.
    pub fn stop(&mut self) {
        todo!("WIN")
    }
}

/// What the machine can share natively. Cached after the first call (NVENC probing opens a session: ~100 ms).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvencCaps {
    /// NVENC usable: driver library, API ≥ 12.0, an NVIDIA adapter, WGC supported
    pub available: bool,
    pub h264: bool,
    pub hevc: bool,
    /// adapter name ("" if none)
    pub gpu: String,
    pub max_width: u32,
    pub max_height: u32,
    /// why not available (log only, never shown raw in the UI)
    pub reason: String,
}

pub fn probe() -> NvencCaps {
    todo!("WIN")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids() {
        assert_eq!(parse_source("window:132456:0", 0, 0), Ok(Source::Window(132456)));
        assert!(parse_source("window:0:0", 0, 0).is_err());
        assert!(parse_source("web-contents-media-stream://1:2", 0, 0).is_err());
        assert!(parse_source("", 0, 0).is_err());
    }
}

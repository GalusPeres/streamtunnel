//! Windows sharer (docs/NATIVE-PATH.md §3): Windows.Graphics.Capture of the window / monitor the user picked in
//! the existing getDisplayMedia dialog → D3D11 (frames never leave the GPU) → NVENC through nvEncodeAPI64.dll
//! loaded at runtime. No NVENC → [`capture::probe`] says so and the app keeps the WebRTC path.
//!
//! Tests never capture the real screen: [`capture::Source::TestPattern`] renders synthetic frames on the GPU.

pub mod capture;
pub mod d3d;
pub mod nvenc;
pub mod nvenc_sys;
pub mod prio;
pub mod wgc;

pub use capture::{parse_source, probe, CaptureConfig, CaptureSession, CaptureStats, FrameSink, NvencCaps, Source};

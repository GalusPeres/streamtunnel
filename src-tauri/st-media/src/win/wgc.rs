//! Windows.Graphics.Capture of one window or monitor (docs/NATIVE-PATH.md §3.2).
//! * item from `IGraphicsCaptureItemInterop::CreateForWindow(hwnd)` / `CreateForMonitor(hmonitor)`;
//! * `Direct3D11CaptureFramePool::CreateFreeThreaded`, 2 buffers, B8G8R8A8; FrameArrived on the pool's thread;
//! * `MinUpdateInterval` = 1 / fps where available (build ≥ 26100), `IsCursorCaptureEnabled(cursor)`,
//!   `IsBorderRequired(false)` where available, `IncludeSecondaryWindows(true)` for windows;
//! * `ContentSize` changes → `Recreate` the pool; `Closed` → [`WgcCapture::closed`].
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::win::d3d::Gpu;

/// What to capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureItem {
    /// HWND
    Window(isize),
    /// HMONITOR
    Monitor(isize),
}

/// One captured frame. The texture is WGC's own surface: copy it before the handler returns (WGC recycles it).
pub struct WgcFrame {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// [`crate::clock::now_us`] at FrameArrived
    pub arrived_us: u64,
}

pub type FrameHandler = Box<dyn FnMut(WgcFrame) + Send>;

/// A running capture; dropping it stops the session and closes the pool.
pub struct WgcCapture {
    // filled by WIN
}

impl WgcCapture {
    /// `GraphicsCaptureSession::IsSupported()`.
    pub fn supported() -> bool {
        todo!("WIN")
    }

    /// Starts capturing `item` on `gpu`; `on_frame` runs on the frame pool's thread.
    pub fn start(gpu: &Gpu, item: CaptureItem, cursor: bool, min_interval_us: u64, on_frame: FrameHandler) -> Result<WgcCapture, String> {
        todo!("WIN")
    }

    /// Current content size of the item (pixels).
    pub fn content_size(&self) -> (u32, u32) {
        todo!("WIN")
    }

    /// The window was closed (or the monitor disconnected): the share's source is gone.
    pub fn closed(&self) -> bool {
        todo!("WIN")
    }

    /// Window minimized: WGC delivers nothing (the session keeps re-sending its last frame).
    pub fn minimized(&self) -> bool {
        todo!("WIN")
    }

    pub fn stop(&mut self) {
        todo!("WIN")
    }
}

/// One attached monitor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonitorInfo {
    /// HMONITOR
    pub handle: isize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// Every attached monitor (EnumDisplayMonitors order).
pub fn monitors() -> Vec<MonitorInfo> {
    todo!("WIN")
}

/// HMONITOR for Chromium's "screen:<id>:0" (the mapping is not documented):
/// 1. `id` itself if it is a valid HMONITOR; 2. the monitor at index `id` in [`monitors`] order; 3. the only
/// monitor; 4. the only monitor of `hint_w × hint_h` (the track's size). Anything else → Err("ambiguous"), and the
/// app keeps the WebRTC path for this share.
pub fn resolve_screen(id: i64, hint_w: u32, hint_h: u32) -> Result<isize, String> {
    todo!("WIN")
}

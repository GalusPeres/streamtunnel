//! Windows.Graphics.Capture of one window or monitor (docs/NATIVE-PATH.md §3.2).
//! * item from `IGraphicsCaptureItemInterop::CreateForWindow(hwnd)` / `CreateForMonitor(hmonitor)`;
//! * `Direct3D11CaptureFramePool::CreateFreeThreaded`, 2 buffers, B8G8R8A8; FrameArrived on the pool's thread;
//! * `MinUpdateInterval` = 4 ms where available (build ≥ 26100: every composition; the capture session picks the
//!   frames for its fps), `IsCursorCaptureEnabled(cursor)`,
//!   `IsBorderRequired(false)` where available, `IncludeSecondaryWindows(true)` for windows. Each of these lives
//!   on a newer session interface: a Windows without it simply keeps the default (the cast fails, logged once);
//! * `ContentSize` changes → `Recreate` the pool; `Closed` → [`WgcCapture::closed`].
//!
//! Screen ids: Chromium (WebView2) names a monitor "screen:<id>:0" with `id` = the display-device index of
//! `EnumDisplayDevicesW` (libwebrtc `GetScreenList` / `GetHmonitorFromDeviceIndex`); [`resolve_screen`] maps it
//! the same way and accepts an HMONITOR too.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::core::{factory, IInspectable, Interface, PCWSTR};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, EnumDisplaySettingsExW, GetMonitorInfoW, MonitorFromRect, DEVMODEW, DISPLAY_DEVICEW,
    DISPLAY_DEVICE_ACTIVE, ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_FLAGS, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, MONITORINFOF_PRIMARY};

use crate::win::d3d::{texture_size, Gpu};

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

/// Buffers in the frame pool (one being copied, one being filled).
const POOL_BUFFERS: i32 = 2;
const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;

/// The WinRT device wrapper is agile (free-threaded, as every WinRT Direct3D object): the frame pool thread may use it.
struct Agile(IDirect3DDevice);
unsafe impl Send for Agile {}

impl Agile {
    // a method, so closures capture the wrapper and not just its (non-Send) field
    fn get(&self) -> &IDirect3DDevice {
        &self.0
    }
}

struct State {
    closed: AtomicBool,
    /// content size of the newest frame (the pool's size after a Recreate)
    size: Mutex<(u32, u32)>,
}

/// A running capture; dropping it stops the session and closes the pool.
pub struct WgcCapture {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    window: Option<isize>,
    state: Arc<State>,
    frame_token: i64,
    closed_token: i64,
    stopped: bool,
}

impl WgcCapture {
    /// `GraphicsCaptureSession::IsSupported()`.
    pub fn supported() -> bool {
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }

    /// Starts capturing `item` on `gpu`; `on_frame` runs on the frame pool's thread.
    pub fn start(gpu: &Gpu, item: CaptureItem, cursor: bool, min_interval_us: u64, on_frame: FrameHandler) -> Result<WgcCapture, String> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| format!("capture interop: {e}"))?;
        let (capture_item, window): (GraphicsCaptureItem, _) = match item {
            CaptureItem::Window(hwnd) => {
                let h = HWND(hwnd as *mut c_void);
                if !unsafe { IsWindow(Some(h)) }.as_bool() {
                    return Err(format!("window {hwnd} does not exist"));
                }
                (unsafe { interop.CreateForWindow(h) }.map_err(|e| format!("CreateForWindow: {e}"))?, Some(hwnd))
            }
            CaptureItem::Monitor(hmon) => {
                (unsafe { interop.CreateForMonitor(HMONITOR(hmon as *mut c_void)) }.map_err(|e| format!("CreateForMonitor: {e}"))?, None)
            }
        };
        let size = capture_item.Size().map_err(|e| format!("capture item size: {e}"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, PIXEL_FORMAT, POOL_BUFFERS, size)
            .map_err(|e| format!("CreateFreeThreaded: {e}"))?;
        let session = pool.CreateCaptureSession(&capture_item).map_err(|e| format!("CreateCaptureSession: {e}"))?;

        // best effort: each setting needs a newer Windows build
        let optional = |what: &str, r: windows::core::Result<()>| {
            if let Err(e) = r {
                eprintln!("[native] capture: {what} not available ({e})");
            }
        };
        optional("cursor capture", session.SetIsCursorCaptureEnabled(cursor));
        optional("borderless capture", session.SetIsBorderRequired(false));
        if min_interval_us > 0 {
            optional("MinUpdateInterval", session.SetMinUpdateInterval(TimeSpan { Duration: (min_interval_us * 10) as i64 }));
        }
        if window.is_some() {
            optional("secondary windows", session.SetIncludeSecondaryWindows(true));
        }

        let state = Arc::new(State { closed: AtomicBool::new(false), size: Mutex::new((size.Width as u32, size.Height as u32)) });
        let handler = Mutex::new(on_frame);
        let device = Agile(gpu.winrt.clone());
        let st = state.clone();
        let frame_token = pool
            .FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
                let pool = pool.ok()?;
                let frame = pool.TryGetNextFrame()?;
                let arrived_us = crate::clock::now_us();
                let content = frame.ContentSize()?;
                let texture: ID3D11Texture2D = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>().and_then(|a| unsafe { a.GetInterface() })?;
                // the surface keeps the pool's size until the Recreate below: only its valid part is the picture
                let (tw, th) = texture_size(&texture);
                let (cw, ch) = (content.Width.max(1) as u32, content.Height.max(1) as u32);
                if let Ok(mut on_frame) = handler.lock() {
                    on_frame(WgcFrame { texture, width: cw.min(tw), height: ch.min(th), arrived_us });
                }
                let _ = frame.Close();
                let resized = {
                    let mut size = st.size.lock().unwrap_or_else(|e| e.into_inner());
                    let changed = *size != (cw, ch);
                    *size = (cw, ch);
                    changed
                };
                if resized {
                    pool.Recreate(device.get(), PIXEL_FORMAT, POOL_BUFFERS, SizeInt32 { Width: cw as i32, Height: ch as i32 })?;
                }
                Ok(())
            }))
            .map_err(|e| format!("FrameArrived: {e}"))?;
        let st = state.clone();
        let closed_token = capture_item
            .Closed(&TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                st.closed.store(true, Ordering::Relaxed);
                Ok(())
            }))
            .map_err(|e| format!("Closed: {e}"))?;
        session.StartCapture().map_err(|e| format!("StartCapture: {e}"))?;
        Ok(WgcCapture { item: capture_item, pool, session, window, state, frame_token, closed_token, stopped: false })
    }

    /// Current content size of the item (pixels).
    pub fn content_size(&self) -> (u32, u32) {
        *self.state.size.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// WGC delivers at most one frame per `us` (where the Windows build has it).
    pub fn set_min_interval(&self, us: u64) {
        if us > 0 {
            let _ = self.session.SetMinUpdateInterval(TimeSpan { Duration: (us * 10) as i64 });
        }
    }

    /// The window was closed (or the monitor disconnected): the share's source is gone.
    pub fn closed(&self) -> bool {
        self.state.closed.load(Ordering::Relaxed) || self.window.is_some_and(|h| !unsafe { IsWindow(Some(HWND(h as *mut c_void))) }.as_bool())
    }

    /// Window minimized: WGC delivers nothing (the session keeps re-sending its last frame).
    pub fn minimized(&self) -> bool {
        self.window.is_some_and(|h| unsafe { IsIconic(HWND(h as *mut c_void)) }.as_bool())
    }

    pub fn stop(&mut self) {
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        let _ = self.pool.RemoveFrameArrived(self.frame_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

impl Drop for WgcCapture {
    fn drop(&mut self) {
        self.stop();
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
    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<MonitorInfo>) };
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let r = info.rcMonitor;
            list.push(MonitorInfo {
                handle: monitor.0 as isize,
                x: r.left,
                y: r.top,
                width: (r.right - r.left).max(0) as u32,
                height: (r.bottom - r.top).max(0) as u32,
                primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        true.into()
    }
    let mut list: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut Vec<MonitorInfo> as isize));
    }
    list
}

/// The monitor of display device `index` (`EnumDisplayDevicesW` order), as libwebrtc's
/// `GetHmonitorFromDeviceIndex` finds it: the device's current mode rectangle → `MonitorFromRect`.
fn monitor_of_device(index: u32) -> Option<isize> {
    unsafe {
        let mut dev = DISPLAY_DEVICEW { cb: size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        if !EnumDisplayDevicesW(PCWSTR::null(), index, &mut dev, 0).as_bool() || dev.StateFlags.0 & DISPLAY_DEVICE_ACTIVE.0 == 0 {
            return None;
        }
        let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
        if !EnumDisplaySettingsExW(PCWSTR(dev.DeviceName.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode, ENUM_DISPLAY_SETTINGS_FLAGS(0)).as_bool() {
            return None;
        }
        let pos = mode.Anonymous1.Anonymous2.dmPosition;
        if mode.dmPelsWidth == 0 || mode.dmPelsHeight == 0 {
            return None;
        }
        let rect = RECT { left: pos.x, top: pos.y, right: pos.x + mode.dmPelsWidth as i32, bottom: pos.y + mode.dmPelsHeight as i32 };
        let m = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
        if m.is_invalid() { None } else { Some(m.0 as isize) }
    }
}

/// Same aspect ratio within 2 % (the track may be scaled down, never reshaped).
fn same_aspect(w: u32, h: u32, hint_w: u32, hint_h: u32) -> bool {
    let a = w as f64 * hint_h as f64;
    let b = hint_w as f64 * h as f64;
    (a - b).abs() <= 0.02 * a.max(b)
}

/// HMONITOR for Chromium's "screen:<id>:0":
/// 1. `id` itself if it is an attached HMONITOR;
/// 2. the monitor of display device `id` (`EnumDisplayDevicesW` index — Chromium's own screen ids on Windows);
/// 3. the only monitor;
/// 4. the only monitor of `hint_w × hint_h` (the track's size).
///
/// Every answer must have the track's aspect ratio (when the hint is known), so a wrong guess never shares another
/// monitor than the one picked. Anything else (including "-1" = all screens) → Err, and the app keeps the WebRTC
/// path for this share. (The contract's "index in EnumDisplayMonitors order" is not used: that order is not
/// Chromium's and could pick the wrong monitor.)
pub fn resolve_screen(id: i64, hint_w: u32, hint_h: u32) -> Result<isize, String> {
    resolve_in(&monitors(), id, hint_w, hint_h, monitor_of_device)
}

fn resolve_in(mons: &[MonitorInfo], id: i64, hint_w: u32, hint_h: u32, device: impl Fn(u32) -> Option<isize>) -> Result<isize, String> {
    let fits = |m: &MonitorInfo| hint_w == 0 || hint_h == 0 || same_aspect(m.width, m.height, hint_w, hint_h);
    let pick = |m: &MonitorInfo| if fits(m) { Ok(m.handle) } else { Err(format!("screen {id}: monitor {}x{} does not match the track {hint_w}x{hint_h}", m.width, m.height)) };
    if id < 0 {
        return Err(format!("screen {id}: all screens"));
    }
    if let Some(m) = mons.iter().find(|m| m.handle as i64 == id) {
        return pick(m);
    }
    if let Some(m) = u32::try_from(id).ok().and_then(&device).and_then(|h| mons.iter().find(|m| m.handle == h)) {
        return pick(m);
    }
    if let [only] = mons {
        return pick(only);
    }
    let same: Vec<&MonitorInfo> = mons.iter().filter(|m| m.width == hint_w && m.height == hint_h).collect();
    if let [only] = same[..] {
        return Ok(only.handle);
    }
    Err(format!("screen {id}: ambiguous"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(handle: isize, width: u32, height: u32) -> MonitorInfo {
        MonitorInfo { handle, x: 0, y: 0, width, height, primary: false }
    }

    #[test]
    fn screen_ids() {
        let two = [mon(0x10001, 2560, 1440), mon(0x10003, 1920, 1200)];
        let devices = |i: u32| match i {
            0 => Some(0x10001),
            2 => Some(0x10003),
            _ => None,
        };
        // an HMONITOR
        assert_eq!(resolve_in(&two, 0x10003, 1920, 1200, devices), Ok(0x10003));
        // Chromium's device index (device 1 is an inactive adapter output)
        assert_eq!(resolve_in(&two, 2, 1920, 1200, devices), Ok(0x10003));
        assert_eq!(resolve_in(&two, 0, 1280, 720, devices), Ok(0x10001)); // scaled-down track
        // the mapping points at a monitor of another shape: refuse rather than share the wrong one
        assert!(resolve_in(&two, 0, 1920, 1200, devices).is_err());
        // unknown id, two monitors: only an exact size match decides
        assert_eq!(resolve_in(&two, 7, 1920, 1200, devices), Ok(0x10003));
        assert!(resolve_in(&two, 7, 1280, 720, devices).is_err());
        assert!(resolve_in(&two, -1, 2560, 1440, devices).is_err());
        // one monitor: that one
        assert_eq!(resolve_in(&two[..1], 5, 0, 0, |_| None), Ok(0x10001));
        let same = [mon(1, 1920, 1080), mon(2, 1920, 1080)];
        assert!(resolve_in(&same, 9, 1920, 1080, |_| None).is_err());
    }

    #[test]
    fn aspect() {
        assert!(same_aspect(2560, 1440, 1920, 1080));
        assert!(same_aspect(3440, 1440, 1720, 720));
        assert!(!same_aspect(1920, 1200, 1920, 1080));
    }

    /// Enumerating monitors never captures anything; on a machine without a display the list is empty.
    #[test]
    fn monitor_list_is_consistent() {
        let list = monitors();
        assert!(list.iter().filter(|m| m.primary).count() <= 1);
        for m in &list {
            assert!(m.handle != 0 && m.width > 0 && m.height > 0);
        }
    }
}
